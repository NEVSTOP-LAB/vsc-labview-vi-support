import * as assert from 'assert';
import { EventEmitter } from 'events';
import {
  defaultPythonExecutable,
  PythonScriptError,
  runPythonScript,
  runPythonScriptOrFail,
  type SpawnFn,
} from '../../scripts/pythonRunner';

/**
 * Minimal fake `child_process.spawn`. Lets us drive stdout/stderr/exit code
 * deterministically without actually launching Python.
 */
class FakeChild extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public killed = false;
  public lastSignal: NodeJS.Signals | undefined;
  public kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.lastSignal = signal;
    return true;
  }
}

function makeSpawn(
  configure: (child: FakeChild) => void,
): { spawnFn: SpawnFn; calls: { command: string; args: readonly string[]; options?: unknown }[] } {
  const calls: { command: string; args: readonly string[]; options?: unknown }[] = [];
  const spawnFn: SpawnFn = ((command: string, args: readonly string[], options) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    setImmediate(() => configure(child));
    // The runner only uses `.stdout`, `.stderr`, `.on(...)`, `.kill(...)`,
    // so casting through unknown is safe enough for tests.
    return child as unknown as ReturnType<SpawnFn>;
  }) as SpawnFn;
  return { spawnFn, calls };
}

suite('pythonRunner.runPythonScript', () => {
  test('passes through stdout/stderr and exit code', async () => {
    const { spawnFn, calls } = makeSpawn((child) => {
      child.stdout.emit('data', Buffer.from('hello '));
      child.stdout.emit('data', 'world');
      child.stderr.emit('data', 'warn');
      child.emit('close', 0, null);
    });

    const r = await runPythonScript('/x/script.py', ['--flag'], { spawnFn });
    assert.strictEqual(r.stdout, 'hello world');
    assert.strictEqual(r.stderr, 'warn');
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.signal, null);

    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].args, ['/x/script.py', '--flag']);
  });

  test('forces UTF-8 for Python stdio so Chinese JSON is decoded correctly', async () => {
    const { spawnFn, calls } = makeSpawn((child) => {
      child.emit('close', 0, null);
    });

    await runPythonScript('/x/script.py', [], {
      spawnFn,
      env: { MY_FLAG: '1' },
    });

    assert.strictEqual(calls.length, 1);
    const options = calls[0].options as { env?: NodeJS.ProcessEnv } | undefined;
    assert.strictEqual(options?.env?.MY_FLAG, '1');
    assert.strictEqual(options?.env?.PYTHONUTF8, '1');
    assert.strictEqual(options?.env?.PYTHONIOENCODING, 'utf-8');
  });

  test('uses default Python executable based on platform', () => {
    const exe = defaultPythonExecutable();
    if (process.platform === 'win32') {
      assert.strictEqual(exe, 'python');
    } else {
      assert.strictEqual(exe, 'python3');
    }
  });

  test('rejects with PythonScriptError on spawn error', async () => {
    const spawnFn: SpawnFn = ((..._args: unknown[]) => {
      void _args;
      const child = new FakeChild();
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child as unknown as ReturnType<SpawnFn>;
    }) as SpawnFn;

    await assert.rejects(
      runPythonScript('/x/script.py', [], { spawnFn }),
      (err: unknown) => {
        assert.ok(err instanceof PythonScriptError);
        assert.match((err as PythonScriptError).message, /ENOENT/);
        return true;
      },
    );
  });

  test('times out and kills the process', async () => {
    let killed: NodeJS.Signals | undefined;
    const spawnFn: SpawnFn = ((..._args: unknown[]) => {
      void _args;
      const child = new FakeChild();
      // never emit 'close' — let the timer fire.
      const realKill = child.kill.bind(child);
      child.kill = (signal?: NodeJS.Signals) => {
        killed = signal;
        return realKill(signal);
      };
      return child as unknown as ReturnType<SpawnFn>;
    }) as SpawnFn;

    await assert.rejects(
      runPythonScript('/x/forever.py', [], { spawnFn, timeoutMs: 25 }),
      (err: unknown) => {
        assert.ok(err instanceof PythonScriptError);
        assert.match((err as Error).message, /timed out/);
        assert.strictEqual(killed, 'SIGKILL');
        return true;
      },
    );
  });
});

suite('pythonRunner.runPythonScriptOrFail', () => {
  test('returns result on exit 0', async () => {
    const { spawnFn } = makeSpawn((child) => {
      child.stdout.emit('data', '{}');
      child.emit('close', 0, null);
    });
    const r = await runPythonScriptOrFail('/x.py', [], { spawnFn });
    assert.strictEqual(r.exitCode, 0);
  });

  test('throws on non-zero exit, including stderr tail in the message', async () => {
    const { spawnFn } = makeSpawn((child) => {
      child.stderr.emit('data', '[错误] something went wrong\n');
      child.emit('close', 3, null);
    });
    await assert.rejects(
      runPythonScriptOrFail('/x.py', [], { spawnFn }),
      (err: unknown) => {
        assert.ok(err instanceof PythonScriptError);
        assert.match((err as Error).message, /something went wrong/);
        assert.strictEqual((err as PythonScriptError).exitCode, 3);
        return true;
      },
    );
  });
});
