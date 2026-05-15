import * as assert from 'assert';

import {
  buildLabVIEWSessionKey,
  buildLabVIEWSessionRequestLines,
} from '../../scripts/labviewSession';

suite('labviewSession', () => {
  test('builds a case-insensitive session key from target paths', () => {
    const left = buildLabVIEWSessionKey({
      scriptHost: 'C:/Windows/System32/cscript.exe',
      sessionHostScript: 'D:/ext/workers/labview_session_host.vbs',
      targetExe: 'C:/Program Files/National Instruments/LabVIEW 2025/LabVIEW.exe',
      expectedDirectory: 'C:/Program Files/National Instruments/LabVIEW 2025',
      expectedVersion: '25.0',
    });
    const right = buildLabVIEWSessionKey({
      scriptHost: 'c:\\windows\\system32\\CSCRIPT.exe',
      sessionHostScript: 'D:/ext/workers/labview_session_host.vbs',
      targetExe: 'c:\\program files\\national instruments\\labview 2025\\labview.exe',
      expectedDirectory: 'c:\\program files\\national instruments\\labview 2025',
      expectedVersion: '25.0',
    });

    assert.strictEqual(left, right);
  });

  test('serializes request lines with timeout and optional fields', () => {
    const lines = buildLabVIEWSessionRequestLines({
      command: 'export-panels',
      viPath: 'C:\\repo\\demo.vi',
      fpOutputPath: 'C:\\tmp\\demo-fp.png',
      bdOutputPath: 'C:\\tmp\\demo-bd.png',
      timeoutMs: 90_000,
    });

    assert.deepStrictEqual(lines, [
      'command=export-panels',
      'timeoutSeconds=90',
      'viPath=C:\\repo\\demo.vi',
      'fpOutputPath=C:\\tmp\\demo-fp.png',
      'bdOutputPath=C:\\tmp\\demo-bd.png',
    ]);
  });

  test('clamps short timeouts to the minimum worker timeout', () => {
    const lines = buildLabVIEWSessionRequestLines({
      command: 'read-props',
      viPath: 'C:\\repo\\demo.vi',
      timeoutMs: 2_000,
    });

    assert.strictEqual(lines[1], 'timeoutSeconds=45');
  });
});