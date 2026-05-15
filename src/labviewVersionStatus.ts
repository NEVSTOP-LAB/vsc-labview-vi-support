import * as path from 'path';
import * as vscode from 'vscode';

import {
  clearDirectoryLabVIEWMarkers,
  formatLabVIEWDisplayName,
  resolveDirectoryLabVIEWVersion,
  resolveLabVIEWVersionForPath,
  writeDirectoryLabVIEWMarker,
} from './scripts/labviewVersionResolver';
import type { ResolvedLabVIEWVersion } from './scripts/labviewVersionResolver';
import {
  discoverInstalledLabVIEWs,
  readViSavedVersion,
  type InstalledLabVIEW,
} from './scripts/labviewRuntime';
import {
  buildQuickPickInstallations,
  buildQuickPickPlaceholder,
  buildStatusPresentation,
} from './scripts/labviewStatusPresentation';

export { buildStatusPresentation } from './scripts/labviewStatusPresentation';

type VersionQuickPickItem =
  | (vscode.QuickPickItem & { action: 'select'; installation: InstalledLabVIEW })
  | (vscode.QuickPickItem & { action: 'clear' });

export class LabVIEWVersionStatusController implements vscode.Disposable {
  private readonly statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private activeResource: vscode.Uri | undefined;
  private refreshSerial = 0;
  private discoveryError: string | null = null;

  public constructor() {
    this.statusBarItem.command = 'labview-vi-support.configureLabVIEWVersion';
    this.statusBarItem.show();
  }

  public dispose(): void {
    this.statusBarItem.dispose();
  }

  public setActiveResource(resource: vscode.Uri | undefined): void {
    this.activeResource = resource?.scheme === 'file' ? resource : undefined;
    void this.refresh();
  }

  public async refresh(): Promise<void> {
    const serial = ++this.refreshSerial;
    const scope = this.getCurrentScope();
    if (!scope) {
      this.statusBarItem.text = '$(tools) LabVIEW: 配置';
      this.statusBarItem.tooltip = '打开工作区或文件后，可在这里配置根目录 LabVIEW 版本标记。';
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.show();
      return;
    }

    let projectVersion: ResolvedLabVIEWVersion | null = null;
    let activeViVersion: ResolvedLabVIEWVersion | null = null;
    let installations: InstalledLabVIEW[] = [];
    const [projectVersionResult, activeViVersionResult, installationsResult] = await Promise.allSettled([
      resolveDirectoryLabVIEWVersion(scope.rootDir),
      this.resolveActiveViVersion(scope),
      discoverInstalledLabVIEWs(),
    ]);
    if (projectVersionResult.status === 'fulfilled') {
      projectVersion = projectVersionResult.value;
    }
    if (activeViVersionResult.status === 'fulfilled') {
      activeViVersion = activeViVersionResult.value;
    }
    if (installationsResult.status === 'fulfilled') {
      installations = installationsResult.value;
      this.discoveryError = null;
    } else {
      this.discoveryError = installationsResult.reason instanceof Error
        ? installationsResult.reason.message
        : String(installationsResult.reason);
    }

    if (serial !== this.refreshSerial) {
      return;
    }

    if (this.discoveryError) {
      this.statusBarItem.text = '$(warning) LabVIEW: 安装探测失败';
      this.statusBarItem.tooltip = [
        `根目录: ${scope.rootDir}`,
        this.discoveryError,
        '点击可重新触发版本扫描。',
      ].join('\n');
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusBarItem.show();
      return;
    }

    const presentation = buildStatusPresentation({
      rootDir: scope.rootDir,
      projectVersion,
      activeViVersion,
      installations,
    });
    if (presentation.warning) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }
    this.statusBarItem.text = presentation.text;
    this.statusBarItem.tooltip = presentation.tooltip;
    this.statusBarItem.show();
  }

  public async configureVersion(): Promise<void> {
    const scope = this.getCurrentScope();
    if (!scope) {
      void vscode.window.showWarningMessage('请先打开一个工作区或至少一个本地文件。');
      return;
    }

    const [rootVersion, activeViVersion, installations] = await Promise.all([
      resolveDirectoryLabVIEWVersion(scope.rootDir),
      this.resolveActiveViVersion(scope),
      discoverInstalledLabVIEWs({ refresh: true }),
    ]);
    this.discoveryError = null;

    if (installations.length === 0) {
      const choice = await vscode.window.showWarningMessage(
        [
          '当前没有检测到可用的 LabVIEW 安装信息。',
          '如果你确认本机已安装 LabVIEW，请检查注册表中的安装路径是否完整；也可以先手动创建 DEV ENVIRONMENT 标记文件，静态识别仍会生效。',
        ].join(' '),
        '清除目录标记',
      );
      if (choice === '清除目录标记') {
        await clearDirectoryLabVIEWMarkers(scope.rootDir);
        await this.refresh();
      }
      return;
    }

    const items: VersionQuickPickItem[] = buildQuickPickInstallations(
      installations,
      rootVersion,
      activeViVersion,
    ).map(({ installation, detail }) => ({
      label: formatLabVIEWDisplayName(installation, installation.architecture),
      description: installation.installDir,
      detail,
      action: 'select',
      installation,
    }));
    items.push({
      label: '清除目录标记',
      description: '移除根目录中的 DEV ENVIRONMENT LabVIEW* 标记文件。',
      action: 'clear',
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: buildQuickPickPlaceholder(scope.rootDir, rootVersion, installations.length, activeViVersion),
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!selected) {
      return;
    }

    if (selected.action === 'clear') {
      await clearDirectoryLabVIEWMarkers(scope.rootDir);
      void vscode.window.showInformationMessage(`已清除根目录 LabVIEW 标记：${scope.rootDir}`);
      await this.refresh();
      return;
    }

    const markerPath = await writeDirectoryLabVIEWMarker(
      scope.rootDir,
      selected.installation,
      selected.installation.architecture,
    );
    void vscode.window.showInformationMessage(`已更新 LabVIEW 标记：${markerPath}`);
    await this.refresh();
  }

  private getCurrentScope(): { rootDir: string; resourcePath?: string } | null {
    const resource = this.activeResource ?? vscode.window.activeTextEditor?.document.uri;
    if (resource?.scheme === 'file') {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(resource);
      return {
        rootDir: workspaceFolder?.uri.fsPath ?? path.dirname(resource.fsPath),
        resourcePath: resource.fsPath,
      };
    }

    const firstWorkspace = vscode.workspace.workspaceFolders?.[0];
    if (!firstWorkspace) {
      return null;
    }
    return { rootDir: firstWorkspace.uri.fsPath };
  }

  private async resolveActiveViVersion(scope: { rootDir: string; resourcePath?: string }): Promise<ResolvedLabVIEWVersion | null> {
    if (!scope.resourcePath || !/\.(vi|vit)$/i.test(scope.resourcePath)) {
      return null;
    }
    const fileVersion = await resolveLabVIEWVersionForPath(scope.resourcePath, readViSavedVersion);
    if (fileVersion?.source === 'vi') {
      return fileVersion;
    }
    return null;
  }
}
