import * as vscode from 'vscode';

import {
  clearCacheRoot,
  ensureCacheRoot,
  shouldSyncCacheDirectory,
} from './cache/cacheDirectory';
import { ViEditorProvider } from './editor/viEditorProvider';
import { LabVIEWVersionStatusController } from './labviewVersionStatus';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const versionStatus = new LabVIEWVersionStatusController();
  context.subscriptions.push(versionStatus);
  context.subscriptions.push(registerEditorProvider(context, versionStatus));
  await syncCacheDirectorySetting(context);
  context.subscriptions.push(...registerVersionStatusListeners(versionStatus));
  context.subscriptions.push(...registerCommands(context, versionStatus));

  await versionStatus.refresh();
}

export function deactivate(): void {}

async function syncCacheDirectorySetting(context: vscode.ExtensionContext): Promise<void> {
  const cacheRoot = ViEditorProvider.cacheRoot(context);
  const config = vscode.workspace.getConfiguration('labview-vi-support');
  const current = config.get<string>('cacheDirectory') ?? '';
  if (!shouldSyncCacheDirectory(current, cacheRoot)) {
    return;
  }
  await config.update('cacheDirectory', cacheRoot, vscode.ConfigurationTarget.Global);
}

function registerEditorProvider(
  context: vscode.ExtensionContext,
  versionStatus: LabVIEWVersionStatusController,
): vscode.Disposable {
  return ViEditorProvider.register(context, {
    onActiveDocumentChanged: (uri) => versionStatus.setActiveResource(uri),
  });
}

function registerVersionStatusListeners(
  versionStatus: LabVIEWVersionStatusController,
): vscode.Disposable[] {
  versionStatus.setActiveResource(vscode.window.activeTextEditor?.document.uri);
  return [
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      versionStatus.setActiveResource(editor?.document.uri);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void versionStatus.refresh();
    }),
  ];
}

function registerCommands(
  context: vscode.ExtensionContext,
  versionStatus: LabVIEWVersionStatusController,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      'labview-vi-support.configureLabVIEWVersion',
      async () => {
        await versionStatus.configureVersion();
      },
    ),
    vscode.commands.registerCommand(
      'labview-vi-support.helloWorld',
      () => {
        void vscode.window.showInformationMessage('Hello from LabVIEW VI Support!');
      },
    ),
    vscode.commands.registerCommand(
      'labview-vi-support.openCacheDirectory',
      async () => {
        const cacheRoot = ViEditorProvider.cacheRoot(context);
        await ensureCacheRoot(cacheRoot);
        await syncCacheDirectorySetting(context);
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(cacheRoot));
      },
    ),
    vscode.commands.registerCommand(
      'labview-vi-support.clearCache',
      async () => {
        const choice = await vscode.window.showWarningMessage(
          '确定要清理 LabVIEW VI Support 缓存吗？图像和属性缓存会在下次打开或刷新 VI 时重新生成。',
          { modal: true },
          '清理缓存',
        );
        if (choice !== '清理缓存') {
          return;
        }

        const cacheRoot = ViEditorProvider.cacheRoot(context);
        await clearCacheRoot(cacheRoot);
        await syncCacheDirectorySetting(context);

        const next = await vscode.window.showInformationMessage(
          `已清理缓存：${cacheRoot}`,
          '打开缓存目录',
        );
        if (next === '打开缓存目录') {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(cacheRoot));
        }
      },
    ),
  ];
}
