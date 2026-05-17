import * as assert from 'assert';
import * as path from 'path';
import { resolveScriptPaths } from '../../scripts/scriptPaths';

suite('scriptPaths', () => {
  test('resolves all worker script paths under workers', () => {
    const paths = resolveScriptPaths('/tmp/ext');
    assert.strictEqual(paths.root, path.join('/tmp/ext', 'workers'));
    assert.ok(paths.sessionHostWorker.endsWith('labview_session_host.vbs'));
  });
});
