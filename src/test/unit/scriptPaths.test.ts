import * as assert from 'assert';
import * as path from 'path';
import { resolveScriptPaths } from '../../scripts/scriptPaths';

suite('scriptPaths', () => {
  test('resolves all worker script paths under workers', () => {
    const paths = resolveScriptPaths('/tmp/ext');
    assert.strictEqual(paths.root, path.join('/tmp/ext', 'workers'));
    assert.ok(paths.savePanelImageWorker.endsWith('save_vi_panel_image_worker.vbs'));
    assert.ok(paths.readPropsWorker.endsWith('read_vi_props_worker.vbs'));
    assert.ok(paths.writePropsWorker.endsWith('write_vi_props_worker.vbs'));
  });
});
