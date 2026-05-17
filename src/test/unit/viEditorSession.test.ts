import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ViCache } from '../../cache/viCache';
import { ViEditorSession, type ViEditorSessionDeps, type ViEditorSessionRuntime } from '../../editor/viEditorSession';
import type { PropsJsonEnvelope } from '../../scripts/propsParser';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function envelope(overrides: Partial<PropsJsonEnvelope> = {}): PropsJsonEnvelope {
  return {
    viPath: 'C:\\demo.vi',
    lvVersion: null,
    dynamicPropsLoaded: false,
    props: {},
    ...overrides,
  };
}

function createDeps(runtime: Partial<ViEditorSessionRuntime> = {}): { deps: ViEditorSessionDeps; messages: unknown[] } {
  const messages: unknown[] = [];
  const watcher = {
    onDidChange: () => ({ dispose() {} }),
    onDidCreate: () => ({ dispose() {} }),
    onDidDelete: () => ({ dispose() {} }),
    dispose() {},
  };

  return {
    deps: {
      vscode: {
        RelativePattern: class RelativePattern {
          public constructor(public readonly base: string, public readonly pattern: string) {}
        },
        Disposable: {
          from: (...disposables) => ({
            dispose: () => disposables.forEach((d) => d.dispose()),
          }),
        },
        Uri: {
          file: (p: string) => ({ fsPath: p }),
        },
        workspace: {
          createFileSystemWatcher: () => watcher,
        },
      },
      runtime: runtime as ViEditorSessionRuntime,
    },
    messages,
  };
}

function createPanel(messages: unknown[]): { webview: { postMessage(message: unknown): Promise<boolean>; asWebviewUri(uri: { fsPath: string }): { toString(): string } } } {
  return {
    webview: {
      postMessage: async (message: unknown) => {
        messages.push(message);
        return true;
      },
      asWebviewUri: (uri: { fsPath: string }) => ({
        toString: () => `webview:${uri.fsPath}`,
      }),
    },
  };
}

async function waitForIdle(session: ViEditorSession): Promise<void> {
  await (session as unknown as { _loadChain: Promise<void> })._loadChain;
}

suite('viEditorSession', () => {
  test('loadAndPush: cache hit avoids LabVIEW dynamic calls', async () => {
    const tmp = createTempDir('lv-vi-session-');
    const viPath = path.join(tmp, 'demo.vi');
    fs.writeFileSync(viPath, Buffer.from('demo'));

    const cache = new ViCache(path.join(tmp, 'cache'));
    const entry = await cache.entryForFile(viPath);
    await cache.ensureEntry(entry, viPath);

    await fs.promises.writeFile(entry.artifacts.fpImage, Buffer.from('x'));
    await fs.promises.writeFile(entry.artifacts.bdImage, Buffer.from('y'));
    await cache.writeProps(entry, {
      _cacheVersion: 1,
      vi_path: viPath,
      lv_version: null,
      dynamic_props_loaded: true,
      props: {
        Description: { ok: true, type: 'String', value: 'cached', error: null, loaded: true },
      },
    });

    let staticReads = 0;
    let dynamicReads = 0;
    let exports = 0;
    const runtime: Partial<ViEditorSessionRuntime> = {
      readStaticViProps: async (p) => {
        staticReads += 1;
        return envelope({
          viPath: p,
          dynamicPropsLoaded: true,
          props: { Description: { ok: true, type: 'String', value: 'static', error: null, loaded: true } },
        });
      },
      readViProps: async () => {
        dynamicReads += 1;
        return envelope({ dynamicPropsLoaded: true });
      },
      exportViPanelImages: async () => {
        exports += 1;
        return {};
      },
      hasReusableLabVIEWConnection: async () => {
        throw new Error('should not be called when dynamic props are already loaded');
      },
      writeViProps: async () => envelope({ dynamicPropsLoaded: true }),
    };

    const { deps, messages } = createDeps(runtime);
    const session = new ViEditorSession(
      { uri: { fsPath: viPath } } as any,
      createPanel(messages) as any,
      cache,
      {} as any,
      {},
      () => 'both',
      async () => {},
      deps,
    );

    await session.initialize();
    await waitForIdle(session);

    assert.ok(staticReads >= 1);
    assert.strictEqual(dynamicReads, 0);
    assert.strictEqual(exports, 0);

    const states = messages.filter((m) => (m as any).type === 'state') as any[];
    assert.ok(states.length >= 1);
    assert.deepStrictEqual(states[states.length - 1].loading, { fp: false, bd: false, props: false });
  });

  test('loadAndPush: cache miss triggers static+panels+dynamic pipeline', async () => {
    const tmp = createTempDir('lv-vi-session-');
    const viPath = path.join(tmp, 'demo.vi');
    fs.writeFileSync(viPath, Buffer.from('demo'));

    const cache = new ViCache(path.join(tmp, 'cache'));

    let staticReads = 0;
    let dynamicReads = 0;
    let exports = 0;
    const runtime: Partial<ViEditorSessionRuntime> = {
      readStaticViProps: async (p) => {
        staticReads += 1;
        return envelope({
          viPath: p,
          dynamicPropsLoaded: false,
          props: {
            Description: { ok: true, type: 'String', value: null, error: null, loaded: false, pending: true },
          },
        });
      },
      hasReusableLabVIEWConnection: async () => true,
      exportViPanelImages: async (_viPath, outputPaths) => {
        exports += 1;
        if (outputPaths.fp) {
          await fs.promises.mkdir(path.dirname(outputPaths.fp), { recursive: true });
          await fs.promises.writeFile(outputPaths.fp, Buffer.from('fp'));
        }
        if (outputPaths.bd) {
          await fs.promises.mkdir(path.dirname(outputPaths.bd), { recursive: true });
          await fs.promises.writeFile(outputPaths.bd, Buffer.from('bd'));
        }
        return outputPaths;
      },
      readViProps: async (p) => {
        dynamicReads += 1;
        return envelope({
          viPath: p,
          dynamicPropsLoaded: true,
          props: {
            Description: { ok: true, type: 'String', value: 'dynamic', error: null, loaded: true },
          },
        });
      },
      writeViProps: async () => envelope({ dynamicPropsLoaded: true }),
    };

    const { deps, messages } = createDeps(runtime);
    const session = new ViEditorSession(
      { uri: { fsPath: viPath } } as any,
      createPanel(messages) as any,
      cache,
      {} as any,
      {},
      () => 'both',
      async () => {},
      deps,
    );

    await session.initialize();
    await waitForIdle(session);

    assert.ok(staticReads >= 1);
    assert.strictEqual(exports, 1);
    assert.strictEqual(dynamicReads, 1);

    const states = messages.filter((m) => (m as any).type === 'state') as any[];
    assert.ok(states.some((s) => s.loading?.props === true));
    assert.strictEqual(states[states.length - 1].props.dynamicPropsLoaded, true);
  });

  test('loadDynamicProps: deduplicates repeated clicks', async () => {
    const tmp = createTempDir('lv-vi-session-');
    const viPath = path.join(tmp, 'demo.vi');
    fs.writeFileSync(viPath, Buffer.from('demo'));

    const cache = new ViCache(path.join(tmp, 'cache'));

    let dynamicReads = 0;
    const runtime: Partial<ViEditorSessionRuntime> = {
      readStaticViProps: async (p) => envelope({
        viPath: p,
        dynamicPropsLoaded: false,
        props: { Description: { ok: true, type: 'String', value: null, error: null, loaded: false, pending: true } },
      }),
      hasReusableLabVIEWConnection: async () => false,
      readViProps: async (p) => {
        dynamicReads += 1;
        await new Promise((r) => setTimeout(r, 20));
        return envelope({ viPath: p, dynamicPropsLoaded: true });
      },
      exportViPanelImages: async () => ({}),
      writeViProps: async () => envelope({ dynamicPropsLoaded: true }),
    };

    const { deps, messages } = createDeps(runtime);
    const session = new ViEditorSession(
      { uri: { fsPath: viPath } } as any,
      createPanel(messages) as any,
      cache,
      {} as any,
      {},
      () => 'both',
      async () => {},
      deps,
    );

    await session.initialize();
    await waitForIdle(session);

    void session.handleMessage({ type: 'loadDynamicProps' } as any);
    void session.handleMessage({ type: 'loadDynamicProps' } as any);
    await waitForIdle(session);

    assert.strictEqual(dynamicReads, 1);
  });

  test('scheduleExternalFileReload: debounces file watcher events', async () => {
    const tmp = createTempDir('lv-vi-session-');
    const viPath = path.join(tmp, 'demo.vi');
    fs.writeFileSync(viPath, Buffer.from('demo'));

    const cache = new ViCache(path.join(tmp, 'cache'));

    let loads = 0;
    const originalEntryForFile = cache.entryForFile.bind(cache);
    cache.entryForFile = async (p) => {
      loads += 1;
      return originalEntryForFile(p);
    };

    const runtime: Partial<ViEditorSessionRuntime> = {
      readStaticViProps: async (p) => envelope({ viPath: p }),
      hasReusableLabVIEWConnection: async () => false,
      readViProps: async (p) => envelope({ viPath: p }),
      exportViPanelImages: async () => ({}),
      writeViProps: async () => envelope(),
    };

    const { deps, messages } = createDeps(runtime);
    const session = new ViEditorSession(
      { uri: { fsPath: viPath } } as any,
      createPanel(messages) as any,
      cache,
      {} as any,
      {},
      () => 'table-only',
      async () => {},
      deps,
    );

    (session as any).scheduleExternalFileReload();
    (session as any).scheduleExternalFileReload();
    await new Promise((r) => setTimeout(r, 300));
    await waitForIdle(session);

    assert.strictEqual(loads, 1);
  });

  test('savePropsAndReload: refreshes cache entry when VI content changes', async () => {
    const tmp = createTempDir('lv-vi-session-');
    const viPath = path.join(tmp, 'demo.vi');
    fs.writeFileSync(viPath, Buffer.from('demo'));

    const cache = new ViCache(path.join(tmp, 'cache'));

    const runtime: Partial<ViEditorSessionRuntime> = {
      readStaticViProps: async (p) => envelope({ viPath: p, dynamicPropsLoaded: true }),
      hasReusableLabVIEWConnection: async () => false,
      exportViPanelImages: async () => ({}),
      readViProps: async (p) => envelope({ viPath: p, dynamicPropsLoaded: true }),
      writeViProps: async (p) => {
        await fs.promises.appendFile(p, 'changed');
        return envelope({
          viPath: p,
          dynamicPropsLoaded: true,
          saved: true,
          saveError: '',
          props: {
            Description: { ok: true, type: 'String', value: 'updated', error: null, loaded: true },
          },
        });
      },
    };

    const { deps, messages } = createDeps(runtime);
    const session = new ViEditorSession(
      { uri: { fsPath: viPath } } as any,
      createPanel(messages) as any,
      cache,
      {} as any,
      {},
      () => 'table-only',
      async () => {},
      deps,
    );

    await session.initialize();
    await waitForIdle(session);
    const before = (messages.filter((m) => (m as any).type === 'state') as any[]).slice(-1)[0]?.hash;

    await session.handleMessage({ type: 'saveProps', updates: { Description: 'x' } } as any);
    await waitForIdle(session);
    const after = (messages.filter((m) => (m as any).type === 'state') as any[]).slice(-1)[0]?.hash;

    assert.ok(before);
    assert.ok(after);
    assert.notStrictEqual(before, after);
  });
});
