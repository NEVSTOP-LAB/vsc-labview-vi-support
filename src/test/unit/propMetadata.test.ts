import * as assert from 'assert';

import {
  buildInstalledLabVIEWDiscoveryScript,
  buildWriteRequestLines,
  normalizePropsEnvelope,
} from '../../scripts/labviewRuntime';
import { buildLoadingProps, decorateProps } from '../../scripts/propMetadata';

function b64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

suite('propMetadata.decorateProps', () => {
  test('injects detected VI version metadata and hides unavailable props by default', () => {
    const props = decorateProps({
      Description: {
        ok: true,
        type: 'String',
        value: 'desc',
        error: null,
      },
      VIType: {
        ok: false,
        type: 'Number',
        value: null,
        error: 'unsupported',
      },
      Unknown: {
        ok: true,
        type: 'String',
        value: 'extra',
        error: null,
      },
    }, { savedVersion: '17.0' });

    const generalKeys = Object.keys(props).filter((name) => props[name].group === 'general');
    assert.deepStrictEqual(generalKeys, ['Description', 'SavedVersion']);
    assert.strictEqual(props['SavedVersion'].value, '17.0');
    assert.strictEqual(props['SavedVersion'].writable, false);
    assert.strictEqual(props['SavedVersion'].accessMode, 'readonly');
    assert.strictEqual(props['SavedVersion'].displayName, '侦测到的VI版本');
    assert.strictEqual(props['SavedVersion'].groupLabel, '通用信息');
    assert.strictEqual(props['SavedVersion'].source, 'static');
    assert.strictEqual(props['Description'].description, 'VI 的描述信息。');
    assert.strictEqual(props['Description'].displayName, '说明');
    assert.strictEqual(props['Description'].group, 'general');
    assert.strictEqual(props['Description'].groupLabel, '通用信息');
    assert.strictEqual('VIType' in props, false);
    assert.strictEqual(props['FPWinIsFrontMost'].writable, true);
    assert.strictEqual(props['FPWinIsFrontMost'].accessMode, 'writeonly');
    assert.strictEqual(props['FPWinIsFrontMost'].groupLabel, '前面板窗口外观与行为');
  });

  test('can retain unavailable props when explicitly requested', () => {
    const props = decorateProps({
      ExecState: {
        ok: false,
        type: 'Number',
        value: null,
        error: 'unsupported',
      },
    }, { includeUnavailable: true });

    assert.strictEqual(props['ExecState'].writable, false);
    assert.strictEqual(props['ExecState'].displayName, '执行状态');
    assert.strictEqual(props['ExecState'].groupLabel, '行为与执行控制');
    assert.strictEqual(props['ExecState'].description, 'VI 当前的执行状态枚举值。');
  });

  test('can include unloaded dynamic placeholders and writeonly placeholders', () => {
    const props = decorateProps({
      Name: {
        ok: true,
        type: 'String',
        value: 'main.vi',
        error: null,
      },
    }, { includeUnloadedDynamic: true, savedVersion: '17.0' });

    assert.strictEqual(props['Name'].source, 'static');
    assert.strictEqual(props['Name'].sourceLabel, '静态');
    assert.strictEqual(props['Name'].writable, false);
    assert.strictEqual(props['Name'].accessMode, 'readonly');
    assert.strictEqual(props['SavedVersion'].value, '17.0');
    assert.strictEqual(props['SavedVersion'].source, 'static');
    assert.strictEqual(props['Description'].loaded, false);
    assert.strictEqual(props['Description'].source, 'dynamic');
    assert.strictEqual(props['Description'].sourceLabel, '动态');
    assert.strictEqual(props['Description'].sourceDescription, '动态属性：需要通过 LabVIEW VI Server 读取，按需加载时可能触发 LabVIEW 窗口。');
    assert.strictEqual(
      Object.keys(props).filter((name) => props[name].group === 'general').at(-1),
      'SavedVersion',
    );
    assert.strictEqual(props['FPMinimizable'].loaded, false);
    assert.strictEqual(props['FPWinIsFrontMost'].loaded, true);
    assert.strictEqual(props['FPWinIsFrontMost'].value, null);
    assert.strictEqual(props['FPWinIsFrontMost'].accessMode, 'writeonly');
  });

  test('can build a full loading placeholder table from metadata', () => {
    const props = buildLoadingProps();

    assert.strictEqual(props['Name'].pending, true);
    assert.strictEqual(props['Name'].loaded, true);
    assert.strictEqual(props['Name'].displayName, '名称');
    assert.strictEqual(props['Name'].source, 'static');
    assert.strictEqual(props['FPMinimizable'].pending, true);
    assert.strictEqual(props['FPMinimizable'].writable, true);
    assert.strictEqual(props['FPWinIsFrontMost'].pending, true);
    assert.strictEqual(props['FPWinIsFrontMost'].accessMode, 'writeonly');
  });
});

suite('labviewRuntime.buildWriteRequestLines', () => {
  test('normalizes nonreentrant VIs to reentrancy type 0 for display', () => {
    const normalized = normalizePropsEnvelope({
      viPath: 'C:\\repo\\demo.vi',
      lvVersion: '20.0',
      dynamicPropsLoaded: true,
      props: {
        IsReentrant: {
          ok: true,
          type: 'Boolean',
          value: 'False',
          error: null,
        },
        ReentrancyType: {
          ok: true,
          type: 'Number',
          value: '1',
          error: null,
        },
      },
    });

    assert.strictEqual(normalized.props['ReentrancyType'].value, '0');
  });

  test('serializes the curated writable properties', () => {
    const lines = buildWriteRequestLines({
      Description: 'new desc',
      EditMode: true,
      ReentrancyType: 2,
      PreferredExecSystem: 7,
      FPWinTitle: 'Front Panel',
      FPWinIsFrontMost: true,
    });

    assert.deepStrictEqual(lines, [
      'set_Description_type=String',
      `set_Description_val=${b64('new desc')}`,
      'set_EditMode_type=Boolean',
      `set_EditMode_val=${b64('1')}`,
      'set_ReentrancyType_type=Number',
      `set_ReentrancyType_val=${b64('2')}`,
      'set_PreferredExecSystem_type=Number',
      `set_PreferredExecSystem_val=${b64('7')}`,
      'set_FPWinTitle_type=String',
      `set_FPWinTitle_val=${b64('Front Panel')}`,
      'set_FPWinIsFrontMost_type=Boolean',
      `set_FPWinIsFrontMost_val=${b64('1')}`,
    ]);
  });

  test('rejects removed legacy properties', () => {
    assert.throws(() => buildWriteRequestLines({ PrintHeader: 'x' }));
    assert.throws(() => buildWriteRequestLines({ Priority: 2 }));
    assert.throws(() => buildWriteRequestLines({ Name: 'renamed.vi' }));
    assert.throws(() => buildWriteRequestLines({ RevisionNumber: '42' }));
    assert.throws(() => buildWriteRequestLines({ FPState: 1 }));
    assert.throws(() => buildWriteRequestLines({ FPWinBounds: '1,2,3,4' }));
    assert.throws(() => buildWriteRequestLines({ HistoryText: 'legacy' }));
    assert.throws(() => buildWriteRequestLines({ ExecPriority: 3 }));
  });

  test('builds a multiline PowerShell discovery script for installed versions', () => {
    const script = buildInstalledLabVIEWDiscoveryScript();

    assert.ok(script.includes('$roots = @('));
    assert.ok(script.includes('HKLM:\\SOFTWARE\\National Instruments\\LabVIEW'));
    assert.ok(script.includes('ConvertTo-Json -Compress'));
    assert.ok(!script.includes('@(;'));
    assert.ok(script.includes('\n'));
  });
});