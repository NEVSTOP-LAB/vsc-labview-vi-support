/**
 * VI 级运行时操作。
 *
 * 封装所有需要通过 LabVIEW COM/ActiveX 接口读写 VI 属性或导出预览图像的函数，
 * 以及 VI 文件头解析（离线，不依赖 LabVIEW）。
 *
 * 本模块不依赖 `vscode`，可直接做单元测试。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  decodeBase64Utf8,
  parsePropsResponseText,
  type PropEntry,
  type PropsJsonEnvelope,
  type PropsResponse,
} from '../propsParser';
import { decorateProps, WRITABLE_PROP_TYPES } from '../propMetadata';
import { selectScriptHost, type ScriptPaths } from '../scriptPaths';
import {
  probeLabVIEWSession,
  requestLabVIEWSession,
} from '../labviewSession';
import {
  formatLabVIEWExpectedVersion,
  resolveLabVIEWVersionForPath,
  type LabVIEWVersion,
  type ResolvedLabVIEWVersion,
} from '../labviewVersionResolver';
import {
  delay,
} from './workerInvoker';
import {
  discoverInstalledLabVIEWs,
  selectInstalledLabVIEW,
  type InstalledLabVIEW,
} from './installedLabview';

const VI_VERSION_SCAN_BYTES = 512;
const VI_VERSION_MARKER = Buffer.from([0x00, 0x00, 0x00, 0xa0]);

export interface LabVIEWRuntimeOptions {
  timeoutMs?: number;
}

interface RuntimeTargetSelection {
  requestedVersion: ResolvedLabVIEWVersion | null;
  installation: InstalledLabVIEW | undefined;
  installations: InstalledLabVIEW[];
}

interface ImageWorkerResponse {
  ok: boolean;
  selection: string;
  reason: string;
  connectedVersion: string;
  connectedDirectory: string;
  attempts: number;
  outputPath: string;
  fpOutputPath: string;
  bdOutputPath: string;
}

export class UnsupportedPreviewExportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UnsupportedPreviewExportError';
  }
}

export function getUnsafePreviewExportReason(
  version: Pick<LabVIEWVersion, 'major' | 'minor'>,
): string | null {
  void version;
  return null;
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
    const input = isRecord(raw) && 'value' in raw ? raw['value'] : raw;
    const normalized = normalizeWritableValue(propName, propType, input);
    const encoded = Buffer.from(normalized, 'utf8').toString('base64');
    lines.push(`set_${propName}_type=${propType}`);
    lines.push(`set_${propName}_val=${encoded}`);
  }
  return lines;
}

export function normalizePropsEnvelope(envelope: PropsJsonEnvelope): PropsJsonEnvelope {
  const isReentrant = envelope.props['IsReentrant'];
  const reentrancyType = envelope.props['ReentrancyType'];
  if (!isFalseBooleanEntry(isReentrant) || !reentrancyType?.ok) {
    return envelope;
  }
  if (reentrancyType.value === '0') {
    return envelope;
  }
  return {
    ...envelope,
    props: {
      ...envelope.props,
      ReentrancyType: {
        ...reentrancyType,
        value: '0',
      },
    },
  };
}

export async function exportViPanelImage(
  viPath: string,
  panel: 'fp' | 'bd',
  outputPath: string,
  scripts: ScriptPaths,
  options: LabVIEWRuntimeOptions = {},
): Promise<string> {
  const outputs = await exportViPanelImages(
    viPath,
    { [panel]: outputPath },
    scripts,
    options,
  );
  return outputs[panel] ?? path.resolve(outputPath);
}

export async function exportViPanelImages(
  viPath: string,
  outputPaths: Partial<Record<'fp' | 'bd', string>>,
  scripts: ScriptPaths,
  options: LabVIEWRuntimeOptions = {},
): Promise<Partial<Record<'fp' | 'bd', string>>> {
  ensureWindows();
  const absViPath = path.resolve(viPath);
  const normalizedOutputs: Partial<Record<'fp' | 'bd', string>> = {};
  if (outputPaths.fp) {
    normalizedOutputs.fp = path.resolve(outputPaths.fp);
  }
  if (outputPaths.bd) {
    normalizedOutputs.bd = path.resolve(outputPaths.bd);
  }
  if (!normalizedOutputs.fp && !normalizedOutputs.bd) {
    throw new Error('At least one image output path must be provided.');
  }
  const target = await resolveTargetInstallation(absViPath);
  ensureTargetInstallation(target, absViPath);
  const unsupportedReason = getTargetPreviewExportUnsupportedReason(target);
  if (unsupportedReason) {
    throw new UnsupportedPreviewExportError(unsupportedReason);
  }
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const responseText = await requestLabVIEWSession(
        buildSessionTargetOptions(target, scripts),
        {
          command: 'export-panels',
          viPath: absViPath,
          fpOutputPath: normalizedOutputs.fp,
          bdOutputPath: normalizedOutputs.bd,
          timeoutMs: options.timeoutMs,
        },
      );
      const response = parseImageWorkerResponseText(responseText);
      if (response.ok) {
        return {
          ...(normalizedOutputs.fp
            ? { fp: response.fpOutputPath || response.outputPath || normalizedOutputs.fp }
            : {}),
          ...(normalizedOutputs.bd
            ? { bd: response.bdOutputPath || response.outputPath || normalizedOutputs.bd }
            : {}),
        };
      }
      const targets = Object.keys(normalizedOutputs).join(',') || 'unknown';
      lastError = new Error(response.reason || `Image export worker failed for panels=${targets}.`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < 2) {
      await delay(250 * (attempt + 1));
    }
  }

  const targets = Object.keys(normalizedOutputs).join(',') || 'unknown';
  throw lastError ?? new Error(`Image export worker failed for panels=${targets}.`);
}

export async function readViProps(
  viPath: string,
  scripts: ScriptPaths,
  options: LabVIEWRuntimeOptions = {},
): Promise<PropsJsonEnvelope> {
  ensureWindows();
  const absViPath = path.resolve(viPath);
  const target = await resolveTargetInstallation(absViPath);
  ensureTargetInstallation(target, absViPath);
  const responseText = await requestLabVIEWSession(
    buildSessionTargetOptions(target, scripts),
    {
      command: 'read-props',
      viPath: absViPath,
      timeoutMs: options.timeoutMs,
    },
  );
  const response = parsePropsResponseText(responseText);
  if (!response.ok) {
    throw new Error(response.reason || 'Read props worker failed.');
  }
  return toPropsEnvelope(absViPath, response);
}

export async function hasReusableLabVIEWConnection(
  viPath: string,
  scripts: ScriptPaths,
): Promise<boolean> {
  ensureWindows();
  try {
    const absViPath = path.resolve(viPath);
    const target = await resolveTargetInstallation(absViPath);
    if (target.requestedVersion && !target.installation) {
      return false;
    }
    const responseText = await probeLabVIEWSession(
      buildSessionTargetOptions(target, scripts),
      absViPath,
      true,
    );
    if (responseText === null) {
      return false;
    }
    return parsePropsResponseText(responseText).ok;
  } catch {
    return false;
  }
}

export async function readStaticViProps(viPath: string): Promise<PropsJsonEnvelope> {
  const absViPath = path.resolve(viPath);
  const savedVersion = formatLabVIEWVersion(await readViSavedVersion(absViPath));
  const staticProps: Record<string, PropEntry> = {
    Name: {
      ok: true,
      type: 'String',
      value: path.basename(absViPath),
      error: null,
      loaded: true,
    },
    Path: {
      ok: true,
      type: 'String',
      value: absViPath,
      error: null,
      loaded: true,
    },
  };
  return {
    viPath: absViPath,
    lvVersion: savedVersion,
    dynamicPropsLoaded: false,
    props: decorateProps(staticProps, {
      includeUnloadedDynamic: true,
      savedVersion,
    }),
  };
}

export async function writeViProps(
  viPath: string,
  updates: Record<string, unknown>,
  scripts: ScriptPaths,
  options: LabVIEWRuntimeOptions = {},
): Promise<PropsJsonEnvelope> {
  ensureWindows();
  const absViPath = path.resolve(viPath);
  const target = await resolveTargetInstallation(absViPath);
  ensureTargetInstallation(target, absViPath);
  const requestPath = path.join(
    os.tmpdir(),
    `labview-vi-write-${Math.random().toString(16).slice(2)}.in`,
  );
  try {
    const requestBody = buildWriteRequestLines(updates).join('\r\n') + '\r\n';
    await fs.promises.writeFile(requestPath, requestBody, 'ascii');

    const responseText = await requestLabVIEWSession(
      buildSessionTargetOptions(target, scripts),
      {
        command: 'write-props',
        viPath: absViPath,
        requestPath,
        save: true,
        timeoutMs: options.timeoutMs,
      },
    );
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

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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

async function resolveTargetInstallation(viPath: string): Promise<RuntimeTargetSelection> {
  const requestedVersion = await resolveLabVIEWVersionForPath(viPath, readViSavedVersion);
  if (!requestedVersion) {
    return {
      requestedVersion: null,
      installation: undefined,
      installations: [],
    };
  }

  const installations = await discoverInstalledLabVIEWs();
  return {
    requestedVersion,
    installation: selectInstalledLabVIEW(
      installations,
      requestedVersion.major,
      requestedVersion.minor,
      requestedVersion.architecture,
    ),
    installations,
  };
}

function buildSessionTargetOptions(
  target: RuntimeTargetSelection,
  scripts: ScriptPaths,
): {
  scriptHost: string;
  sessionHostScript: string;
  targetExe?: string;
  expectedDirectory?: string;
  expectedVersion?: string;
} {
  return {
    scriptHost: selectScriptHost(target.installation?.architecture ?? target.requestedVersion?.architecture),
    sessionHostScript: scripts.sessionHostWorker,
    targetExe: target.installation?.exePath,
    expectedDirectory: target.installation?.installDir,
    expectedVersion: target.requestedVersion
      ? formatLabVIEWExpectedVersion(target.requestedVersion)
      : undefined,
  };
}

function ensureTargetInstallation(target: RuntimeTargetSelection, viPath: string): void {
  if (!target.requestedVersion || target.installation) {
    return;
  }
  const expectedVersion = formatLabVIEWExpectedVersion(target.requestedVersion);
  const expectedArchitecture = target.requestedVersion.architecture ? ` (${target.requestedVersion.architecture})` : '';
  const available = target.installations.length > 0
    ? target.installations
      .map((entry) => `${formatLabVIEWExpectedVersion(entry)} (${entry.architecture})`)
      .join(', ')
    : 'none';
  throw new Error(
    `No installed LabVIEW matches requested version ${expectedVersion}${expectedArchitecture} for ${viPath}. `
    + `Detected installations: ${available}. `
    + 'Please install a matching version or update the project LabVIEW marker.',
  );
}

function getTargetPreviewExportUnsupportedReason(target: RuntimeTargetSelection): string | null {
  const version = target.installation ?? target.requestedVersion;
  if (!version) {
    return null;
  }
  return getUnsafePreviewExportReason(version);
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
    ok: raw['ok'] === '1',
    selection: raw['selection'] ?? '',
    reason: decodeBase64Utf8(raw['reason_b64'] ?? ''),
    connectedVersion: decodeBase64Utf8(raw['connected_version_b64'] ?? ''),
    connectedDirectory: decodeBase64Utf8(raw['connected_directory_b64'] ?? ''),
    attempts: parseInt(raw['attempts'] ?? '0', 10) || 0,
    outputPath: decodeBase64Utf8(raw['output_path_b64'] ?? ''),
    fpOutputPath: decodeBase64Utf8(raw['fp_output_path_b64'] ?? ''),
    bdOutputPath: decodeBase64Utf8(raw['bd_output_path_b64'] ?? ''),
  };
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
    dynamicPropsLoaded: true,
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
  return normalizePropsEnvelope(envelope);
}

function isFalseBooleanEntry(entry: PropEntry | undefined): boolean {
  if (!entry?.ok) {
    return false;
  }
  const value = String(entry.value ?? '').trim().toLowerCase();
  return value === 'false' || value === '0';
}
