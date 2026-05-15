import * as path from 'path';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'child_process';
import { createLabVIEWAutomationGate } from './labviewAutomationGate';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 45;
const RESPONSE_BEGIN = '__LABVIEW_RESPONSE_BEGIN__';
const RESPONSE_END = '__LABVIEW_RESPONSE_END__';

const sessionPool = new Map<string, LabVIEWSessionHost>();
const automationGate = createLabVIEWAutomationGate();

export interface LabVIEWSessionTargetOptions {
  scriptHost: string;
  sessionHostScript: string;
  targetExe?: string;
  expectedDirectory?: string;
  expectedVersion?: string;
}

export interface LabVIEWSessionRequest {
  command: 'read-props' | 'write-props' | 'export-panels' | 'probe-session';
  viPath: string;
  requestPath?: string;
  fpOutputPath?: string;
  bdOutputPath?: string;
  save?: boolean;
  timeoutMs?: number;
}

interface PendingResponse {
  lines: string[];
  capturing: boolean;
  timer: NodeJS.Timeout;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
}

export function buildLabVIEWSessionKey(options: LabVIEWSessionTargetOptions): string {
  return [
    normalizePathKey(options.scriptHost),
    normalizePathKey(options.targetExe),
    normalizePathKey(options.expectedDirectory),
    (options.expectedVersion ?? '').trim().toLowerCase(),
  ].join('|');
}

export function buildLabVIEWSessionRequestLines(request: LabVIEWSessionRequest): string[] {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSeconds = Math.max(
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    Math.ceil(timeoutMs / 1000),
  );
  const lines = [
    `command=${request.command}`,
    `timeoutSeconds=${timeoutSeconds}`,
    `viPath_b64=${encodeBase64Utf8(request.viPath)}`,
  ];
  if (request.requestPath) {
    lines.push(`requestPath_b64=${encodeBase64Utf8(request.requestPath)}`);
  }
  if (request.fpOutputPath) {
    lines.push(`fpOutputPath_b64=${encodeBase64Utf8(request.fpOutputPath)}`);
  }
  if (request.bdOutputPath) {
    lines.push(`bdOutputPath_b64=${encodeBase64Utf8(request.bdOutputPath)}`);
  }
  if (typeof request.save === 'boolean') {
    lines.push(`save=${request.save ? '1' : '0'}`);
  }
  return lines;
}

function encodeBase64Utf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

export async function requestLabVIEWSession(
  options: LabVIEWSessionTargetOptions,
  request: LabVIEWSessionRequest,
): Promise<string> {
  return automationGate.run(async () => {
    const key = buildLabVIEWSessionKey(options);
    let session = sessionPool.get(key);
    if (!session) {
      session = new LabVIEWSessionHost(options);
      sessionPool.set(key, session);
    }

    try {
      return await session.request(request);
    } catch (error) {
      session.dispose(true);
      sessionPool.delete(key);
      throw error;
    }
  });
}

export async function probeLabVIEWSession(
  options: LabVIEWSessionTargetOptions,
  viPath = '',
  allowCreate = false,
): Promise<string | null> {
  return automationGate.run(async () => {
    const key = buildLabVIEWSessionKey(options);
    let session = sessionPool.get(key);
    const created = !session;
    if (!session) {
      if (!allowCreate) {
        return null;
      }
      session = new LabVIEWSessionHost(options);
      sessionPool.set(key, session);
    }

    try {
      const response = await session.request({
        command: 'probe-session',
        viPath,
      });
      if (created && !isOkResponse(response)) {
        session.dispose(false);
        sessionPool.delete(key);
      }
      return response;
    } catch (error) {
      session.dispose(true);
      sessionPool.delete(key);
      throw error;
    }
  });
}

export function disposeLabVIEWSessions(): void {
  for (const session of sessionPool.values()) {
    session.dispose(false);
  }
  sessionPool.clear();
}

class LabVIEWSessionHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: PendingResponse | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private requestChain: Promise<void> = Promise.resolve();
  private disposed = false;

  public constructor(private readonly options: LabVIEWSessionTargetOptions) {}

  public request(request: LabVIEWSessionRequest): Promise<string> {
    if (this.disposed) {
      return Promise.reject(new Error('LabVIEW session host has been disposed.'));
    }

    const run = async (): Promise<string> => this.performRequest(request);
    const result = this.requestChain.then(run, run);
    this.requestChain = result.then(() => undefined, () => undefined);
    return result;
  }

  public dispose(forceKill: boolean): void {
    this.disposed = true;
    this.rejectPending(new Error('LabVIEW session host has been disposed.'));
    this.teardownChild(forceKill);
  }

  private async performRequest(request: LabVIEWSessionRequest): Promise<string> {
    await this.ensureChild();
    if (!this.child) {
      throw new Error('LabVIEW session host failed to start.');
    }

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const payload = buildLabVIEWSessionRequestLines(request).join('\n') + '\n\n';

    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(new Error(`LabVIEW session request timed out after ${timeoutMs}ms.`));
        this.teardownChild(true);
      }, timeoutMs + 2000);

      this.pending = {
        lines: [],
        capturing: false,
        timer,
        resolve,
        reject,
      };

      try {
        this.child?.stdin.write(payload, 'utf8');
      } catch (error) {
        clearTimeout(timer);
        this.pending = null;
        this.teardownChild(true);
        reject(asError(error));
      }
    });
  }

  private async ensureChild(): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return;
    }

    this.stdoutBuffer = '';
    this.stderrBuffer = '';

    const args = ['//Nologo', this.options.sessionHostScript];
    if (this.options.targetExe) {
      args.push(`/targetExe:${this.options.targetExe}`);
    }
    if (this.options.expectedDirectory) {
      args.push(`/expectedDirectory:${this.options.expectedDirectory}`);
    }
    if (this.options.expectedVersion) {
      args.push(`/expectedVersion:${this.options.expectedVersion}`);
    }

    this.child = spawn(this.options.scriptHost, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    } satisfies SpawnOptions) as ChildProcessWithoutNullStreams;

    this.child.stdout.on('data', (chunk: Buffer | string) => {
      this.handleStdoutChunk(chunk.toString());
    });
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > 8000) {
        this.stderrBuffer = this.stderrBuffer.slice(-8000);
      }
    });
    this.child.on('error', (error) => {
      this.rejectPending(asError(error));
      this.teardownChild(true);
    });
    this.child.on('close', (code, signal) => {
      if (this.pending) {
        const stderr = this.stderrBuffer.trim();
        const detail = stderr ? ` ${stderr}` : '';
        this.rejectPending(new Error(
          `LabVIEW session host exited before completing the request (code=${code ?? -1}, signal=${signal ?? 'none'}).${detail}`,
        ));
      }
      this.child = null;
    });
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleStdoutLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleStdoutLine(line: string): void {
    if (!this.pending) {
      return;
    }
    if (!this.pending.capturing) {
      if (line === RESPONSE_BEGIN) {
        this.pending.capturing = true;
        this.pending.lines = [];
      }
      return;
    }
    if (line === RESPONSE_END) {
      const response = this.pending.lines.join('\n');
      const current = this.pending;
      clearTimeout(current.timer);
      this.pending = null;
      current.resolve(response);
      return;
    }
    this.pending.lines.push(line);
  }

  private rejectPending(error: Error): void {
    if (!this.pending) {
      return;
    }
    const current = this.pending;
    clearTimeout(current.timer);
    this.pending = null;
    current.reject(error);
  }

  private teardownChild(forceKill: boolean): void {
    const child = this.child;
    this.child = null;
    if (!child) {
      return;
    }
    try {
      if (!forceKill && child.stdin.writable) {
        child.stdin.write('command=shutdown\n\n', 'utf8');
        child.stdin.end();
        return;
      }
    } catch {
      // Fall through to kill below.
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}

function normalizePathKey(value: string | undefined): string {
  if (!value) {
    return '';
  }
  return path.resolve(value).replace(/\//g, '\\').toLowerCase();
}

function isOkResponse(responseText: string): boolean {
  for (const line of responseText.split(/\r?\n/)) {
    if (line.startsWith('ok=')) {
      return line.slice(3).trim() === '1';
    }
  }
  return false;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}