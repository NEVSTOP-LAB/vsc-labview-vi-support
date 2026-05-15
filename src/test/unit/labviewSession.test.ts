import * as assert from 'assert';

import {
  buildLabVIEWSessionKey,
  buildLabVIEWSessionRequestLines,
  probeLabVIEWSession,
} from '../../scripts/labviewSession';

function toBase64Utf8(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

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

  test('serializes path-like request fields as base64 utf8', () => {
    const lines = buildLabVIEWSessionRequestLines({
      command: 'export-panels',
      viPath: 'C:\\仓库\\示例.vi',
      fpOutputPath: 'C:\\导出\\前面板.png',
      bdOutputPath: 'C:\\导出\\程序框图.png',
      timeoutMs: 90_000,
    });

    assert.deepStrictEqual(lines, [
      'command=export-panels',
      'timeoutSeconds=90',
      `viPath_b64=${toBase64Utf8('C:\\仓库\\示例.vi')}`,
      `fpOutputPath_b64=${toBase64Utf8('C:\\导出\\前面板.png')}`,
      `bdOutputPath_b64=${toBase64Utf8('C:\\导出\\程序框图.png')}`,
    ]);
  });

  test('serializes requestPath as base64 utf8 when present', () => {
    const lines = buildLabVIEWSessionRequestLines({
      command: 'write-props',
      viPath: 'C:\\repo\\demo.vi',
      requestPath: 'C:\\临时\\写入请求.in',
      save: true,
    });

    assert.strictEqual(lines[2], `viPath_b64=${toBase64Utf8('C:\\repo\\demo.vi')}`);
    assert.strictEqual(lines[3], `requestPath_b64=${toBase64Utf8('C:\\临时\\写入请求.in')}`);
    assert.strictEqual(lines[4], 'save=1');
  });

  test('clamps short timeouts to the minimum worker timeout', () => {
    const lines = buildLabVIEWSessionRequestLines({
      command: 'read-props',
      viPath: 'C:\\repo\\demo.vi',
      timeoutMs: 2_000,
    });

    assert.strictEqual(lines[1], 'timeoutSeconds=45');
  });

  test('probeLabVIEWSession returns null when no tracked session exists', async () => {
    const response = await probeLabVIEWSession({
      scriptHost: 'C:/Windows/System32/cscript.exe',
      sessionHostScript: 'D:/ext/workers/labview_session_host.vbs',
      targetExe: 'C:/Program Files/National Instruments/LabVIEW 2025/LabVIEW.exe',
      expectedDirectory: 'C:/Program Files/National Instruments/LabVIEW 2025',
      expectedVersion: '25.0',
    }, 'C:\\repo\\demo.vi');

    assert.strictEqual(response, null);
  });
});