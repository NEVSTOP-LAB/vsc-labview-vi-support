import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { ViCache, type CacheEntry } from '../cache/viCache';
import {
  parsePropsJson,
  type PropsJsonEnvelope,
} from '../scripts/propsParser';
import {
  PythonScriptError,
  runPythonScriptOrFail,
  type RunPythonOptions,
} from '../scripts/pythonRunner';
import { resolveScriptPaths, type ScriptPaths } from '../scripts/scriptPaths';

/**
 * LabVIEW `.vi` / `.vit` 文件的自定义编辑器。
 *
 * 主要职责：
 *   1. 计算源 VI 的 MD5，查询或新建对应的缓存条目；
 *   2. 按需调用内置 Python 原型脚本，懒加载 FP/BD 图像和属性 JSON；
 *   3. 承载 WebView UI，并处理其 postMessage 通信协议；
 *   4. 在保存时调用 `write_vi_props.py`，再重新计算 MD5 并刷新视图。
 */
export class ViEditorProvider implements vscode.CustomReadonlyEditorProvider<ViDocument> {
  public static readonly viewType = 'labview-vi-support.viEditor';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const cacheRoot = path.join(context.globalStorageUri.fsPath, 'vi-cache');
    const cache = new ViCache(cacheRoot);
    const scripts = resolveScriptPaths(context.extensionPath);
    const provider = new ViEditorProvider(context, cache, scripts);
    return vscode.window.registerCustomEditorProvider(
      ViEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cache: ViCache,
    private readonly scripts: ScriptPaths,
  ) {}

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
      this.getPythonOptions(),
    );

    webviewPanel.webview.onDidReceiveMessage((msg) => {
      void session.handleMessage(msg);
    });

    webviewPanel.onDidDispose(() => session.dispose());

    await session.initialize();
  }

  private getPythonOptions(): RunPythonOptions {
    const cfg = vscode.workspace.getConfiguration('labview-vi-support');
    const customExe = cfg.get<string>('pythonPath');
    const timeout  = cfg.get<number>('scriptTimeoutMs');
    return {
      pythonExecutable: customExe && customExe.length > 0 ? customExe : undefined,
      timeoutMs: typeof timeout === 'number' && timeout > 0 ? timeout : undefined,
    };
  }

  private renderHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview');
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.js'));
    const nonce = crypto.randomBytes(16).toString('base64');
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
      .replace(/\{\{STYLE_URI\}\}/g, styleUri.toString())
      .replace(/\{\{SCRIPT_URI\}\}/g, scriptUri.toString());
    return html;
  }
}

export class ViDocument implements vscode.CustomDocument {
  public constructor(public readonly uri: vscode.Uri) {}
  public dispose(): void { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Per-editor session (one per opened document)
// ---------------------------------------------------------------------------

interface InboundMessage {
  type: string;
  [key: string]: unknown;
}

interface OutboundState {
  type: 'state';
  viPath: string;
  hash: string;
  fpImage: string | null;
  bdImage: string | null;
  props: PropsJsonEnvelope | null;
  errors: string[];
  loading: { fp: boolean; bd: boolean; props: boolean };
}

class ViEditorSession {
  private currentEntry: CacheEntry | null = null;
  private disposed = false;

  public constructor(
    private readonly document: ViDocument,
    private readonly panel: vscode.WebviewPanel,
    private readonly cache: ViCache,
    private readonly scripts: ScriptPaths,
    private readonly pythonOptions: RunPythonOptions,
  ) {}

  public dispose(): void {
    this.disposed = true;
  }

  public async initialize(): Promise<void> {
    await this.loadAndPush();
  }

  public async handleMessage(message: InboundMessage): Promise<void> {
    if (this.disposed) {
      return;
    }
    switch (message.type) {
      case 'ready':
        await this.loadAndPush();
        break;
      case 'reload':
        await this.loadAndPush(true);
        break;
      case 'saveProps': {
        const updates = message['updates'];
        if (typeof updates !== 'object' || updates === null) {
          await this.postError('saveProps 消息载荷无效。');
          return;
        }
        await this.savePropsAndReload(updates as Record<string, unknown>);
        break;
      }
      default:
        // unknown — ignore
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Cache + script orchestration
  // -------------------------------------------------------------------------

  private async loadAndPush(forceRefresh = false): Promise<void> {
    const viPath = this.document.uri.fsPath;
    let entry: CacheEntry;
    try {
      entry = await this.cache.entryForFile(viPath);
    } catch (err) {
      await this.postError(`无法读取 VI 文件: ${(err as Error).message}`);
      return;
    }
    this.currentEntry = entry;
    await this.cache.ensureEntry(entry, viPath);

    if (forceRefresh) {
      // Wipe the on-disk artifacts but keep the directory; cheaper than
      // invalidate() since we want the same hash dir.
      for (const k of ['fpImage', 'bdImage', 'propsJson'] as const) {
        try { await fs.promises.unlink(entry.artifacts[k]); } catch { /* ignore */ }
      }
    }

    // Initial state: whatever is on disk right now.
    await this.pushState({
      fpImage: this.cache.has(entry, 'fpImage') ? entry.artifacts.fpImage : null,
      bdImage: this.cache.has(entry, 'bdImage') ? entry.artifacts.bdImage : null,
      props:   await this.readCachedProps(entry),
      errors:  [],
      loading: {
        fp: !this.cache.has(entry, 'fpImage'),
        bd: !this.cache.has(entry, 'bdImage'),
        props: !this.cache.has(entry, 'propsJson'),
      },
    });

    // Kick off any missing artifacts in parallel.
    const tasks: Promise<void>[] = [];
    if (!this.cache.has(entry, 'fpImage')) {
      tasks.push(this.exportPanel(entry, 'fp'));
    }
    if (!this.cache.has(entry, 'bdImage')) {
      tasks.push(this.exportPanel(entry, 'bd'));
    }
    if (!this.cache.has(entry, 'propsJson')) {
      tasks.push(this.fetchProps(entry));
    }
    await Promise.allSettled(tasks);

    // Final push with whatever succeeded.
    await this.pushState({
      fpImage: this.cache.has(entry, 'fpImage') ? entry.artifacts.fpImage : null,
      bdImage: this.cache.has(entry, 'bdImage') ? entry.artifacts.bdImage : null,
      props:   await this.readCachedProps(entry),
      errors:  [],
      loading: { fp: false, bd: false, props: false },
    });
  }

  private async exportPanel(entry: CacheEntry, panel: 'fp' | 'bd'): Promise<void> {
    const outPath = panel === 'fp' ? entry.artifacts.fpImage : entry.artifacts.bdImage;
    try {
      await runPythonScriptOrFail(
        this.scripts.savePanelImage,
        [
          this.document.uri.fsPath,
          '--panel', panel,
          '--output', outPath,
        ],
        this.pythonOptions,
      );
    } catch (err) {
      const detail = err instanceof PythonScriptError ? err.message : String(err);
      await this.postError(`${panel === 'fp' ? '前面板' : '程序框图'}导出失败: ${detail}`);
    }
  }

  private async fetchProps(entry: CacheEntry): Promise<void> {
    try {
      const result = await runPythonScriptOrFail(
        this.scripts.readProps,
        [this.document.uri.fsPath, '--format', 'json'],
        this.pythonOptions,
      );
      // 持久化前先校验 JSON。
      const env = parsePropsJson(result.stdout);
      await this.cache.writeProps(entry, env);
    } catch (err) {
      const detail = err instanceof PythonScriptError ? err.message : String(err);
      await this.postError(`读取属性失败: ${detail}`);
    }
  }

  private async savePropsAndReload(updates: Record<string, unknown>): Promise<void> {
    const viPath = this.document.uri.fsPath;
    const updatesJson = JSON.stringify(updates);
    let result;
    try {
      result = await runPythonScriptOrFail(
        this.scripts.writeProps,
        [viPath, '--updates', updatesJson],
        this.pythonOptions,
      );
    } catch (err) {
      const detail = err instanceof PythonScriptError ? err.message : String(err);
      await this.postError(`写入属性失败: ${detail}`);
      return;
    }

    let saveError = '';
    try {
      const env = parsePropsJson(result.stdout);
      if (env.saved === false) {
        saveError = env.saveError ?? 'SaveVI 调用失败。';
      }
      // 单个属性写入失败：
      const failures = Object.entries(env.props)
        .filter(([, p]) => !p.ok)
        .map(([name, p]) => `${name}: ${p.error ?? '未知错误'}`);
      if (failures.length > 0) {
        await this.postError('部分属性写入失败:\n' + failures.join('\n'));
      }
    } catch {
      // 容忍 stdout 解析失败 —— VI 仍然可能已经写盘成功。
    }

    if (saveError) {
      await this.postError(saveError);
    }

    // Recompute MD5 (file changed on disk) and reload.
    await this.loadAndPush(true);
  }

  // -------------------------------------------------------------------------
  // WebView I/O
  // -------------------------------------------------------------------------

  private async readCachedProps(entry: CacheEntry): Promise<PropsJsonEnvelope | null> {
    const raw = await this.cache.readProps(entry);
    if (raw === null) {
      return null;
    }
    // 通过 parsePropsJson 走一次校验，可在缓存被人为篡改、或后续 schema
    // 升级导致旧条目不再兼容时安全地返回 null。代价仅为一次 JSON 往返，
    // 而 props.json 体积很小，可以忽略不计。
    try {
      return parsePropsJson(JSON.stringify(raw));
    } catch {
      return null;
    }
  }

  private async pushState(partial: Omit<OutboundState, 'type' | 'viPath' | 'hash'>): Promise<void> {
    if (this.disposed || !this.currentEntry) {
      return;
    }
    const state: OutboundState = {
      type: 'state',
      viPath: this.document.uri.fsPath,
      hash: this.currentEntry.hash,
      fpImage: partial.fpImage ? this.toWebviewUri(partial.fpImage) : null,
      bdImage: partial.bdImage ? this.toWebviewUri(partial.bdImage) : null,
      props: partial.props,
      errors: partial.errors,
      loading: partial.loading,
    };
    await this.panel.webview.postMessage(state);
  }

  private async postError(message: string): Promise<void> {
    await this.panel.webview.postMessage({ type: 'error', message });
  }

  private toWebviewUri(absolutePath: string): string {
    return this.panel.webview.asWebviewUri(vscode.Uri.file(absolutePath)).toString();
  }
}
