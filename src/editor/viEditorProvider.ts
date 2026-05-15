import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { getCacheRoot } from '../cache/cacheDirectory';
import { ViCache, type CacheEntry } from '../cache/viCache';
import {
  exportViPanelImages,
  type LabVIEWRuntimeOptions,
  readStaticViProps,
  readViProps,
  writeViProps,
} from '../scripts/labviewRuntime';
import {
  mergeUpdatedPropsIntoEnvelope,
  mergeStaticPropsIntoEnvelope,
  parseCachedPropsJson,
  toCachedPropsJson,
  type PropsJsonEnvelope,
} from '../scripts/propsParser';
import { resolveScriptPaths, type ScriptPaths } from '../scripts/scriptPaths';
import {
  VIEW_MODE_CONFIGURATION_KEY,
  VIEW_MODE_CONFIGURATION_SECTION,
  VIEW_MODE_FULL_CONFIGURATION_KEY,
  isViewMode,
  normalizeViewMode,
  preferWorkspaceConfigurationTarget,
  type ViewMode,
} from './viewMode';

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
  viewMode: ViewMode;
  fpImage: string | null;
  bdImage: string | null;
  props: PropsJsonEnvelope | null;
  errors: string[];
  loading: { fp: boolean; bd: boolean; props: boolean };
}

class ViEditorSession {
  private currentEntry: CacheEntry | null = null;
  private disposed = false;
  /** 保证任意时刻只有一个 loadAndPush 在运行（防止 initialize + ready 并发触发）。 */
  private _loadChain: Promise<void> = Promise.resolve();
  /** 链尾是否已有待执行的非强制刷新任务（用于跳过重复的 ready 触发）。 */
  private _loadPending = false;
  /** 动态属性读取是否已入队（避免用户重复点击触发多次 LabVIEW 调用）。 */
  private _dynamicPropsPending = false;

  public constructor(
    private readonly document: ViDocument,
    private readonly panel: vscode.WebviewPanel,
    private readonly cache: ViCache,
    private readonly scripts: ScriptPaths,
    private readonly runtimeOptions: LabVIEWRuntimeOptions,
    private readonly getViewMode: () => ViewMode,
    private readonly onViewModeChange: (viewMode: ViewMode) => Promise<void>,
  ) {}

  public dispose(): void {
    this.disposed = true;
  }

  public async initialize(): Promise<void> {
    this._enqueueLoad();
  }

  public async handleMessage(message: InboundMessage): Promise<void> {
    if (this.disposed) {
      return;
    }
    switch (message.type) {
      case 'ready':
        // initialize() 已将初始加载入队；若任务仍待执行则跳过，避免重复触发。
        this._enqueueLoad();
        break;
      case 'reload':
        this._enqueueLoad(true);
        break;
      case 'loadDynamicProps':
        this._enqueueDynamicPropsLoad();
        break;
      case 'setViewMode': {
        const viewMode = message['viewMode'];
        if (!isViewMode(viewMode)) {
          await this.postError('setViewMode 消息载荷无效。');
          return;
        }
        await this.onViewModeChange(viewMode);
        break;
      }
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

  /**
   * 将一次 loadAndPush 加入串行执行链。
   * - 若 forceRefresh=false 且链尾已有待执行任务，则跳过（防止 initialize + ready 重复触发）。
   * - forceRefresh=true（来自 reload 消息）始终入队，确保用户手动刷新总能执行。
   */
  private _enqueueLoad(forceRefresh = false): void {
    if (this._loadPending && !forceRefresh) {
      return;
    }
    this._loadPending = true;
    this._loadChain = this._loadChain
      .then(async () => {
        this._loadPending = false;
        if (!this.disposed) {
          await this.loadAndPush(forceRefresh);
        }
      })
      .catch(() => {
        this._loadPending = false;
      });
  }

  private _enqueueDynamicPropsLoad(forceRefresh = false): void {
    if (this._dynamicPropsPending && !forceRefresh) {
      return;
    }
    this._dynamicPropsPending = true;
    this._loadChain = this._loadChain
      .then(async () => {
        // Keep _dynamicPropsPending = true while the LabVIEW call is in flight
        // so that repeated button clicks during the round-trip are deduplicated.
        // Reset only after loadDynamicProps settles (success or error).
        try {
          if (!this.disposed) {
            await this.loadDynamicProps(forceRefresh);
          }
        } finally {
          this._dynamicPropsPending = false;
        }
      })
      .catch(() => { /* loadDynamicProps errors are handled above; chain must not reject */ });
  }

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
    const { pathChanged } = await this.cache.ensureEntry(entry, viPath);

    let cachedProps = await this.readCachedProps(entry);
    if (cachedProps === null && this.cache.has(entry, 'propsJson')) {
      try { await fs.promises.unlink(entry.artifacts.propsJson); } catch { /* 文件不存在则忽略 */ }
    }

    if (pathChanged && cachedProps !== null) {
      // 相同内容但不同路径：只刷新静态字段，保留同 hash 的动态属性缓存。
      try {
        cachedProps = await this.ensureStaticProps(entry, cachedProps);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await this.postError(`刷新静态属性失败: ${detail}`);
        return;
      }
    }

    const refreshDynamicProps = forceRefresh && this.isDynamicPropsLoaded(cachedProps);

    if (forceRefresh) {
      for (const k of ['fpImage', 'bdImage'] as const) {
        try { await fs.promises.unlink(entry.artifacts[k]); } catch { /* ignore */ }
      }
      if (cachedProps === null || refreshDynamicProps) {
        try { await fs.promises.unlink(entry.artifacts.propsJson); } catch { /* ignore */ }
        cachedProps = null;
      }
    }

    if (cachedProps === null) {
      try {
        cachedProps = await this.ensureStaticProps(entry);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await this.postError(`读取静态属性失败: ${detail}`);
        return;
      }
    }

    const initialLoading = this.buildLoadingState(entry, refreshDynamicProps);

    // Initial state: whatever is on disk right now.
    await this.pushState({
      fpImage: this.cache.has(entry, 'fpImage') ? entry.artifacts.fpImage : null,
      bdImage: this.cache.has(entry, 'bdImage') ? entry.artifacts.bdImage : null,
      props:   cachedProps,
      errors:  [],
      loading: initialLoading,
    });

    await this.exportPanels(entry, { fp: initialLoading.fp, bd: initialLoading.bd });
    if (refreshDynamicProps) {
      const refreshed = await this.fetchProps(entry);
      if (refreshed) {
        cachedProps = refreshed;
      }
    }

    // Final push with whatever succeeded.
    await this.pushState({
      fpImage: this.cache.has(entry, 'fpImage') ? entry.artifacts.fpImage : null,
      bdImage: this.cache.has(entry, 'bdImage') ? entry.artifacts.bdImage : null,
      props:   (await this.readCachedProps(entry)) ?? cachedProps,
      errors:  [],
      loading: { fp: false, bd: false, props: false },
    });
  }

  private async loadDynamicProps(forceRefresh = false): Promise<void> {
    const entry = this.currentEntry;
    if (!entry) {
      this._enqueueLoad(forceRefresh);
      return;
    }

    let cachedProps = await this.readCachedProps(entry);
    if (cachedProps === null) {
      try {
        cachedProps = await this.ensureStaticProps(entry);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await this.postError(`读取静态属性失败: ${detail}`);
        return;
      }
    }
    if (this.isDynamicPropsLoaded(cachedProps) && !forceRefresh) {
      await this.pushState({
        fpImage: this.cache.has(entry, 'fpImage') ? entry.artifacts.fpImage : null,
        bdImage: this.cache.has(entry, 'bdImage') ? entry.artifacts.bdImage : null,
        props: cachedProps,
        errors: [],
        loading: { fp: false, bd: false, props: false },
      });
      return;
    }

    await this.pushState({
      fpImage: this.cache.has(entry, 'fpImage') ? entry.artifacts.fpImage : null,
      bdImage: this.cache.has(entry, 'bdImage') ? entry.artifacts.bdImage : null,
      props: cachedProps,
      errors: [],
      loading: { fp: false, bd: false, props: true },
    });

    const refreshed = await this.fetchProps(entry);
    await this.pushState({
      fpImage: this.cache.has(entry, 'fpImage') ? entry.artifacts.fpImage : null,
      bdImage: this.cache.has(entry, 'bdImage') ? entry.artifacts.bdImage : null,
      props: refreshed ?? (await this.readCachedProps(entry)) ?? cachedProps,
      errors: [],
      loading: { fp: false, bd: false, props: false },
    });
  }

  private async exportPanels(
    entry: CacheEntry,
    requestedPanels: { fp: boolean; bd: boolean },
  ): Promise<void> {
    if (!this.isPreviewVisible() || (!requestedPanels.fp && !requestedPanels.bd)) {
      return;
    }
    const outputPaths: Partial<Record<'fp' | 'bd', string>> = {};
    if (requestedPanels.fp) {
      outputPaths.fp = entry.artifacts.fpImage;
    }
    if (requestedPanels.bd) {
      outputPaths.bd = entry.artifacts.bdImage;
    }
    try {
      await exportViPanelImages(this.document.uri.fsPath, outputPaths, this.scripts, this.runtimeOptions);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (requestedPanels.fp && requestedPanels.bd) {
        await this.postError(`预览导出失败: ${detail}`);
      } else {
        await this.postError(`${requestedPanels.fp ? '前面板' : '程序框图'}导出失败: ${detail}`);
      }
    }
  }

  private async fetchProps(entry: CacheEntry): Promise<PropsJsonEnvelope | null> {
    try {
      const env = await readViProps(this.document.uri.fsPath, this.scripts, this.runtimeOptions);
      await this.cache.writeProps(entry, toCachedPropsJson(env));
      return env;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await this.postError(`读取属性失败: ${detail}`);
      return null;
    }
  }

  private async savePropsAndReload(updates: Record<string, unknown>): Promise<void> {
    const cachedBeforeSave = this.currentEntry
      ? await this.readCachedProps(this.currentEntry)
      : null;

    let env: PropsJsonEnvelope;
    try {
      env = await writeViProps(this.document.uri.fsPath, updates, this.scripts, this.runtimeOptions);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await this.postError(`写入属性失败: ${detail}`);
      return;
    }

    let saveError = '';
    if (env.saved === false) {
      saveError = env.saveError ?? 'SaveVI 调用失败。';
    }
    const failures = Object.entries(env.props)
      .filter(([, p]) => !p.ok)
      .map(([name, p]) => `${name}: ${p.error ?? '未知错误'}`);
    if (failures.length > 0) {
      await this.postError('部分属性写入失败:\n' + failures.join('\n'));
    }

    if (saveError) {
      await this.postError(saveError);
    }

    let entry: CacheEntry;
    try {
      entry = await this.cache.entryForFile(this.document.uri.fsPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await this.postError(`保存后刷新缓存失败: ${detail}`);
      return;
    }

    this.currentEntry = entry;
    await this.cache.ensureEntry(entry, this.document.uri.fsPath);

    let mergedEnv = env;
    let baseEnvelope = cachedBeforeSave;
    if (baseEnvelope === null) {
      try {
        baseEnvelope = await this.ensureStaticProps(entry);
      } catch {
        baseEnvelope = null;
      }
    }
    if (baseEnvelope !== null) {
      mergedEnv = mergeUpdatedPropsIntoEnvelope(baseEnvelope, env);
    }

    await this.cache.writeProps(entry, toCachedPropsJson(mergedEnv));

    const initialLoading = this.buildLoadingState(entry, false);
    await this.pushState({
      fpImage: this.cache.has(entry, 'fpImage') ? entry.artifacts.fpImage : null,
      bdImage: this.cache.has(entry, 'bdImage') ? entry.artifacts.bdImage : null,
      props: mergedEnv,
      errors: [],
      loading: initialLoading,
    });

    await this.exportPanels(entry, { fp: initialLoading.fp, bd: initialLoading.bd });

    await this.pushState({
      fpImage: this.cache.has(entry, 'fpImage') ? entry.artifacts.fpImage : null,
      bdImage: this.cache.has(entry, 'bdImage') ? entry.artifacts.bdImage : null,
      props: (await this.readCachedProps(entry)) ?? mergedEnv,
      errors: [],
      loading: { fp: false, bd: false, props: false },
    });
  }

  // -------------------------------------------------------------------------
  // WebView I/O
  // -------------------------------------------------------------------------

  public async postViewMode(viewMode: ViewMode): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.panel.webview.postMessage({ type: 'viewMode', viewMode });
    if (viewMode !== 'table-only') {
      this._enqueueLoad();
    }
  }

  private buildLoadingState(
    entry: CacheEntry,
    propsLoading: boolean,
  ): { fp: boolean; bd: boolean; props: boolean } {
    const previewVisible = this.isPreviewVisible();
    return {
      fp: previewVisible && !this.cache.has(entry, 'fpImage'),
      bd: previewVisible && !this.cache.has(entry, 'bdImage'),
      props: propsLoading,
    };
  }

  private isPreviewVisible(): boolean {
    return this.getViewMode() !== 'table-only';
  }

  private isDynamicPropsLoaded(envelope: PropsJsonEnvelope | null): boolean {
    return envelope?.dynamicPropsLoaded === true;
  }

  private async ensureStaticProps(
    entry: CacheEntry,
    existing: PropsJsonEnvelope | null = null,
  ): Promise<PropsJsonEnvelope> {
    const staticEnv = await readStaticViProps(this.document.uri.fsPath);
    const env = existing
      ? mergeStaticPropsIntoEnvelope(existing, staticEnv)
      : staticEnv;
    await this.cache.writeProps(entry, toCachedPropsJson(env));
    return env;
  }

  private async readCachedProps(entry: CacheEntry): Promise<PropsJsonEnvelope | null> {
    const raw = await this.cache.readProps(entry);
    if (raw === null) {
      return null;
    }
    // 通过 parsePropsJson 走一次校验，可在缓存被人为篡改、或后续 schema
    // 升级导致旧条目不再兼容时安全地返回 null。代价仅为一次 JSON 往返，
    // 而 props.json 体积很小，可以忽略不计。
    try {
      return parseCachedPropsJson(JSON.stringify(raw));
    } catch {
      return null;
    }
  }

  private async pushState(partial: Omit<OutboundState, 'type' | 'viPath' | 'hash' | 'viewMode'>): Promise<void> {
    if (this.disposed || !this.currentEntry) {
      return;
    }
    const state: OutboundState = {
      type: 'state',
      viPath: this.document.uri.fsPath,
      hash: this.currentEntry.hash,
      viewMode: this.getViewMode(),
      fpImage: partial.fpImage ? await this.toWebviewImageSource(partial.fpImage) : null,
      bdImage: partial.bdImage ? await this.toWebviewImageSource(partial.bdImage) : null,
      props: partial.props,
      errors: partial.errors,
      loading: partial.loading,
    };
    await this.panel.webview.postMessage(state);
  }

  private async postError(message: string): Promise<void> {
    await this.panel.webview.postMessage({ type: 'error', message });
  }

  private async toWebviewImageSource(absolutePath: string): Promise<string> {
    try {
      const content = await fs.promises.readFile(absolutePath);
      return `data:image/png;base64,${content.toString('base64')}`;
    } catch {
      return this.panel.webview.asWebviewUri(vscode.Uri.file(absolutePath)).toString();
    }
  }
}
