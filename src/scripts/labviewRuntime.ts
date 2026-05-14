import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type SpawnOptions } from 'child_process';

import {
  parsePropsResponseText,
  type PropsJsonEnvelope,
  type PropsResponse,
} from './propsParser';
import { decorateProps, WRITABLE_PROP_TYPES } from './propMetadata';
import type { ScriptPaths } from './scriptPaths';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_WORKER_TIMEOUT_SECONDS = 45;
const VI_VERSION_SCAN_BYTES = 512;
const VI_VERSION_MARKER = Buffer.from([0x00, 0x00, 0x00, 0xa0]);
const PE_MACHINE_I386 = 0x014c;
const PE_MACHINE_AMD64 = 0x8664;

export interface LabVIEWRuntimeOptions {
  timeoutMs?: number;
}

interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
}

interface LabVIEWVersion {
  major: number;
  minor: number;
}

interface InstalledLabVIEW extends LabVIEWVersion {
  registryKey: string;
  installDir: string;
  exePath: string;
  architecture: string;
}

interface ImageWorkerResponse {
  ok: boolean;
  selection: string;
  reason: string;
  connectedVersion: string;
  connectedDirectory: string;
  attempts: number;
  outputPath: string;
}

export function parseViSavedVersionHeader(header: Buffer): LabVIEWVersion | null {
  if (!header.subarray(0, 4).equals(Buffer.from('RSRC'))) {
    return null;
  }
  for (let index = 0; index <= header.length - VI_VERSION_MARKER.length - 2; index += 1) {
    if (!header.subarray(index, index + VI_VERSION_MARKER.length).equals(VI_VERSION_MARKER)) {
      continue;
    }
    const major = bcdByteToInt(header[index + VI_VERSION_MARKER.length]);
    const minor = bcdByteToInt(header[index + VI_VERSION_MARKER.length + 1]);
    if (major === null || minor === null || major <= 0) {
      continue;
    }
    return { major, minor };
  }
  return null;
}

export async function readViSavedVersion(viPath: string): Promise<LabVIEWVersion | null> {
  const file = await fs.promises.open(viPath, 'r');
  try {
    const header = Buffer.alloc(VI_VERSION_SCAN_BYTES);
    const { bytesRead } = await file.read(header, 0, VI_VERSION_SCAN_BYTES, 0);
    return parseViSavedVersionHeader(header.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

export function buildWriteRequestLines(updates: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [propName, raw] of Object.entries(updates)) {
    const propType = WRITABLE_PROP_TYPES[propName];
    if (!propType) {
      throw new Error(`Property is not writable or unknown: ${propName}`);
    }
    const input = isRecord(raw) && 'value' in raw ? raw.value : raw;
    const normalized = normalizeWritableValue(propName, propType, input);
    const encoded = Buffer.from(normalized, 'utf8').toString('base64');
    lines.push(`set_${propName}_type=${propType}`);
    lines.push(`set_${propName}_val=${encoded}`);
  }
  return lines;
}

export async function exportViPanelImage(
  viPath: string,
  panel: 'fp' | 'bd',
  outputPath: string,
  scripts: ScriptPaths,
  options: LabVIEWRuntimeOptions = {},
): Promise<string> {
  ensureWindows();
  const absViPath = path.resolve(viPath);
  const absOutputPath = path.resolve(outputPath);
  const installation = await resolveTargetInstallation(absViPath);
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const responseText = await runWorkerWithResponse({
        scriptHost: selectScriptHost(installation?.architecture),
        scriptPath: scripts.savePanelImageWorker,
        args: [
          `/viPath:${absViPath}`,
          `/panel:${panel}`,
          `/outputPath:${absOutputPath}`,
          ...buildTargetArgs(installation),
        ],
        timeoutMs: options.timeoutMs,
      });
      const response = parseImageWorkerResponseText(responseText);
      if (response.ok) {
        return response.outputPath || absOutputPath;
      }
      lastError = new Error(response.reason || `Image export worker failed for panel=${panel}.`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < 2) {
      await delay(250 * (attempt + 1));
    }
  }

  throw lastError ?? new Error(`Image export worker failed for panel=${panel}.`);
}

export async function readViProps(
  viPath: string,
  scripts: ScriptPaths,
  options: LabVIEWRuntimeOptions = {},
): Promise<PropsJsonEnvelope> {
  ensureWindows();
  const absViPath = path.resolve(viPath);
  const installation = await resolveTargetInstallation(absViPath);
  const responseText = await runWorkerWithResponse({
    scriptHost: selectScriptHost(installation?.architecture),
    scriptPath: scripts.readPropsWorker,
    args: [
      `/viPath:${absViPath}`,
      ...buildTargetArgs(installation),
    ],
    timeoutMs: options.timeoutMs,
  });
  const response = parsePropsResponseText(responseText);
  if (!response.ok) {
    throw new Error(response.reason || 'Read props worker failed.');
  }
  return toPropsEnvelope(absViPath, response);
}

export async function writeViProps(
  viPath: string,
  updates: Record<string, unknown>,
  scripts: ScriptPaths,
  options: LabVIEWRuntimeOptions = {},
): Promise<PropsJsonEnvelope> {
  ensureWindows();
  const absViPath = path.resolve(viPath);
  const installation = await resolveTargetInstallation(absViPath);
  const requestPath = path.join(
    os.tmpdir(),
    `labview-vi-write-${Math.random().toString(16).slice(2)}.in`,
  );
  try {
    const requestBody = buildWriteRequestLines(updates).join('\r\n') + '\r\n';
    await fs.promises.writeFile(requestPath, requestBody, 'ascii');

    const responseText = await runWorkerWithResponse({
      scriptHost: selectScriptHost(installation?.architecture),
      scriptPath: scripts.writePropsWorker,
      args: [
        `/viPath:${absViPath}`,
        `/requestPath:${requestPath}`,
        '/save:1',
        ...buildTargetArgs(installation),
      ],
      timeoutMs: options.timeoutMs,
    });
    const response = parsePropsResponseText(responseText);
    if (!response.ok) {
      throw new Error(response.reason || 'Write props worker failed.');
    }
    return toPropsEnvelope(absViPath, response, { includeUnavailable: true });
  } finally {
    try {
      await fs.promises.unlink(requestPath);
    } catch {
      // ignore
    }
  }
}

function ensureWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('LabVIEW COM automation is only supported on Windows.');
  }
}

function bcdByteToInt(value: number): number | null {
  const high = value >> 4;
  const low = value & 0x0f;
  if (high > 9 || low > 9) {
    return null;
  }
  return high * 10 + low;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeWritableValue(
  propName: string,
  propType: 'String' | 'Boolean' | 'Number',
  value: unknown,
): string {
  if (propType === 'String') {
    return value === null || value === undefined ? '' : String(value);
  }
  if (propType === 'Boolean') {
    if (typeof value === 'boolean') {
      return value ? '1' : '0';
    }
    if (typeof value === 'number') {
      return value ? '1' : '0';
    }
    const text = String(value ?? '').trim().toLowerCase();
    if (['1', 'true', 'yes', '-1'].includes(text)) {
      return '1';
    }
    if (['0', 'false', 'no', ''].includes(text)) {
      return '0';
    }
    throw new Error(`Invalid boolean value for ${propName}: ${String(value)}`);
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'number') {
    return String(Math.trunc(value));
  }
  const text = String(value ?? '').trim();
  const head = text ? text.split(/\s+/)[0] : '';
  if (/^-?\d+$/.test(head)) {
    return head;
  }
  throw new Error(`Invalid number value for ${propName}: ${String(value)}`);
}

let cachedInstallationsPromise: Promise<InstalledLabVIEW[]> | null = null;

async function resolveTargetInstallation(viPath: string): Promise<InstalledLabVIEW | undefined> {
  const savedVersion = await readViSavedVersion(viPath);
  if (!savedVersion) {
    return undefined;
  }
  const installations = await discoverInstalledLabVIEWs();
  return selectInstalledLabVIEW(installations, savedVersion.major, savedVersion.minor);
}

async function discoverInstalledLabVIEWs(): Promise<InstalledLabVIEW[]> {
  if (cachedInstallationsPromise) {
    return cachedInstallationsPromise;
  }
  cachedInstallationsPromise = (async () => {
    const script = [
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
    ].join('; ');

    const result = await runCommand('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], { timeoutMs: 30_000 });

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
      const architecture = await readPeArchitecture(exePath);
      const key = `${parsedVersion.major}.${parsedVersion.minor}|${architecture}|${exePath.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      installations.push({
        ...parsedVersion,
        registryKey: row.version,
        installDir,
        exePath,
        architecture,
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

function normalizePowerShellJson(jsonText: string): Array<{ version: string; installDir: string }> {
  const trimmed = jsonText.trim();
  if (!trimmed) {
    return [];
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord).map((item) => ({
      version: String(item.version ?? ''),
      installDir: String(item.installDir ?? ''),
    }));
  }
  if (isRecord(parsed)) {
    return [{
      version: String(parsed.version ?? ''),
      installDir: String(parsed.installDir ?? ''),
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

async function readPeArchitecture(exePath: string): Promise<string> {
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
    return `unknown(0x${machine.toString(16).padStart(4, '0').toUpperCase()})`;
  } finally {
    await file.close();
  }
}

function selectInstalledLabVIEW(
  installations: InstalledLabVIEW[],
  targetMajor: number,
  targetMinor: number,
): InstalledLabVIEW | undefined {
  const defaultBitness = process.arch === 'x64' ? 'x64' : 'x86';
  const exact = installations
    .filter((entry) => entry.major === targetMajor && entry.minor === targetMinor)
    .sort((left, right) => scoreByBitness(left.architecture, defaultBitness) - scoreByBitness(right.architecture, defaultBitness));
  if (exact.length > 0) {
    return exact[0];
  }

  const sameMajor = installations
    .filter((entry) => entry.major === targetMajor)
    .sort((left, right) => (
      Math.abs(left.minor - targetMinor) - Math.abs(right.minor - targetMinor)
      || scoreByBitness(left.architecture, defaultBitness) - scoreByBitness(right.architecture, defaultBitness)
    ));
  return sameMajor[0];
}

function scoreByBitness(actual: string, preferred: string): number {
  return actual === preferred ? 0 : 1;
}

function buildTargetArgs(installation: InstalledLabVIEW | undefined): string[] {
  if (!installation) {
    return [];
  }
  return [
    `/targetExe:${installation.exePath}`,
    `/expectedDirectory:${installation.installDir}`,
  ];
}

function selectScriptHost(architecture: string | undefined): string {
  const windir = process.env.WINDIR || 'C:\\Windows';
  if (architecture === 'x86') {
    const syswow64 = path.join(windir, 'SysWOW64', 'cscript.exe');
    if (fs.existsSync(syswow64)) {
      return syswow64;
    }
  }
  return path.join(windir, 'System32', 'cscript.exe');
}

async function runWorkerWithResponse(options: {
  scriptHost: string;
  scriptPath: string;
  args: string[];
  timeoutMs?: number;
}): Promise<string> {
  const responsePath = path.join(
    os.tmpdir(),
    `labview-worker-${Math.random().toString(16).slice(2)}.out`,
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSeconds = Math.max(DEFAULT_WORKER_TIMEOUT_SECONDS, Math.ceil(timeoutMs / 1000));
  try {
    const result = await runCommand(
      options.scriptHost,
      ['//Nologo', options.scriptPath, ...options.args, `/responsePath:${responsePath}`, `/timeoutSeconds:${timeoutSeconds}`],
      { timeoutMs },
    );
    let responseText = '';
    try {
      responseText = await fs.promises.readFile(responsePath, 'ascii');
    } catch {
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `Worker failed with exit code ${result.exitCode}.`);
      }
      throw new Error('Worker did not create a response file.');
    }
    return responseText;
  } finally {
    try {
      await fs.promises.unlink(responsePath);
    } catch {
      // ignore
    }
  }
}

function parseImageWorkerResponseText(text: string): ImageWorkerResponse {
  const raw: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine || !rawLine.includes('=')) {
      continue;
    }
    const index = rawLine.indexOf('=');
    raw[rawLine.slice(0, index)] = rawLine.slice(index + 1);
  }
  return {
    ok: raw.ok === '1',
    selection: raw.selection ?? '',
    reason: decodeBase64Utf8(raw.reason_b64 ?? ''),
    connectedVersion: decodeBase64Utf8(raw.connected_version_b64 ?? ''),
    connectedDirectory: decodeBase64Utf8(raw.connected_directory_b64 ?? ''),
    attempts: parseInt(raw.attempts ?? '0', 10) || 0,
    outputPath: decodeBase64Utf8(raw.output_path_b64 ?? ''),
  };
}

function decodeBase64Utf8(value: string): string {
  if (!value) {
    return '';
  }
  return Buffer.from(value, 'base64').toString('utf8').replace(/^\ufeff/, '');
}

function formatLabVIEWVersion(version: LabVIEWVersion | null): string | null {
  if (!version) {
    return null;
  }
  return `${version.major}.${version.minor}`;
}

async function toPropsEnvelope(
  viPath: string,
  response: PropsResponse,
  options: { includeUnavailable?: boolean } = {},
): Promise<PropsJsonEnvelope> {
  const savedVersion = formatLabVIEWVersion(await readViSavedVersion(viPath));
  const envelope: PropsJsonEnvelope = {
    viPath,
    lvVersion: response.connectedVersion || null,
    props: decorateProps(response.props, {
      includeUnavailable: options.includeUnavailable,
      savedVersion,
    }),
  };
  if (typeof response.saved === 'boolean') {
    envelope.saved = response.saved;
  }
  if (typeof response.saveError === 'string') {
    envelope.saveError = response.saveError;
  }
  return envelope;
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    } satisfies SpawnOptions);

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        signal: signal as NodeJS.Signals | null,
      });
    });
  });
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}