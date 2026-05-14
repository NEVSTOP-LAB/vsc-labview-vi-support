import * as assert from 'assert';
import { resolveScriptPaths } from '../../scripts/scriptPaths';

suite('scriptPaths', () => {
  test('resolves all four script paths under prototype/scripts', () => {
    const paths = resolveScriptPaths('/tmp/ext');
    assert.strictEqual(paths.root, require('path').join('/tmp/ext', 'prototype', 'scripts'));
    assert.ok(paths.savePanelImage.endsWith('save_vi_panel_image.py'));
    assert.ok(paths.readProps.endsWith('read_vi_props.py'));
    assert.ok(paths.writeProps.endsWith('write_vi_props.py'));
  });
});
