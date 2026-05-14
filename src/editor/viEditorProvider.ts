import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { ViCache, type CacheEntry } from '../cache/viCache';
import {
  parsePropsJson,
  type PropsJsonEnvelope,
  type PropEntry,
} from '../scripts/propsParser';
import {
  PythonScriptError,
  runPythonScriptOrFail,
  type RunPythonOptions,
} from '../scripts/pythonRunner';
import { resolveScriptPaths, type ScriptPaths } from '../scripts/scriptPaths';

/**
 * Custom editor for LabVIEW `.vi` and `.vit` files.
 *
 * Responsibilities:
 *   1. Compute MD5 of the source VI; lookup or create a cache entry.
 *   2. Lazily invoke the prototype Python scripts to materialize FP/BD images
 *      and a props JSON if the cache is missing them.
 *   3. Host the WebView UI and handle its postMessage protocol.
 *   4. On save, invoke `write_vi_props.py`, then re-cache and reload.
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
          await this.postError('Invalid saveProps payload.');
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
      await this.postError(`Failed to read VI file: ${(err as Error).message}`);
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
      await this.postError(`${panel.toUpperCase()} export failed: ${detail}`);
    }
  }

  private async fetchProps(entry: CacheEntry): Promise<void> {
    try {
      const result = await runPythonScriptOrFail(
        this.scripts.readProps,
        [this.document.uri.fsPath, '--format', 'json'],
        this.pythonOptions,
      );
      // Validate JSON before persisting.
      const env = parsePropsJson(result.stdout);
      await this.cache.writeProps(entry, env);
    } catch (err) {
      const detail = err instanceof PythonScriptError ? err.message : String(err);
      await this.postError(`Read properties failed: ${detail}`);
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
      await this.postError(`Write properties failed: ${detail}`);
      return;
    }

    let saveError = '';
    try {
      const env = parsePropsJson(result.stdout);
      if (env.saved === false) {
        saveError = env.saveError ?? 'SaveVI reported failure.';
      }
      // Per-property errors:
      const failures = Object.entries(env.props)
        .filter(([, p]) => !(p as PropEntry).ok)
        .map(([name, p]) => `${name}: ${(p as PropEntry).error ?? 'unknown'}`);
      if (failures.length > 0) {
        await this.postError('Some properties failed to write:\n' + failures.join('\n'));
      }
    } catch {
      // tolerate malformed stdout — the VI is still saved.
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
