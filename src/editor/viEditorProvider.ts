import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { getCacheRoot } from '../cache/cacheDirectory';
import { ViCache } from '../cache/viCache';
import type { LabVIEWRuntimeOptions } from '../scripts/labviewRuntime';
import { resolveScriptPaths, type ScriptPaths } from '../scripts/scriptPaths';
import {
  VIEW_MODE_CONFIGURATION_KEY,
  VIEW_MODE_CONFIGURATION_SECTION,
  VIEW_MODE_FULL_CONFIGURATION_KEY,
  normalizeViewMode,
  preferWorkspaceConfigurationTarget,
  type ViewMode,
} from './viewMode';
import { buildLoadingProps } from '../scripts/propMetadata';
import { renderInitialPropsTableRows } from './viWebviewHtml';
import { ViEditorSession } from './viEditorSession';

interface ViEditorProviderHooks {
  onActiveDocumentChanged?(uri: vscode.Uri | undefined): void;
}

/**
 * LabVIEW `.vi` / `.vit` 文件的自定义编辑器。
 *
 * 主要职责：
 *   1. 计算源 VI 的 MD5，查询或新建对应的缓存条目；
 *   2. 按需调用内置 VBS worker，懒加载 FP/BD 图像和属性 JSON；
 *   3. 承载 WebView UI，并处理其 postMessage 通信协议；
 *   4. 在保存时调用写属性 worker，再重新计算 MD5 并刷新视图。
 */
export class ViEditorProvider implements vscode.CustomReadonlyEditorProvider<ViDocument> {
  public static readonly viewType = 'labview-vi-support.viEditor';

  private readonly sessions = new Set<ViEditorSession>();
  private currentViewMode: ViewMode;

  public static cacheRoot(context: vscode.ExtensionContext): string {
    return getCacheRoot(context.globalStorageUri.fsPath);
  }

  public static register(
    context: vscode.ExtensionContext,
    hooks: ViEditorProviderHooks = {},
  ): vscode.Disposable {
    const cacheRoot = ViEditorProvider.cacheRoot(context);
    const cache = new ViCache(cacheRoot);
    const scripts = resolveScriptPaths(context.extensionPath);
    const provider = new ViEditorProvider(context, cache, scripts, hooks);
    const editorRegistration = vscode.window.registerCustomEditorProvider(
      ViEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
    const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(VIEW_MODE_FULL_CONFIGURATION_KEY)) {
        void provider.reloadConfiguredViewMode();
      }
    });
    return vscode.Disposable.from(editorRegistration, configWatcher);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cache: ViCache,
    private readonly scripts: ScriptPaths,
    private readonly hooks: ViEditorProviderHooks,
  ) {
    this.currentViewMode = this.readConfiguredViewMode();
  }

  public async openCustomDocument(uri: vscode.Uri): Promise<ViDocument> {
    return new ViDocument(uri);
  }

  public async resolveCustomEditor(
    document: ViDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    void token;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot, this.context.globalStorageUri],
    };
    webviewPanel.webview.html = this.renderHtml(webviewPanel.webview);

    const session = new ViEditorSession(
      document,
      webviewPanel,
      this.cache,
      this.scripts,
      this.getRuntimeOptions(),
      () => this.currentViewMode,
      async (viewMode) => this.updateConfiguredViewMode(viewMode),
    );
    this.sessions.add(session);

    webviewPanel.webview.onDidReceiveMessage((msg) => {
      void session.handleMessage(msg);
    });

    if (webviewPanel.active) {
      this.hooks.onActiveDocumentChanged?.(document.uri);
    }

    webviewPanel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        this.hooks.onActiveDocumentChanged?.(document.uri);
      }
    });

    webviewPanel.onDidDispose(() => {
      this.sessions.delete(session);
      session.dispose();
    });

    await session.initialize();
  }

  private getRuntimeOptions(): LabVIEWRuntimeOptions {
    const cfg = vscode.workspace.getConfiguration(VIEW_MODE_CONFIGURATION_SECTION);
    const timeout = cfg.get<number>('scriptTimeoutMs');
    return {
      timeoutMs: typeof timeout === 'number' && timeout > 0 ? timeout : undefined,
    };
  }

  private readConfiguredViewMode(): ViewMode {
    const config = vscode.workspace.getConfiguration(VIEW_MODE_CONFIGURATION_SECTION);
    return normalizeViewMode(config.get<string>(VIEW_MODE_CONFIGURATION_KEY));
  }

  private async reloadConfiguredViewMode(): Promise<void> {
    await this.applyConfiguredViewMode(this.readConfiguredViewMode());
  }

  private async updateConfiguredViewMode(viewMode: ViewMode): Promise<void> {
    const config = vscode.workspace.getConfiguration(VIEW_MODE_CONFIGURATION_SECTION);
    const target = preferWorkspaceConfigurationTarget(
      vscode.workspace.workspaceFile !== undefined,
      vscode.workspace.workspaceFolders?.length ?? 0,
    )
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    await config.update(VIEW_MODE_CONFIGURATION_KEY, viewMode, target);
    await this.applyConfiguredViewMode(viewMode);
  }

  private async applyConfiguredViewMode(viewMode: ViewMode): Promise<void> {
    if (this.currentViewMode === viewMode) {
      return;
    }
    this.currentViewMode = viewMode;
    await Promise.allSettled(
      [...this.sessions].map((session) => session.postViewMode(viewMode)),
    );
  }

  private renderHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview');
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.js'));
    const nonce = crypto.randomBytes(16).toString('base64');
    const initialPropsJson = JSON.stringify({
      dynamicPropsLoaded: false,
      props: buildLoadingProps(),
    })
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026');
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    const htmlPath = path.join(this.context.extensionPath, 'media', 'webview', 'editor.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');
    html = html
      .replace(/\{\{CSP\}\}/g, csp)
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{INITIAL_PROPS_JSON\}\}/g, initialPropsJson)
      .replace(/\{\{INITIAL_PROPS_ROWS\}\}/g, renderInitialPropsTableRows())
      .replace(/\{\{STYLE_URI\}\}/g, styleUri.toString())
      .replace(/\{\{SCRIPT_URI\}\}/g, scriptUri.toString());
    return html;
  }
}

export class ViDocument implements vscode.CustomDocument {
  public constructor(public readonly uri: vscode.Uri) {}
  public dispose(): void { /* no-op */ }
}
