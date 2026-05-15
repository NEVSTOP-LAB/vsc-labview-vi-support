/**
 * 本机已安装 LabVIEW 版本探测。
 *
 * 通过 PowerShell 查询 Windows 注册表，枚举所有已安装的 LabVIEW 版本，
 * 并读取 PE 可执行文件头来确认其位宽（x86 / x64）。
 *
 * 本模块不依赖 `vscode`，可直接做单元测试。
 */

import * as fs from 'fs';
import * as path from 'path';

import { runCommand } from './workerInvoker';
import type {
  LabVIEWArchitecture,
  LabVIEWVersion,
} from '../labviewVersionResolver';

const DISCOVERY_TIMEOUT_MS = 30_000;

const PE_MACHINE_I386 = 0x014c;
const PE_MACHINE_AMD64 = 0x8664;

export interface InstalledLabVIEW extends LabVIEWVersion {
  registryKey: string;
  installDir: string;
  exePath: string;
  architecture: LabVIEWArchitecture;
}

let cachedInstallationsPromise: Promise<InstalledLabVIEW[]> | null = null;

export async function discoverInstalledLabVIEWs(options: { refresh?: boolean } = {}): Promise<InstalledLabVIEW[]> {
  if (options.refresh) {
    cachedInstallationsPromise = null;
  }
  if (cachedInstallationsPromise) {
    return cachedInstallationsPromise;
  }
  cachedInstallationsPromise = (async () => {
    const script = buildInstalledLabVIEWDiscoveryScript();

    const result = await runCommand('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], { timeoutMs: DISCOVERY_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || 'Failed to discover installed LabVIEW versions.');
    }

    const rows = normalizePowerShellJson(result.stdout);
    const seen = new Set<string>();
    const installations: InstalledLabVIEW[] = [];
    for (const row of rows) {
      const parsedVersion = parseVersionKey(row.version);
      if (!parsedVersion) {
        continue;
      }
      const installDir = path.resolve(String(row.installDir));
      const exePath = path.join(installDir, 'LabVIEW.exe');
      if (!fs.existsSync(exePath)) {
        continue;
      }
      const architecture = await readPeArchitecture(exePath) ?? inferArchitectureFromInstallDir(installDir);
      // Keep custom-path installs discoverable even when PE machine is unknown and directory heuristics do not apply.
      const normalizedArchitecture = architecture ?? inferArchitectureFromHost();
      if (!normalizedArchitecture) {
        continue;
      }
      const key = `${parsedVersion.major}.${parsedVersion.minor}|${normalizedArchitecture}|${exePath.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      installations.push({
        ...parsedVersion,
        registryKey: row.version,
        installDir,
        exePath,
        architecture: normalizedArchitecture,
      });
    }
    installations.sort((left, right) => (
      left.major - right.major
      || left.minor - right.minor
      || left.architecture.localeCompare(right.architecture)
      || left.installDir.localeCompare(right.installDir)
    ));
    return installations;
  })();

  return cachedInstallationsPromise;
}

export function buildInstalledLabVIEWDiscoveryScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$roots = @(',
    '  "HKLM:\\SOFTWARE\\National Instruments\\LabVIEW",',
    '  "HKLM:\\SOFTWARE\\WOW6432Node\\National Instruments\\LabVIEW"',
    ')',
    '$items = foreach ($root in $roots) {',
    '  if (Test-Path $root) {',
    '    Get-ChildItem $root | ForEach-Object {',
    '      try {',
    '        $installPath = (Get-ItemProperty -Path $_.PSPath -Name Path -ErrorAction Stop).Path',
    '        if ($installPath) { [PSCustomObject]@{ version = $_.PSChildName; installDir = $installPath } }',
    '      } catch {}',
    '    }',
    '  }',
    '}',
    '$items | ConvertTo-Json -Compress',
  ].join('\n');
}

export function selectInstalledLabVIEW(
  installations: InstalledLabVIEW[],
  targetMajor: number,
  targetMinor: number,
  targetArchitecture?: LabVIEWArchitecture,
): InstalledLabVIEW | undefined {
  const preferredBitness = targetArchitecture ?? (process.arch === 'x64' ? 'x64' : 'x86');
  return installations
    .filter((entry) => (
      entry.major === targetMajor
      && entry.minor === targetMinor
      && (!targetArchitecture || entry.architecture === targetArchitecture)
    ))
    .sort((left, right) => scoreByBitness(left.architecture, preferredBitness) - scoreByBitness(right.architecture, preferredBitness))[0];
}

function scoreByBitness(actual: string, preferred: string): number {
  return actual === preferred ? 0 : 1;
}

function normalizePowerShellJson(jsonText: string): Array<{ version: string; installDir: string }> {
  const trimmed = jsonText.trim();
  if (!trimmed) {
    return [];
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord).map((item) => ({
      version: String(item['version'] ?? ''),
      installDir: String(item['installDir'] ?? ''),
    }));
  }
  if (isRecord(parsed)) {
    return [{
      version: String(parsed['version'] ?? ''),
      installDir: String(parsed['installDir'] ?? ''),
    }];
  }
  return [];
}

function parseVersionKey(versionKey: string): LabVIEWVersion | null {
  const match = /^(\d+)\.(\d+)$/.exec(versionKey.trim());
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

async function readPeArchitecture(exePath: string): Promise<LabVIEWArchitecture | null> {
  const file = await fs.promises.open(exePath, 'r');
  try {
    const offsetBuffer = Buffer.alloc(4);
    await file.read(offsetBuffer, 0, 4, 0x3c);
    const peOffset = offsetBuffer.readUInt32LE(0);
    const signature = Buffer.alloc(6);
    await file.read(signature, 0, 6, peOffset);
    if (!signature.subarray(0, 4).equals(Buffer.from('PE\0\0'))) {
      throw new Error(`Not a valid PE executable: ${exePath}`);
    }
    const machine = signature.readUInt16LE(4);
    if (machine === PE_MACHINE_I386) {
      return 'x86';
    }
    if (machine === PE_MACHINE_AMD64) {
      return 'x64';
    }
    return null;
  } finally {
    await file.close();
  }
}

function inferArchitectureFromInstallDir(installDir: string): LabVIEWArchitecture | null {
  const normalized = installDir.replace(/\//g, '\\').toLowerCase();
  if (normalized.includes('\\program files (x86)\\')) {
    return 'x86';
  }
  if (normalized.includes('\\program files\\')) {
    return 'x64';
  }
  return null;
}

function inferArchitectureFromHost(): LabVIEWArchitecture | null {
  // Last-resort fallback: this reflects extension host bitness, not the LabVIEW EXE bitness.
  // It is only used when PE machine detection and install-directory heuristics both fail.
  // It prioritizes discoverability and may still fail later if LabVIEW bitness differs during COM activation.
  if (process.arch === 'ia32') {
    return 'x86';
  }
  if (process.arch === 'x64') {
    return 'x64';
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
