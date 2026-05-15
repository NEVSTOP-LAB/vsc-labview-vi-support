import * as fs from 'fs';
import * as path from 'path';

export type LabVIEWArchitecture = 'x86' | 'x64';

export interface LabVIEWVersion {
  major: number;
  minor: number;
}

export type LabVIEWVersionSource = 'directory-marker' | 'lvproj' | 'vi';

export interface ResolvedLabVIEWVersion extends LabVIEWVersion {
  architecture?: LabVIEWArchitecture;
  source: LabVIEWVersionSource;
  sourcePath: string;
  scopeDirectory: string;
}

const DIRECTORY_MARKER_PREFIX = /^DEV ENVIRONMENT LabVIEW\s+/i;
const DIRECTORY_MARKER_REGEX = /^DEV ENVIRONMENT LabVIEW\s+(.+?)(?:\s*[\(（]\s*(32\s*bit|64\s*bit|x86|x64)\s*[\)）]?)?\s*$/i;
const LVPROJ_VERSION_PATTERNS = [
  /\bLVVersion\s*=\s*["']([^"']+)["']/i,
  /<Property\b[^>]*\bName\s*=\s*["']LVVersion["'][^>]*>([^<]+)<\/Property>/i,
  /<Property\b[^>]*\bName\s*=\s*["']Version["'][^>]*>([^<]+)<\/Property>/i,
] as const;

export function parseDirectoryMarkerFileName(fileName: string): Pick<ResolvedLabVIEWVersion, 'major' | 'minor' | 'architecture'> | null {
  const match = DIRECTORY_MARKER_REGEX.exec(fileName.trim());
  if (!match) {
    return null;
  }

  const version = parseLabVIEWVersionToken(match[1]);
  if (!version) {
    return null;
  }

  return {
    ...version,
    architecture: normalizeArchitecture(match[2]) ?? 'x86',
  };
}

export function parseLvprojVersion(xmlText: string): LabVIEWVersion | null {
  for (const pattern of LVPROJ_VERSION_PATTERNS) {
    const match = pattern.exec(xmlText);
    if (!match) {
      continue;
    }
    const parsed = parseLabVIEWVersionToken(match[1]);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

export async function resolveDirectoryLabVIEWVersion(directoryPath: string): Promise<ResolvedLabVIEWVersion | null> {
  const ancestors = collectAncestorDirectories(directoryPath);
  const directoryMarker = await findDirectoryMarker(ancestors);
  if (directoryMarker) {
    return directoryMarker;
  }
  return findLvprojVersion(ancestors);
}

export async function resolveLabVIEWVersionForPath(
  resourcePath: string,
  readViSavedVersion: (viPath: string) => Promise<LabVIEWVersion | null>,
): Promise<ResolvedLabVIEWVersion | null> {
  const absPath = path.resolve(resourcePath);
  const directoryVersion = await resolveDirectoryLabVIEWVersion(path.dirname(absPath));
  if (directoryVersion) {
    return directoryVersion;
  }

  const savedVersion = await readViSavedVersion(absPath);
  if (!savedVersion) {
    return null;
  }

  return {
    ...savedVersion,
    source: 'vi',
    sourcePath: absPath,
    scopeDirectory: path.dirname(absPath),
  };
}

export function formatLabVIEWExpectedVersion(version: Pick<LabVIEWVersion, 'major' | 'minor'>): string {
  return `${version.major}.${version.minor}`;
}

export function formatLabVIEWDisplayName(version: Pick<LabVIEWVersion, 'major' | 'minor'>, architecture?: LabVIEWArchitecture): string {
  const base = version.minor === 0 && version.major >= 9
    ? `LabVIEW ${2000 + version.major}`
    : `LabVIEW ${version.major}.${version.minor}`;

  if (architecture === 'x64') {
    return `${base} 64bit`;
  }
  if (architecture === 'x86') {
    return `${base} 32bit`;
  }
  return base;
}

export function buildDirectoryMarkerFileName(
  version: Pick<LabVIEWVersion, 'major' | 'minor'>,
  architecture?: LabVIEWArchitecture,
): string {
  const versionLabel = version.minor === 0 && version.major >= 9
    ? `${2000 + version.major}`
    : `${version.major}.${version.minor}`;

  if (architecture === 'x64') {
    return `DEV ENVIRONMENT LabVIEW ${versionLabel}(64bit)`;
  }
  return `DEV ENVIRONMENT LabVIEW ${versionLabel}`;
}

export async function listDirectoryMarkerFiles(directoryPath: string): Promise<string[]> {
  const entries = await readDirectoryEntries(directoryPath);
  return entries
    .filter((entry) => entry.isFile() && parseDirectoryMarkerFileName(entry.name))
    .map((entry) => path.join(directoryPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export async function writeDirectoryLabVIEWMarker(
  directoryPath: string,
  version: Pick<LabVIEWVersion, 'major' | 'minor'>,
  architecture?: LabVIEWArchitecture,
): Promise<string> {
  const absDirectory = path.resolve(directoryPath);
  const markerPath = path.join(absDirectory, buildDirectoryMarkerFileName(version, architecture));
  const markerFiles = await listDirectoryMarkerFiles(absDirectory);

  await Promise.all(markerFiles
    .filter((existingPath) => existingPath.toLowerCase() !== markerPath.toLowerCase())
    .map(async (existingPath) => {
      try {
        await fs.promises.unlink(existingPath);
      } catch {
        // ignore stale marker cleanup failures
      }
    }));

  const content = [
    'Managed by LabVIEW VI Support.',
    `Version=${formatLabVIEWDisplayName(version, architecture)}`,
  ].join('\r\n') + '\r\n';
  await fs.promises.writeFile(markerPath, content, 'ascii');
  return markerPath;
}

export async function clearDirectoryLabVIEWMarkers(directoryPath: string): Promise<string[]> {
  const markerFiles = await listDirectoryMarkerFiles(directoryPath);
  await Promise.all(markerFiles.map(async (markerFile) => {
    try {
      await fs.promises.unlink(markerFile);
    } catch {
      // ignore files removed concurrently
    }
  }));
  return markerFiles;
}

function parseLabVIEWVersionToken(token: string): LabVIEWVersion | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  const dotted = /^(\d{1,2})\.(\d{1,2})$/.exec(trimmed);
  if (dotted) {
    return {
      major: Number(dotted[1]),
      minor: Number(dotted[2]),
    };
  }

  const year = /^(20\d{2})$/.exec(trimmed);
  if (year) {
    return {
      major: Number(year[1]) - 2000,
      minor: 0,
    };
  }

  const encoded = /^0?(\d{1,2})(\d{2})\d{4}$/.exec(trimmed);
  if (encoded) {
    return {
      major: Number(encoded[1]),
      minor: Number(encoded[2]),
    };
  }

  return null;
}

function normalizeArchitecture(raw: string | undefined): LabVIEWArchitecture | undefined {
  const normalized = raw?.replace(/\s+/g, '').toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === '64bit' || normalized === 'x64') {
    return 'x64';
  }
  if (normalized === '32bit' || normalized === 'x86') {
    return 'x86';
  }
  return undefined;
}

function collectAncestorDirectories(startDirectory: string): string[] {
  const directories: string[] = [];
  let current = path.resolve(startDirectory);
  while (true) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
}

async function findDirectoryMarker(ancestors: readonly string[]): Promise<ResolvedLabVIEWVersion | null> {
  for (const directory of ancestors) {
    const entries = await readDirectoryEntries(directory);
    const markers = entries
      .filter((entry) => entry.isFile() && DIRECTORY_MARKER_PREFIX.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const marker of markers) {
      const parsed = parseDirectoryMarkerFileName(marker.name);
      if (!parsed) {
        continue;
      }
      return {
        ...parsed,
        source: 'directory-marker',
        sourcePath: path.join(directory, marker.name),
        scopeDirectory: directory,
      };
    }
  }
  return null;
}

async function findLvprojVersion(ancestors: readonly string[]): Promise<ResolvedLabVIEWVersion | null> {
  for (const directory of ancestors) {
    const entries = await readDirectoryEntries(directory);
    const lvprojFiles = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.lvproj'))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const lvprojFile of lvprojFiles) {
      const lvprojPath = path.join(directory, lvprojFile.name);
      try {
        const xmlText = await fs.promises.readFile(lvprojPath, 'utf8');
        const parsed = parseLvprojVersion(xmlText);
        if (!parsed) {
          continue;
        }
        return {
          ...parsed,
          source: 'lvproj',
          sourcePath: lvprojPath,
          scopeDirectory: directory,
        };
      } catch {
        // ignore unreadable project files
      }
    }
  }
  return null;
}

async function readDirectoryEntries(directoryPath: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}