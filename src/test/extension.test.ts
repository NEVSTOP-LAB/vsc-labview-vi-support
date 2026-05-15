import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  test('extension activates successfully', async () => {
    const ext = vscode.extensions.getExtension('NEVSTOP-LAB.labview-vi-support');
    assert.ok(ext, 'Extension NEVSTOP-LAB.labview-vi-support should be installed');
    await ext?.activate();
    assert.strictEqual(ext?.isActive, true);
  });

  test('core extension commands are registered after activation', async () => {
    const ext = vscode.extensions.getExtension('NEVSTOP-LAB.labview-vi-support');
    await ext?.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('labview-vi-support.configureLabVIEWVersion'));
    assert.ok(commands.includes('labview-vi-support.openCacheDirectory'));
    assert.ok(commands.includes('labview-vi-support.clearCache'));
  });
});
