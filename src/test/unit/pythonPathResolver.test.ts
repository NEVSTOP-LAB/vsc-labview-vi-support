import * as assert from 'assert';
import * as path from 'path';
import {
  resolvePythonExecutableForWorkspace,
  workspacePythonCandidates,
} from '../../scripts/pythonPathResolver';

suite('pythonPathResolver', () => {
  test('returns configured pythonPath when present', () => {
    const result = resolvePythonExecutableForWorkspace({
      configuredPythonPath: 'C:/custom/python.exe',
      workspaceFolderPath: 'D:/repo',
      existsSync: () => false,
    });
    assert.strictEqual(result, 'C:/custom/python.exe');
  });

  test('finds .venv python.exe on Windows', () => {
    const root = 'D:/repo';
    const expected = path.join(root, '.venv', 'Scripts', 'python.exe');
    const result = resolvePythonExecutableForWorkspace({
      workspaceFolderPath: root,
      platform: 'win32',
      existsSync: (filePath) => filePath === expected,
    });
    assert.strictEqual(result, expected);
  });

  test('falls back to undefined when neither setting nor venv exists', () => {
    const result = resolvePythonExecutableForWorkspace({
      workspaceFolderPath: 'D:/repo',
      platform: 'win32',
      existsSync: () => false,
    });
    assert.strictEqual(result, undefined);
  });

  test('builds non-Windows candidates under bin/', () => {
    const candidates = workspacePythonCandidates('/tmp/repo', 'linux');
    assert.deepStrictEqual(candidates.slice(0, 2), [
      path.join('/tmp/repo', '.venv', 'bin', 'python3'),
      path.join('/tmp/repo', '.venv', 'bin', 'python'),
    ]);
  });
});