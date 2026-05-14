import * as fs from 'fs';
import * as path from 'path';

const VENV_DIR_NAMES = ['.venv', 'venv', '.env', 'env'];

export interface ResolvePythonExecutableOptions {
  configuredPythonPath?: string;
  workspaceFolderPath?: string;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
}

export function workspacePythonCandidates(
  workspaceFolderPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') {
    return VENV_DIR_NAMES.map((dirName) => path.join(workspaceFolderPath, dirName, 'Scripts', 'python.exe'));
  }

  return VENV_DIR_NAMES.flatMap((dirName) => [
    path.join(workspaceFolderPath, dirName, 'bin', 'python3'),
    path.join(workspaceFolderPath, dirName, 'bin', 'python'),
  ]);
}

export function resolvePythonExecutableForWorkspace(
  options: ResolvePythonExecutableOptions = {},
): string | undefined {
  const {
    configuredPythonPath,
    workspaceFolderPath,
    platform = process.platform,
    existsSync = fs.existsSync,
  } = options;

  const configured = configuredPythonPath?.trim();
  if (configured) {
    return configured;
  }
  if (!workspaceFolderPath) {
    return undefined;
  }

  for (const candidate of workspacePythonCandidates(workspaceFolderPath, platform)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}