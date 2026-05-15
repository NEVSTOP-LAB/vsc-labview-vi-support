import { formatLabVIEWDisplayName, type ResolvedLabVIEWVersion } from './labviewVersionResolver';
import type { InstalledLabVIEW } from './labviewRuntime';

export interface StatusPresentation {
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

export function buildPickDetail(
  installation: InstalledLabVIEW,
  currentVersion: ResolvedLabVIEWVersion | null,
): string {
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

export function buildQuickPickPlaceholder(
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

function hasMatchingInstallation(
  version: ResolvedLabVIEWVersion,
  installations: readonly InstalledLabVIEW[],
): boolean {
  return installations.some((installation) => (
    installation.major === version.major
    && installation.minor === version.minor
    && (!version.architecture || installation.architecture === version.architecture)
  ));
}

function buildConfiguredTooltip(
  rootDir: string,
  version: ResolvedLabVIEWVersion,
  installed: boolean,
): string {
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
