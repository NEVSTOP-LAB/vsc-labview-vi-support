import * as path from 'path';
import * as vscode from 'vscode';

import {
  clearDirectoryLabVIEWMarkers,
  formatLabVIEWDisplayName,
  resolveDirectoryLabVIEWVersion,
  resolveLabVIEWVersionForPath,
  writeDirectoryLabVIEWMarker,
  type ResolvedLabVIEWVersion,
} from './scripts/labviewVersionResolver';
import {
  discoverInstalledLabVIEWs,
  readViSavedVersion,
  type InstalledLabVIEW,
} from './scripts/labviewRuntime';

type VersionQuickPickItem =
  | (vscode.QuickPickItem & { action: 'select'; installation: InstalledLabVIEW })
  | (vscode.QuickPickItem & { action: 'clear' });

export class LabVIEWVersionStatusController implements vscode.Disposable {
  private readonly statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private activeResource: vscode.Uri | undefined;
  private refreshSerial = 0;

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

    const [resolvedVersion, installations] = await Promise.all([
      this.resolveDisplayedVersion(scope),
      discoverInstalledLabVIEWs(),
    ]);

    if (serial !== this.refreshSerial) {
      return;
    }

    const installed = resolvedVersion ? hasMatchingInstallation(resolvedVersion, installations) : false;
    if (resolvedVersion) {
      this.statusBarItem.text = `${installed ? '$(tools)' : '$(warning)'} LabVIEW: ${formatLabVIEWDisplayName(resolvedVersion, resolvedVersion.architecture)}`;
      this.statusBarItem.tooltip = buildTooltip(scope.rootDir, resolvedVersion, installed);
      this.statusBarItem.backgroundColor = installed
        ? undefined
        : new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBarItem.text = '$(question) LabVIEW: 未检测';
      this.statusBarItem.tooltip = [
        `根目录: ${scope.rootDir}`,
        '当前未检测到目录标记、lvproj 版本或 VI 文件头版本。',
        '点击可写入根目录版本标记。',
      ].join('\n');
      this.statusBarItem.backgroundColor = undefined;
    }
    this.statusBarItem.show();
  }

  public async configureVersion(): Promise<void> {
    const scope = this.getCurrentScope();
    if (!scope) {
      void vscode.window.showWarningMessage('请先打开一个工作区或至少一个本地文件。');
      return;
    }

    const [rootVersion, installations] = await Promise.all([
      resolveDirectoryLabVIEWVersion(scope.rootDir),
      discoverInstalledLabVIEWs({ refresh: true }),
    ]);

    if (installations.length === 0) {
      const choice = await vscode.window.showWarningMessage(
        [
          '本机未检测到已安装的 LabVIEW。',
          '目录标记仍可用于静态识别，但图像导出、属性读取和属性写入不会再误用其他版本；当不存在匹配安装时，这些动态操作会严格失败。',
        ].join(' '),
        '清除目录标记',
      );
      if (choice === '清除目录标记') {
        await clearDirectoryLabVIEWMarkers(scope.rootDir);
        await this.refresh();
      }
      return;
    }

    const items: VersionQuickPickItem[] = installations.map((installation) => ({
      label: formatLabVIEWDisplayName(installation, installation.architecture),
      description: installation.installDir,
      detail: buildPickDetail(installation, rootVersion),
      action: 'select',
      installation,
    }));
    items.push({
      label: '清除目录标记',
      description: '移除根目录中的 DEV ENVIRONMENT LabVIEW* 标记文件。',
      action: 'clear',
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: buildQuickPickPlaceholder(scope.rootDir, rootVersion),
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

  private async resolveDisplayedVersion(scope: { rootDir: string; resourcePath?: string }): Promise<ResolvedLabVIEWVersion | null> {
    if (scope.resourcePath && /\.(vi|vit)$/i.test(scope.resourcePath)) {
      return resolveLabVIEWVersionForPath(scope.resourcePath, readViSavedVersion);
    }
    if (scope.resourcePath) {
      return resolveDirectoryLabVIEWVersion(path.dirname(scope.resourcePath));
    }
    return resolveDirectoryLabVIEWVersion(scope.rootDir);
  }
}

function hasMatchingInstallation(version: ResolvedLabVIEWVersion, installations: readonly InstalledLabVIEW[]): boolean {
  return installations.some((installation) => (
    installation.major === version.major
    && installation.minor === version.minor
    && (!version.architecture || installation.architecture === version.architecture)
  ));
}

function buildTooltip(rootDir: string, version: ResolvedLabVIEWVersion, installed: boolean): string {
  const sourceLabel = version.source === 'directory-marker'
    ? '目录标记'
    : version.source === 'lvproj'
      ? 'lvproj'
      : 'VI 文件头';

  return [
    `根目录: ${rootDir}`,
    `解析结果: ${formatLabVIEWDisplayName(version, version.architecture)}`,
    `来源: ${sourceLabel}`,
    `来源文件: ${version.sourcePath}`,
    `本机安装: ${installed ? '已找到匹配版本' : '未找到匹配版本'}`,
    '点击可配置根目录 LabVIEW 版本标记。',
  ].join('\n');
}

function buildPickDetail(installation: InstalledLabVIEW, currentVersion: ResolvedLabVIEWVersion | null): string {
  if (
    currentVersion
    && installation.major === currentVersion.major
    && installation.minor === currentVersion.minor
    && installation.architecture === (currentVersion.architecture ?? installation.architecture)
  ) {
    return '当前根目录已解析到该版本。';
  }
  return `注册表版本键: ${installation.registryKey}`;
}

function buildQuickPickPlaceholder(rootDir: string, currentVersion: ResolvedLabVIEWVersion | null): string {
  if (!currentVersion) {
    return `为根目录 ${rootDir} 选择一个已安装的 LabVIEW 版本`;
  }
  return `根目录当前解析为 ${formatLabVIEWDisplayName(currentVersion, currentVersion.architecture)}，选择后会写入 DEV ENVIRONMENT 标记`;
}