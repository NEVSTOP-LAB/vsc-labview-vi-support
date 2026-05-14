import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  clearCacheRoot,
  ensureCacheRoot,
  getCacheRoot,
  shouldSyncCacheDirectory,
} from '../../cache/cacheDirectory';

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

suite('cacheDirectory', () => {
  test('getCacheRoot appends vi-cache under the storage root', () => {
    assert.strictEqual(
      getCacheRoot(path.join('C:', 'Users', 'tester', 'storage')),
      path.join('C:', 'Users', 'tester', 'storage', 'vi-cache'),
    );
  });

  test('shouldSyncCacheDirectory only updates when the value changes', () => {
    assert.strictEqual(shouldSyncCacheDirectory('', 'C:\\cache'), true);
    assert.strictEqual(shouldSyncCacheDirectory(undefined, 'C:\\cache'), true);
    assert.strictEqual(shouldSyncCacheDirectory('C:\\cache', 'C:\\cache'), false);
  });

  test('ensureCacheRoot creates the directory when it is missing', async () => {
    const parent = mkTmpDir('cache-dir-parent-');
    const cacheRoot = path.join(parent, 'nested', 'vi-cache');

    try {
      await ensureCacheRoot(cacheRoot);
      assert.strictEqual(fs.existsSync(cacheRoot), true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test('clearCacheRoot removes stale contents and recreates an empty cache root', async () => {
    const parent = mkTmpDir('cache-dir-clear-');
    const cacheRoot = path.join(parent, 'vi-cache');
    const staleFile = path.join(cacheRoot, 'deadbeef', 'props.json');

    try {
      fs.mkdirSync(path.dirname(staleFile), { recursive: true });
      fs.writeFileSync(staleFile, '{"stale":true}', 'utf-8');

      await clearCacheRoot(cacheRoot);

      assert.strictEqual(fs.existsSync(cacheRoot), true);
      assert.strictEqual(fs.existsSync(staleFile), false);
      assert.deepStrictEqual(fs.readdirSync(cacheRoot), []);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});