import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * VI 衍生物缓存：属性与预览分别分组。
 *
 * 目录结构：
 *
 *   <root>/
 *     props/
 *       <md5-of-vi-file>/
 *         props.json
 *         meta.json     ← {"viPath": "...", "createdAt": <ms>, "hash": "..."}
 *     preview/
 *       <md5-of-normalized-vi-path>/
 *         fp.png
 *         bd.png
 *         meta.json     ← {"viPath": "...", "createdAt": <ms>, "previewKey": "...", "fpHash": "...", "bdHash": "..."}
 *
 * 属性缓存继续通过 .vi 文件字节内容的 MD5 进行内容寻址。
 * 预览缓存则按 VI 路径稳定寻址，并额外记录每张图对应的源 hash，
 * 这样属性写回导致文件 hash 变化时，可以在确认预览仍有效的前提下复用
 * 现有截图，而不会把截图和属性一起整包失效。
 *
 * 本模块为纯逻辑（不依赖 vscode）。调用方（编辑器宿主）在构造时传入
 * 缓存根目录，通常是 `context.globalStorageUri.fsPath + "/vi-cache"`。
 */

export interface CacheArtifacts {
  fpImage: string;
  bdImage: string;
  propsJson: string;
  meta: string;
  previewMeta: string;
}

export interface CacheEntry {
  /** MD5 hex digest of the source .vi file. */
  hash: string;
  /** MD5 hex digest of the normalized source .vi path. */
  previewKey: string;
  /** Absolute directory containing props artifacts. */
  dir: string;
  /** Absolute directory containing preview artifacts. */
  previewDir: string;
  /** Conventional artifact paths inside `dir` (may or may not exist yet). */
  artifacts: CacheArtifacts;
}

export interface ViCacheMeta {
  viPath: string;
  createdAt: number;
  hash: string;
}

export interface PreviewCacheMeta {
  viPath: string;
  createdAt: number;
  previewKey: string;
  fpHash: string | null;
  bdHash: string | null;
}

export class ViCache {
  public constructor(private readonly root: string) {}

  private get propsRoot(): string {
    return path.join(this.root, 'props');
  }

  private get previewRoot(): string {
    return path.join(this.root, 'preview');
  }

  /** Compute MD5 of an arbitrary file (streaming, async). */
  public static async md5OfFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5');
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  /** Synchronous variant for unit tests. */
  public static md5OfFileSync(filePath: string): string {
    const hash = crypto.createHash('md5');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
  }

  public get rootDir(): string {
    return this.root;
  }

  public static previewKeyForPath(viPath: string): string {
    const normalized = path.resolve(viPath);
    const keySource = process.platform === 'win32'
      ? normalized.toLowerCase()
      : normalized;
    return crypto.createHash('md5').update(keySource).digest('hex');
  }

  /** Build (but do not persist) a cache entry for the given hash. */
  public entryFor(hash: string, viPath: string): CacheEntry {
    const previewKey = ViCache.previewKeyForPath(viPath);
    const dir = path.join(this.propsRoot, hash);
    const previewDir = path.join(this.previewRoot, previewKey);
    return {
      hash,
      previewKey,
      dir,
      previewDir,
      artifacts: {
        fpImage:   path.join(previewDir, 'fp.png'),
        bdImage:   path.join(previewDir, 'bd.png'),
        propsJson: path.join(dir, 'props.json'),
        meta:      path.join(dir, 'meta.json'),
        previewMeta: path.join(previewDir, 'meta.json'),
      },
    };
  }

  /** Build an entry from a .vi file path (computes MD5). */
  public async entryForFile(viPath: string): Promise<CacheEntry> {
    const hash = await ViCache.md5OfFile(viPath);
    return this.entryFor(hash, viPath);
  }

  /**
   * Ensure the entry's directory exists and write its meta.json.
   *
   * Returns `{ pathChanged: true }` when an existing meta.json referenced a
   * *different* viPath for the same hash — the caller should invalidate any
   * path-dependent artifacts (e.g. props.json) in that case.
   */
  public async ensureEntry(entry: CacheEntry, viPath: string): Promise<{ pathChanged: boolean }> {
    await fs.promises.mkdir(entry.dir, { recursive: true });
    await fs.promises.mkdir(entry.previewDir, { recursive: true });
    let needsMeta = true;
    let pathChanged = false;
    try {
      const existing = await fs.promises.readFile(entry.artifacts.meta, 'utf-8');
      const parsed = JSON.parse(existing) as Partial<ViCacheMeta>;
      if (parsed && parsed.hash === entry.hash && parsed.viPath === viPath) {
        needsMeta = false;
      } else if (parsed && parsed.hash === entry.hash && parsed.viPath !== undefined && parsed.viPath !== viPath) {
        pathChanged = true;
      }
    } catch {
      // missing or unreadable — write fresh meta
    }
    if (needsMeta) {
      const meta: ViCacheMeta = {
        viPath,
        hash: entry.hash,
        createdAt: Date.now(),
      };
      await fs.promises.writeFile(
        entry.artifacts.meta,
        JSON.stringify(meta, null, 2),
        'utf-8',
      );
    }
    return { pathChanged };
  }

  /** True if the named artifact exists for this entry. */
  public has(entry: CacheEntry, kind: keyof CacheArtifacts): boolean {
    return fs.existsSync(entry.artifacts[kind]);
  }

  public async readPreviewMeta(entry: CacheEntry): Promise<PreviewCacheMeta | null> {
    try {
      const text = await fs.promises.readFile(entry.artifacts.previewMeta, 'utf-8');
      const parsed = JSON.parse(text) as Partial<PreviewCacheMeta>;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      if (typeof parsed.viPath !== 'string' || typeof parsed.previewKey !== 'string') {
        return null;
      }
      return {
        viPath: parsed.viPath,
        previewKey: parsed.previewKey,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
        fpHash: typeof parsed.fpHash === 'string' ? parsed.fpHash : null,
        bdHash: typeof parsed.bdHash === 'string' ? parsed.bdHash : null,
      };
    } catch {
      return null;
    }
  }

  public async hasFreshPreview(entry: CacheEntry, panel: 'fp' | 'bd'): Promise<boolean> {
    const artifactKind = panel === 'fp' ? 'fpImage' : 'bdImage';
    if (!this.has(entry, artifactKind)) {
      return false;
    }
    const meta = await this.readPreviewMeta(entry);
    if (!meta || meta.previewKey !== entry.previewKey) {
      return false;
    }
    const expectedHash = panel === 'fp' ? meta.fpHash : meta.bdHash;
    return expectedHash === entry.hash;
  }

  public async markPreviewArtifactsCurrent(
    entry: CacheEntry,
    viPath: string,
    panels: Array<'fp' | 'bd'>,
  ): Promise<void> {
    await fs.promises.mkdir(entry.previewDir, { recursive: true });
    const existing = await this.readPreviewMeta(entry);
    const meta: PreviewCacheMeta = {
      viPath,
      previewKey: entry.previewKey,
      createdAt: existing?.createdAt ?? Date.now(),
      fpHash: existing?.fpHash ?? null,
      bdHash: existing?.bdHash ?? null,
    };

    for (const panel of panels) {
      const artifactKind = panel === 'fp' ? 'fpImage' : 'bdImage';
      if (!this.has(entry, artifactKind)) {
        continue;
      }
      if (panel === 'fp') {
        meta.fpHash = entry.hash;
      } else {
        meta.bdHash = entry.hash;
      }
    }

    await fs.promises.writeFile(
      entry.artifacts.previewMeta,
      JSON.stringify(meta, null, 2),
      'utf-8',
    );
  }

  /** Delete the cache entry directory entirely. */
  public async invalidate(entryOrHash: CacheEntry | string): Promise<void> {
    if (typeof entryOrHash === 'string') {
      const dir = path.join(this.propsRoot, entryOrHash);
      await fs.promises.rm(dir, { recursive: true, force: true });
      return;
    }
    await fs.promises.rm(entryOrHash.dir, { recursive: true, force: true });
    await fs.promises.rm(entryOrHash.previewDir, { recursive: true, force: true });
  }

  /** Read a cached props.json as an object, or null if missing/invalid. */
  public async readProps(entry: CacheEntry): Promise<unknown | null> {
    try {
      const text = await fs.promises.readFile(entry.artifacts.propsJson, 'utf-8');
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** Persist props.json (UTF-8 JSON). */
  public async writeProps(entry: CacheEntry, value: unknown): Promise<void> {
    await fs.promises.mkdir(entry.dir, { recursive: true });
    await fs.promises.writeFile(
      entry.artifacts.propsJson,
      JSON.stringify(value, null, 2),
      'utf-8',
    );
  }
}
