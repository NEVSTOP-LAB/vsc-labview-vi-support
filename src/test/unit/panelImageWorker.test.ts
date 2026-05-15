import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function readWorkerScript(fileName: string): string {
  const workspaceRoot = path.resolve(__dirname, '../../..');
  return fs.readFileSync(path.join(workspaceRoot, 'workers', fileName), 'utf8');
}

function getTrySaveFrontPanelImageBody(scriptText: string): string {
  const match = scriptText.match(/Function TrySaveFrontPanelImage\([\s\S]*?End Function/);
  assert.ok(match, 'TrySaveFrontPanelImage should exist in the worker script');
  return match[0];
}

suite('panel image workers', () => {
  for (const fileName of ['labview_session_host.vbs', 'save_vi_panel_image_worker.vbs']) {
    test(`${fileName} exports the front panel via HTML export only`, () => {
      const body = getTrySaveFrontPanelImageBody(readWorkerScript(fileName));

      assert.ok(body.includes('EnsureHtmlExport'));
      assert.ok(body.includes('FindExportedImage(imageDir, "p.png")'));
      assert.ok(!body.includes('TryCaptureFrontPanelPng'));
      assert.ok(!body.includes('GetPanelImage failed'));
    });
  }
});