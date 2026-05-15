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

    const [rootVersion, installations] = await Promise.all([
      resolveDirectoryLabVIEWVersion(scope.rootDir),
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
      placeHolder: buildQuickPickPlaceholder(scope.rootDir, rootVersion, installations.length),
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

interface StatusPresentation {
  text: string;
  tooltip: string;
  warning: boolean;
}

export function buildStatusPresentation(options: {
  rootDir: string;
  projectVersion: ResolvedLabVIEWVersion | null;
  activeViVersion: ResolvedLabVIEWVersion | null;
  installations: readonly InstalledLabVIEW[];
}): StatusPresentation {
  const { rootDir, projectVersion, activeViVersion, installations } = options;
  if (projectVersion) {
    const installed = hasMatchingInstallation(projectVersion, installations);
    return {
      text: `${installed ? '$(tools)' : '$(warning)'} LabVIEW: ${formatLabVIEWDisplayName(projectVersion, projectVersion.architecture)}`,
      tooltip: buildConfiguredTooltip(rootDir, projectVersion, installed),
      warning: !installed,
    };
  }

  if (installations.length > 1) {
    return {
      text: '$(question) LabVIEW: 多版本可用，项目未设置',
      tooltip: buildUnsetTooltip(rootDir, installations, activeViVersion),
      warning: false,
    };
  }

  if (installations.length === 1) {
    return {
      text: '$(question) LabVIEW: 项目未设置',
      tooltip: buildUnsetTooltip(rootDir, installations, activeViVersion),
      warning: false,
    };
  }

  return {
    text: '$(warning) LabVIEW: 未检测到可用安装',
    tooltip: [
      `根目录: ${rootDir}`,
      '当前项目未设置目录标记或 lvproj 版本，且没有检测到可用的本机 LabVIEW 安装。',
      '点击可重新扫描安装版本，或先手动维护 DEV ENVIRONMENT 标记文件。',
    ].join('\n'),
    warning: true,
  };
}

function hasMatchingInstallation(version: ResolvedLabVIEWVersion, installations: readonly InstalledLabVIEW[]): boolean {
  return installations.some((installation) => (
    installation.major === version.major
    && installation.minor === version.minor
    && (!version.architecture || installation.architecture === version.architecture)
  ));
}

function buildConfiguredTooltip(rootDir: string, version: ResolvedLabVIEWVersion, installed: boolean): string {
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

function buildUnsetTooltip(
  rootDir: string,
  installations: readonly InstalledLabVIEW[],
  activeViVersion: ResolvedLabVIEWVersion | null,
): string {
  const lines = [
    `根目录: ${rootDir}`,
    '当前项目还没有目录标记，也没有可用于项目级判定的 lvproj 版本。',
  ];
  if (activeViVersion) {
    lines.push(`当前活动 VI 保存版本: ${formatLabVIEWDisplayName(activeViVersion, activeViVersion.architecture)}`);
  }
  lines.push(`本机已检测到 ${installations.length} 个可用 LabVIEW 安装：`);
  for (const installation of installations.slice(0, 6)) {
    lines.push(`- ${formatLabVIEWDisplayName(installation, installation.architecture)} | ${installation.installDir}`);
  }
  if (installations.length > 6) {
    lines.push(`- 其余 ${installations.length - 6} 个版本请点击后在列表中查看`);
  }
  lines.push('点击可为当前项目选择一个版本并写入根目录标记。');
  return lines.join('\n');
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

function buildQuickPickPlaceholder(
  rootDir: string,
  currentVersion: ResolvedLabVIEWVersion | null,
  installationCount: number,
): string {
  if (!currentVersion) {
    return installationCount > 1
      ? `检测到多个 LabVIEW 版本，请为根目录 ${rootDir} 选择一个项目版本`
      : `为根目录 ${rootDir} 选择当前可用的 LabVIEW 版本`;
  }
  return `根目录当前解析为 ${formatLabVIEWDisplayName(currentVersion, currentVersion.architecture)}，选择后会写入 DEV ENVIRONMENT 标记`;
}
