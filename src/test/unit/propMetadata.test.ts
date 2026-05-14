import * as assert from 'assert';

import { buildWriteRequestLines } from '../../scripts/labviewRuntime';
import { decorateProps } from '../../scripts/propMetadata';

function b64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

suite('propMetadata.decorateProps', () => {
  test('injects saved version metadata and hides unavailable props by default', () => {
    const props = decorateProps({
      Description: {
        ok: true,
        type: 'String',
        value: 'desc',
        error: null,
      },
      ExecPriority: {
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

    assert.deepStrictEqual(Object.keys(props), ['SavedVersion', 'Description', 'Unknown']);
    assert.strictEqual(props['SavedVersion'].value, '17.0');
    assert.strictEqual(props['SavedVersion'].writable, false);
    assert.strictEqual(props['SavedVersion'].displayName, '保存版本');
    assert.strictEqual(props['SavedVersion'].groupLabel, '基础信息');
    assert.strictEqual(props['Description'].description, 'VI 描述（属性对话框中的说明文字）');
    assert.strictEqual(props['Description'].displayName, '说明');
    assert.strictEqual(props['Description'].group, 'identity');
    assert.strictEqual('ExecPriority' in props, false);
  });

  test('can retain unavailable props when explicitly requested', () => {
    const props = decorateProps({
      ExecPriority: {
        ok: false,
        type: 'Number',
        value: null,
        error: 'unsupported',
      },
    }, { includeUnavailable: true });

    assert.strictEqual(props['ExecPriority'].writable, true);
    assert.strictEqual(props['ExecPriority'].displayName, '执行优先级');
    assert.strictEqual(props['ExecPriority'].groupLabel, '执行设置');
    assert.strictEqual(props['ExecPriority'].description, '执行优先级（VI Server 枚举值）');
  });
});

suite('labviewRuntime.buildWriteRequestLines', () => {
  test('serializes the curated writable properties', () => {
    const lines = buildWriteRequestLines({
      Description: 'new desc',
      IsReentrant: true,
      PreferredExecSystem: 7,
      ExecPriority: '3',
      CloseFPAfterCall: false,
    });

    assert.deepStrictEqual(lines, [
      'set_Description_type=String',
      `set_Description_val=${b64('new desc')}`,
      'set_IsReentrant_type=Boolean',
      `set_IsReentrant_val=${b64('1')}`,
      'set_PreferredExecSystem_type=Number',
      `set_PreferredExecSystem_val=${b64('7')}`,
      'set_ExecPriority_type=Number',
      `set_ExecPriority_val=${b64('3')}`,
      'set_CloseFPAfterCall_type=Boolean',
      `set_CloseFPAfterCall_val=${b64('0')}`,
    ]);
  });

  test('rejects removed legacy properties', () => {
    assert.throws(() => buildWriteRequestLines({ PrintHeader: 'x' }));
    assert.throws(() => buildWriteRequestLines({ Priority: 2 }));
  });
});