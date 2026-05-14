import * as vscode from 'vscode';

import { ViEditorProvider } from './editor/viEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(ViEditorProvider.register(context));

  const helloDisposable = vscode.commands.registerCommand(
    'labview-vi-support.helloWorld',
    () => {
      vscode.window.showInformationMessage('Hello from LabVIEW VI Support!');
    },
  );
  context.subscriptions.push(helloDisposable);
}

export function deactivate(): void {}
