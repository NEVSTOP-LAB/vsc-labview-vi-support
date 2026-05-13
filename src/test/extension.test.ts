import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Extension should be present', async () => {
    const ext = vscode.extensions.getExtension('NEVSTOP-LAB.labview-vi-support');
    assert.ok(ext, 'Extension NEVSTOP-LAB.labview-vi-support should be installed');
  });

  test('Sample test', () => {
    assert.strictEqual(-1, [1, 2, 3].indexOf(5));
    assert.strictEqual(-1, [1, 2, 3].indexOf(0));
  });
});
