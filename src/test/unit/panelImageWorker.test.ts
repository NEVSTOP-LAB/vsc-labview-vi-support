import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function readWorkerScript(fileName: string): string {
  const workspaceRoot = path.resolve(__dirname, '../../..');
  return fs.readFileSync(path.join(workspaceRoot, 'workers', fileName), 'utf8');
}

function getFunctionBody(scriptText: string, functionName: string): string {
  const pattern = new RegExp(`Function ${functionName}\\([\\s\\S]*?End Function`);
  const match = scriptText.match(pattern);
  assert.ok(match, `${functionName} should exist in the worker script`);
  return match[0];
}

suite('panel image workers', () => {
  for (const fileName of ['labview_session_host.vbs']) {
    test(`${fileName} falls back to GetPanelImage when HTML export misses fp image`, () => {
      const body = getFunctionBody(readWorkerScript(fileName), 'TrySaveFrontPanelImage');

      assert.ok(body.includes('EnsureHtmlExport'));
      assert.ok(body.includes('FindExportedImage(imageDir, "p.png")'));
      assert.ok(body.includes('TryCaptureFrontPanelPng(viRef, finalOutputPath, exportRoot, errorMessage)'));
      assert.ok(!body.includes('ShouldTryFrontPanelCaptureFallback()'));
    });

    test(`${fileName} normalizes front panel PNG before returning it`, () => {
      const scriptText = readWorkerScript(fileName);
      const saveBody = getFunctionBody(scriptText, 'TrySaveFrontPanelImage');
      const captureBody = getFunctionBody(scriptText, 'TryCaptureFrontPanelPng');

      assert.match(saveBody, /TryNormalizeFrontPanelPng\(sourcePath, finalOutputPath, errorMessage\)/);
      assert.match(captureBody, /TryNormalizeFrontPanelPng\(outputPath, outputPath, errorMessage\)/);
      assert.ok(scriptText.includes('Function BuildFrontPanelCropPowerShellScript()'));
    });
  }
});
