import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * MD5-keyed cache for VI artifacts (FP/BD images and properties JSON).
 *
 * Layout:
 *
 *   <root>/
 *     <md5-of-vi-file>/
 *       fp.png
 *       bd.png
 *       props.json
 *       meta.json     ← {"viPath": "...", "createdAt": <ms>}
 *
 * The cache is content-addressed by MD5 of the .vi file bytes. After a
 * successful write-back to the .vi file, the host computes a new MD5 and
 * looks up (or creates) a fresh cache entry. The previous entry is
 * intentionally left on disk so re-opening a still-cached version is fast.
 *
 * Pure logic — no vscode imports. The caller (the editor provider) supplies
 * the cache root, normally `context.globalStorageUri.fsPath + "/vi-cache"`.
 */

export interface CacheArtifacts {
  fpImage: string;
  bdImage: string;
  propsJson: string;
  meta: string;
}

export interface CacheEntry {
  /** MD5 hex digest of the source .vi file. */
  hash: string;
  /** Absolute directory containing the artifacts. */
  dir: string;
  /** Conventional artifact paths inside `dir` (may or may not exist yet). */
  artifacts: CacheArtifacts;
}

export interface ViCacheMeta {
  viPath: string;
  createdAt: number;
  hash: string;
}

export class ViCache {
  public constructor(private readonly root: string) {}

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

  /** Build (but do not persist) a cache entry for the given hash. */
  public entryFor(hash: string): CacheEntry {
    const dir = path.join(this.root, hash);
    return {
      hash,
      dir,
      artifacts: {
        fpImage:   path.join(dir, 'fp.png'),
        bdImage:   path.join(dir, 'bd.png'),
        propsJson: path.join(dir, 'props.json'),
        meta:      path.join(dir, 'meta.json'),
      },
    };
  }

  /** Build an entry from a .vi file path (computes MD5). */
  public async entryForFile(viPath: string): Promise<CacheEntry> {
    const hash = await ViCache.md5OfFile(viPath);
    return this.entryFor(hash);
  }

  /** Ensure the entry's directory exists and write its meta.json. */
  public async ensureEntry(entry: CacheEntry, viPath: string): Promise<void> {
    await fs.promises.mkdir(entry.dir, { recursive: true });
    let needsMeta = true;
    try {
      const existing = await fs.promises.readFile(entry.artifacts.meta, 'utf-8');
      const parsed = JSON.parse(existing) as Partial<ViCacheMeta>;
      if (parsed && parsed.hash === entry.hash && parsed.viPath === viPath) {
        needsMeta = false;
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
  }

  /** True if the named artifact exists for this entry. */
  public has(entry: CacheEntry, kind: keyof CacheArtifacts): boolean {
    return fs.existsSync(entry.artifacts[kind]);
  }

  /** Delete the cache entry directory entirely. */
  public async invalidate(hash: string): Promise<void> {
    const dir = path.join(this.root, hash);
    await fs.promises.rm(dir, { recursive: true, force: true });
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
