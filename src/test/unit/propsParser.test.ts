import * as assert from 'assert';
import {
  parseCachedPropsJson,
  parsePropsResponseText,
  parsePropsJson,
  PROPS_CACHE_VERSION,
  toCachedPropsJson,
} from '../../scripts/propsParser';

function b64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

suite('propsParser.parsePropsResponseText', () => {
  test('parses an OK read-worker response with mixed prop outcomes', () => {
    const lines = [
      'ok=1',
      'selection=matched-target-labview-application',
      `reason_b64=${b64('Connected.')}`,
      `connected_version_b64=${b64('17.0')}`,
      `connected_directory_b64=${b64('C:\\Program Files\\NI\\LabVIEW 2017')}`,
      'attempts=1',
      'prop_Name_type=String',
      'prop_Name_ok=1',
      `prop_Name_val=${b64('main.vi')}`,
      'prop_Description_type=String',
      'prop_Description_ok=1',
      `prop_Description_val=${b64('多行\n描述')}`,
      'prop_Priority_type=Number',
      'prop_Priority_ok=1',
      `prop_Priority_val=${b64('1')}`,
      'prop_HistoryText_type=String',
      'prop_HistoryText_ok=0',
      `prop_HistoryText_errmsg=${b64('Not available.')}`,
    ].join('\r\n');

    const r = parsePropsResponseText(lines);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.selection, 'matched-target-labview-application');
    assert.strictEqual(r.connectedVersion, '17.0');
    assert.strictEqual(r.attempts, 1);

    assert.strictEqual(r.props['Name'].ok, true);
    assert.strictEqual(r.props['Name'].value, 'main.vi');
    assert.strictEqual(r.props['Description'].value, '多行\n描述');
    assert.strictEqual(r.props['Priority'].type, 'Number');
    assert.strictEqual(r.props['Priority'].value, '1');
    assert.strictEqual(r.props['HistoryText'].ok, false);
    assert.strictEqual(r.props['HistoryText'].error, 'Not available.');
    assert.strictEqual(r.props['HistoryText'].value, null);
  });

  test('parses a write-worker response with saved=0', () => {
    const lines = [
      'ok=1',
      'selection=matched-target-labview-application',
      `reason_b64=${b64('OK')}`,
      `connected_version_b64=${b64('17.0')}`,
      `connected_directory_b64=${b64('C:\\NI')}`,
      'attempts=2',
      'prop_Description_type=String',
      'prop_Description_ok=1',
      `prop_Description_val=${b64('new desc')}`,
      'saved=0',
      `save_errmsg_b64=${b64('SaveVI failed: locked.')}`,
    ].join('\n');

    const r = parsePropsResponseText(lines);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.saved, false);
    assert.strictEqual(r.saveError, 'SaveVI failed: locked.');
    assert.strictEqual(r.props['Description'].ok, true);
    assert.strictEqual(r.props['Description'].value, 'new desc');
  });

  test('skips malformed lines and unknown suffixes (forward compat)', () => {
    const lines = [
      'ok=1',
      'selection=x',
      'reason_b64=',
      'connected_version_b64=',
      'connected_directory_b64=',
      'attempts=0',
      'no_equals_sign_here',
      '',
      'prop_X_type=String',
      'prop_X_ok=1',
      `prop_X_val=${b64('y')}`,
      'prop_X_unknown=ignored',
    ].join('\n');

    const r = parsePropsResponseText(lines);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.props['X'].value, 'y');
  });

  test('handles empty body gracefully', () => {
    const r = parsePropsResponseText('');
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.props, {});
    assert.strictEqual(r.attempts, 0);
  });
});

suite('propsParser.parsePropsJson', () => {
  test('accepts the JSON envelope produced by read_vi_props.py', () => {
    const env = parsePropsJson(JSON.stringify({
      vi_path: 'C:\\path\\main.vi',
      lv_version: '17.0',
      props: {
        Description: {
          ok: true, type: 'String', value: 'd', error: null,
          writable: true, description: 'desc', displayName: '说明', group: 'identity', groupLabel: '基础信息',
        },
        ExecPriority: {
          ok: true, type: 'Number', value: '1', error: null,
          writable: true, description: 'p', displayName: '执行优先级', group: 'execution', groupLabel: '执行设置',
        },
      },
    }));
    assert.strictEqual(env.viPath, 'C:\\path\\main.vi');
    assert.strictEqual(env.lvVersion, '17.0');
    assert.strictEqual(env.props['Description'].writable, true);
    assert.strictEqual(env.props['Description'].displayName, '说明');
    assert.strictEqual(env.props['ExecPriority'].groupLabel, '执行设置');
    assert.strictEqual(env.props['ExecPriority'].value, '1');
  });

  test('accepts the write envelope (saved/save_error)', () => {
    const env = parsePropsJson(JSON.stringify({
      vi_path: 'C:\\m.vi', lv_version: null,
      saved: true, save_error: '',
      props: {},
    }));
    assert.strictEqual(env.saved, true);
    assert.strictEqual(env.saveError, '');
    assert.strictEqual(env.lvVersion, null);
  });

  test('rejects non-object input', () => {
    assert.throws(() => parsePropsJson('null'));
    assert.throws(() => parsePropsJson('[]'));
    assert.throws(() => parsePropsJson('"x"'));
  });

  test('rejects missing props field', () => {
    assert.throws(() => parsePropsJson('{"vi_path":"x"}'));
  });
});

suite('propsParser cached props JSON', () => {
  test('roundtrips cache envelopes with an explicit cache version', () => {
    const cached = toCachedPropsJson({
      viPath: 'C:\\path\\main.vi',
      lvVersion: '17.0',
      saved: true,
      saveError: '',
      props: {
        Description: {
          ok: true,
          type: 'String',
          value: '中文说明',
          error: null,
          writable: true,
          description: 'VI 描述（属性对话框中的说明文字）',
          displayName: '说明',
          group: 'identity',
          groupLabel: '基础信息',
        },
      },
    });

    assert.strictEqual(cached['_cacheVersion'], PROPS_CACHE_VERSION);
    const parsed = parseCachedPropsJson(JSON.stringify(cached));
    assert.strictEqual(parsed.props['Description'].description, 'VI 描述（属性对话框中的说明文字）');
    assert.strictEqual(parsed.props['Description'].displayName, '说明');
    assert.strictEqual(parsed.props['Description'].groupLabel, '基础信息');
    assert.strictEqual(parsed.saved, true);
  });

  test('rejects stale cache entries without the cache version marker', () => {
    assert.throws(() => parseCachedPropsJson(JSON.stringify({
      vi_path: 'C:\\path\\main.vi',
      lv_version: '17.0',
      props: {},
    })));
  });
});
