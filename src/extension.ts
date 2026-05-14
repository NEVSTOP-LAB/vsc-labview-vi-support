import * as vscode from 'vscode';

import {
  clearCacheRoot,
  ensureCacheRoot,
  shouldSyncCacheDirectory,
} from './cache/cacheDirectory';
import { ViEditorProvider } from './editor/viEditorProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(ViEditorProvider.register(context));
  await syncCacheDirectorySetting(context);

  const helloDisposable = vscode.commands.registerCommand(
    'labview-vi-support.helloWorld',
    () => {
      vscode.window.showInformationMessage('Hello from LabVIEW VI Support!');
    },
  );
  context.subscriptions.push(helloDisposable);

  const openCacheDirectoryDisposable = vscode.commands.registerCommand(
    'labview-vi-support.openCacheDirectory',
    async () => {
      const cacheRoot = ViEditorProvider.cacheRoot(context);
      await ensureCacheRoot(cacheRoot);
      await syncCacheDirectorySetting(context);
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(cacheRoot));
    },
  );
  context.subscriptions.push(openCacheDirectoryDisposable);

  const clearCacheDisposable = vscode.commands.registerCommand(
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
  );
  context.subscriptions.push(clearCacheDisposable);
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
