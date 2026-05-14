import { spawn, SpawnOptions } from 'child_process';

/**
 * `child_process.spawn` 的轻量封装，用来调用内置的 Python 原型脚本。
 *
 * 本模块为纯逻辑（不依赖 vscode），通过注入自定义 `spawnFn` 即可在单元
 * 测试中完全模拟子进程行为。
 */

export interface SpawnedProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ReturnType<typeof spawn>;

export interface RunPythonOptions {
  /** Override the Python executable. Defaults to `python` on Windows, `python3` elsewhere. */
  pythonExecutable?: string;
  /** Working directory passed to the child process. */
  cwd?: string;
  /** Process environment overrides (merged with `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Hard timeout in milliseconds. Defaults to 120000. */
  timeoutMs?: number;
  /** Test seam — defaults to the real `child_process.spawn`. */
  spawnFn?: SpawnFn;
}

export class PythonScriptError extends Error {
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly exitCode: number;
  public readonly signal: NodeJS.Signals | null;

  public constructor(
    message: string,
    detail: { stdout: string; stderr: string; exitCode: number; signal: NodeJS.Signals | null },
  ) {
    super(message);
    this.name = 'PythonScriptError';
    this.stdout = detail.stdout;
    this.stderr = detail.stderr;
    this.exitCode = detail.exitCode;
    this.signal = detail.signal;
  }
}

export function defaultPythonExecutable(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

export async function runPythonScript(
  scriptPath: string,
  scriptArgs: readonly string[],
  options: RunPythonOptions = {},
): Promise<SpawnedProcessResult> {
  const {
    pythonExecutable = defaultPythonExecutable(),
    cwd,
    env,
    timeoutMs = 120_000,
    spawnFn = spawn,
  } = options;

  const args = [scriptPath, ...scriptArgs];
  const childEnv = {
    ...process.env,
    ...env,
    // Python on Windows may otherwise emit pipe stdout/stderr using the
    // active ANSI code page, which corrupts Chinese JSON/error text when the
    // extension decodes child output as UTF-8.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };

  return new Promise((resolve, reject) => {
    const child = spawnFn(pythonExecutable, args, {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

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
      reject(new PythonScriptError(
        `Python script timed out after ${timeoutMs}ms: ${scriptPath}`,
        { stdout, stderr, exitCode: -1, signal: 'SIGKILL' },
      ));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new PythonScriptError(
        `Failed to spawn Python: ${(err as Error).message}`,
        { stdout, stderr, exitCode: -1, signal: null },
      ));
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

/**
 * Run a Python script and require an exit code of 0; otherwise throw a
 * `PythonScriptError` carrying both streams. Convenience wrapper for the
 * common case in the editor host.
 */
export async function runPythonScriptOrFail(
  scriptPath: string,
  scriptArgs: readonly string[],
  options: RunPythonOptions = {},
): Promise<SpawnedProcessResult> {
  const result = await runPythonScript(scriptPath, scriptArgs, options);
  if (result.exitCode !== 0) {
    const summary = result.stderr.trim().split(/\r?\n/).slice(-3).join(' | ')
      || `exit code ${result.exitCode}`;
    throw new PythonScriptError(
      `Python script failed: ${summary}`,
      result,
    );
  }
  return result;
}
