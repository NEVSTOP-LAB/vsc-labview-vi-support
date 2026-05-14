import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ViCache } from '../../cache/viCache';

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function md5OfBuffer(buf: Buffer): string {
  return crypto.createHash('md5').update(buf).digest('hex');
}

suite('ViCache', () => {
  let root: string;
  let tmpFile: string;

  setup(() => {
    root = mkTmpDir('vi-cache-test-root-');
    const tmpDir = mkTmpDir('vi-cache-test-vi-');
    tmpFile = path.join(tmpDir, 'sample.vi');
    fs.writeFileSync(tmpFile, Buffer.from([0x52, 0x53, 0x52, 0x43, 1, 2, 3, 4, 5, 6]));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  });

  test('md5OfFile (async) and md5OfFileSync agree with reference digest', async () => {
    const buf = fs.readFileSync(tmpFile);
    const ref = md5OfBuffer(buf);
    assert.strictEqual(await ViCache.md5OfFile(tmpFile), ref);
    assert.strictEqual(ViCache.md5OfFileSync(tmpFile), ref);
  });

  test('entryFor builds the conventional layout under root/<hash>/', () => {
    const cache = new ViCache(root);
    const e = cache.entryFor('abcdef');
    assert.strictEqual(e.dir, path.join(root, 'abcdef'));
    assert.ok(e.artifacts.fpImage.endsWith(path.join('abcdef', 'fp.png')));
    assert.ok(e.artifacts.bdImage.endsWith(path.join('abcdef', 'bd.png')));
    assert.ok(e.artifacts.propsJson.endsWith(path.join('abcdef', 'props.json')));
    assert.ok(e.artifacts.meta.endsWith(path.join('abcdef', 'meta.json')));
  });

  test('ensureEntry creates the directory and writes meta.json once', async () => {
    const cache = new ViCache(root);
    const e = await cache.entryForFile(tmpFile);
    const r1 = await cache.ensureEntry(e, tmpFile);
    assert.strictEqual(r1.pathChanged, false);
    assert.ok(fs.existsSync(e.artifacts.meta));
    const meta = JSON.parse(fs.readFileSync(e.artifacts.meta, 'utf-8'));
    assert.strictEqual(meta.viPath, tmpFile);
    assert.strictEqual(meta.hash, e.hash);
    assert.strictEqual(typeof meta.createdAt, 'number');
    const t1 = meta.createdAt;

    await new Promise((r) => setTimeout(r, 5));
    const r2 = await cache.ensureEntry(e, tmpFile);
    assert.strictEqual(r2.pathChanged, false);
    const meta2 = JSON.parse(fs.readFileSync(e.artifacts.meta, 'utf-8'));
    assert.strictEqual(meta2.createdAt, t1, 'meta.json should not be rewritten when up-to-date');
  });

  test('ensureEntry rewrites meta and reports pathChanged when the stored viPath changes', async () => {
    const cache = new ViCache(root);
    const e = await cache.entryForFile(tmpFile);
    await cache.ensureEntry(e, tmpFile);
    const t1 = JSON.parse(fs.readFileSync(e.artifacts.meta, 'utf-8')).createdAt;
    await new Promise((r) => setTimeout(r, 5));
    const r = await cache.ensureEntry(e, tmpFile + '-renamed');
    assert.strictEqual(r.pathChanged, true, 'pathChanged should be true when viPath differs');
    const meta = JSON.parse(fs.readFileSync(e.artifacts.meta, 'utf-8'));
    assert.strictEqual(meta.viPath, tmpFile + '-renamed');
    assert.notStrictEqual(meta.createdAt, t1);
  });

  test('has() reflects on-disk artifact presence', async () => {
    const cache = new ViCache(root);
    const e = await cache.entryForFile(tmpFile);
    await cache.ensureEntry(e, tmpFile);
    assert.strictEqual(cache.has(e, 'fpImage'), false);
    fs.writeFileSync(e.artifacts.fpImage, Buffer.from([0]));
    assert.strictEqual(cache.has(e, 'fpImage'), true);
  });

  test('readProps / writeProps roundtrip JSON', async () => {
    const cache = new ViCache(root);
    const e = await cache.entryForFile(tmpFile);
    await cache.ensureEntry(e, tmpFile);
    assert.strictEqual(await cache.readProps(e), null);
    const payload = { vi_path: tmpFile, props: { Description: { ok: true, value: 'hi' } } };
    await cache.writeProps(e, payload);
    assert.deepStrictEqual(await cache.readProps(e), payload);
  });

  test('invalidate removes the entry directory', async () => {
    const cache = new ViCache(root);
    const e = await cache.entryForFile(tmpFile);
    await cache.ensureEntry(e, tmpFile);
    assert.ok(fs.existsSync(e.dir));
    await cache.invalidate(e.hash);
    assert.strictEqual(fs.existsSync(e.dir), false);
  });

  test('different .vi contents yield different hashes', async () => {
    const cache = new ViCache(root);
    const e1 = await cache.entryForFile(tmpFile);
    fs.appendFileSync(tmpFile, Buffer.from([42]));
    const e2 = await cache.entryForFile(tmpFile);
    assert.notStrictEqual(e1.hash, e2.hash);
  });
});
