import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(
    'labview-vi-support.helloWorld',
    () => {
      vscode.window.showInformationMessage('Hello from LabVIEW VI Support!');
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate(): void {}
