/**
 * 单个 VI 编辑器会话。
 *
 * 每次 `resolveCustomEditor` 调用都会创建一个 `ViEditorSession` 实例，
 * 负责编排缓存查询、静态/动态属性加载、预览图像导出和 WebView 消息收发。
 */

import * as fs from 'fs';
import * as path from 'path';

import type { CacheEntry } from '../cache/viCache';
import { ViCache } from '../cache/viCache';
import {
  exportViPanelImages,
  hasReusableLabVIEWConnection,
  type LabVIEWRuntimeOptions,
  normalizePropsEnvelope,
  readStaticViProps,
  readViProps,
  UnsupportedPreviewExportError,
  writeViProps,
} from '../scripts/labviewRuntime';
import {
  mergeUpdatedPropsIntoEnvelope,
  mergeStaticPropsIntoEnvelope,
  parseCachedPropsJson,
  toCachedPropsJson,
  type PropsJsonEnvelope,
} from '../scripts/propsParser';
import { buildLoadingProps } from '../scripts/propMetadata';
import type { ScriptPaths } from '../scripts/scriptPaths';
import { isViewMode, type ViewMode } from './viewMode';
import type { InboundMessage, OutboundState } from './viWebviewProtocol';
import type { ViDocument } from './viEditorProvider';

export interface ViEditorSessionVscodeApi {
  RelativePattern: new (base: string, pattern: string) => unknown;
  Disposable: { from(...disposables: Array<{ dispose(): void }>): { dispose(): void } };
  Uri: { file(path: string): { fsPath: string } };
  workspace: {
    createFileSystemWatcher(pattern: unknown): {
      onDidChange(listener: () => void): { dispose(): void };
      onDidCreate(listener: () => void): { dispose(): void };
      onDidDelete(listener: () => void): { dispose(): void };
      dispose(): void;
    };
  };
}

export interface ViEditorSessionRuntime {
  exportViPanelImages: typeof exportViPanelImages;
  hasReusableLabVIEWConnection: typeof hasReusableLabVIEWConnection;
  readStaticViProps: typeof readStaticViProps;
  readViProps: typeof readViProps;
  writeViProps: typeof writeViProps;
}

export interface ViEditorSessionDeps {
  vscode: ViEditorSessionVscodeApi;
  runtime?: ViEditorSessionRuntime;
}

const defaultRuntime: ViEditorSessionRuntime = {
  exportViPanelImages,
  hasReusableLabVIEWConnection,
  readStaticViProps,
  readViProps,
  writeViProps,
};

export class ViEditorSession {
  private currentEntry: CacheEntry | null = null;
  private disposed = false;
  private previewExportDisabledReason: string | null = null;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private fileChangeTimer: NodeJS.Timeout | null = null;
  /** 保证任意时刻只有一个 loadAndPush 在运行（防止 initialize + ready 并发触发）。 */
  private _loadChain: Promise<void> = Promise.resolve();
  /** 链尾是否已有待执行的非强制刷新任务（用于跳过重复的 ready 触发）。 */
  private _loadPending = false;
  /** 动态属性读取是否已入队（避免用户重复点击触发多次 LabVIEW 调用）。 */
  private _dynamicPropsPending = false;

  public constructor(
    private readonly document: ViDocument,
    private readonly panel: {
      webview: {
        postMessage(message: unknown): Promise<boolean> | { then(onfulfilled: (value: boolean) => void): unknown };
        asWebviewUri(uri: { fsPath: string }): { toString(): string };
      };
    },
    private readonly cache: ViCache,
    private readonly scripts: ScriptPaths,
    private readonly runtimeOptions: LabVIEWRuntimeOptions,
    private readonly getViewMode: () => ViewMode,
    private readonly onViewModeChange: (viewMode: ViewMode) => Promise<void>,
    private readonly deps: ViEditorSessionDeps,
  ) {
    const filePattern = new this.deps.vscode.RelativePattern(
      path.dirname(this.document.uri.fsPath),
      path.basename(this.document.uri.fsPath),
    );
    const watcher = this.deps.vscode.workspace.createFileSystemWatcher(filePattern);
    const scheduleReload = () => this.scheduleExternalFileReload();
    this.disposables.push(
      watcher,
      watcher.onDidChange(scheduleReload),
      watcher.onDidCreate(scheduleReload),
      watcher.onDidDelete(scheduleReload),
    );
  }

  public dispose(): void {
    this.disposed = true;
    if (this.fileChangeTimer) {
      clearTimeout(this.fileChangeTimer);
      this.fileChangeTimer = null;
    }
    this.deps.vscode.Disposable.from(...this.disposables).dispose();
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

  private scheduleExternalFileReload(): void {
    if (this.disposed) {
      return;
    }
    if (this.fileChangeTimer) {
      clearTimeout(this.fileChangeTimer);
    }
    // LabVIEW 保存时可能会产生一串紧邻的文件系统事件；统一收敛到一次重载。
    this.fileChangeTimer = setTimeout(() => {
      this.fileChangeTimer = null;
      if (!this.disposed) {
        this._enqueueLoad();
      }
    }, 250);
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

    // Manual reload is an explicit user request to re-read properties, so do
    // not keep unread dynamic placeholders around.
    const refreshDynamicProps = forceRefresh;

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
      await this.pushLoadingPropsState(entry);
      try {
        cachedProps = await this.ensureStaticProps(entry);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await this.postError(`读取静态属性失败: ${detail}`);
        return;
      }
    }

    let autoLoadDynamicProps = await this.shouldAutoLoadDynamicProps(cachedProps);
    const initialLoading = this.buildLoadingState(entry, refreshDynamicProps || autoLoadDynamicProps);

    // Initial state: whatever is on disk right now.
    await this.pushState({
      fpImage: this.cache.has(entry, 'fpImage') ? entry.artifacts.fpImage : null,
      bdImage: this.cache.has(entry, 'bdImage') ? entry.artifacts.bdImage : null,
      props:   cachedProps,
      errors:  [],
      loading: initialLoading,
    });

    await this.exportPanels(entry, { fp: initialLoading.fp, bd: initialLoading.bd });
    let shouldFetchDynamicProps = refreshDynamicProps || autoLoadDynamicProps;
    if (!shouldFetchDynamicProps && !this.isDynamicPropsLoaded(cachedProps)) {
      autoLoadDynamicProps = await this.shouldAutoLoadDynamicProps(cachedProps);
      shouldFetchDynamicProps = autoLoadDynamicProps;
      if (shouldFetchDynamicProps) {
        await this.pushState({
          fpImage: this.cache.has(entry, 'fpImage') ? entry.artifacts.fpImage : null,
          bdImage: this.cache.has(entry, 'bdImage') ? entry.artifacts.bdImage : null,
          props: cachedProps,
          errors: [],
          loading: { fp: false, bd: false, props: true },
        });
      }
    }
    if (shouldFetchDynamicProps) {
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
      await this.pushLoadingPropsState(entry);
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

  private async shouldAutoLoadDynamicProps(cachedProps: PropsJsonEnvelope | null): Promise<boolean> {
    if (this.isDynamicPropsLoaded(cachedProps)) {
      return false;
    }
    return (this.deps.runtime ?? defaultRuntime).hasReusableLabVIEWConnection(this.document.uri.fsPath, this.scripts);
  }

  private async exportPanels(
    entry: CacheEntry,
    requestedPanels: { fp: boolean; bd: boolean },
  ): Promise<void> {
    if (
      this.previewExportDisabledReason
      || !this.isPreviewVisible()
      || (!requestedPanels.fp && !requestedPanels.bd)
    ) {
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
      await (this.deps.runtime ?? defaultRuntime).exportViPanelImages(
        this.document.uri.fsPath,
        outputPaths,
        this.scripts,
        this.runtimeOptions,
      );
    } catch (err) {
      if (err instanceof UnsupportedPreviewExportError) {
        this.previewExportDisabledReason = err.message;
        await this.postError(err.message);
        return;
      }
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
      const env = await (this.deps.runtime ?? defaultRuntime).readViProps(
        this.document.uri.fsPath,
        this.scripts,
        this.runtimeOptions,
      );
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
      env = await (this.deps.runtime ?? defaultRuntime).writeViProps(
        this.document.uri.fsPath,
        updates,
        this.scripts,
        this.runtimeOptions,
      );
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

  private buildLoadingPropsEnvelope(): PropsJsonEnvelope {
    return {
      viPath: this.document.uri.fsPath,
      lvVersion: null,
      dynamicPropsLoaded: false,
      props: buildLoadingProps(),
    };
  }

  private async pushLoadingPropsState(entry: CacheEntry): Promise<void> {
    await this.pushState({
      fpImage: this.cache.has(entry, 'fpImage') ? entry.artifacts.fpImage : null,
      bdImage: this.cache.has(entry, 'bdImage') ? entry.artifacts.bdImage : null,
      props: this.buildLoadingPropsEnvelope(),
      errors: [],
      loading: this.buildLoadingState(entry, true),
    });
  }

  private async ensureStaticProps(
    entry: CacheEntry,
    existing: PropsJsonEnvelope | null = null,
  ): Promise<PropsJsonEnvelope> {
    const staticEnv = await (this.deps.runtime ?? defaultRuntime).readStaticViProps(this.document.uri.fsPath);
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
    // 先做一次结构校验；只要缓存结构仍兼容，就保留已有值，
    // 再按当前元数据补齐缺失条目并回写，避免插件升级时整包失效。
    try {
      const cached = normalizePropsEnvelope(parseCachedPropsJson(JSON.stringify(raw)));
      return await this.ensureStaticProps(entry, cached);
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
      return this.panel.webview.asWebviewUri(this.deps.vscode.Uri.file(absolutePath)).toString();
    }
  }
}
