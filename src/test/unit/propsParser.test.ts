import * as assert from 'assert';
import {
  mergeUpdatedPropsIntoEnvelope,
  mergeStaticPropsIntoEnvelope,
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
      'prop_VIType_type=Number',
      'prop_VIType_ok=1',
      `prop_VIType_val=${b64('1')}`,
      'prop_FPWinClosable_type=Boolean',
      'prop_FPWinClosable_ok=0',
      `prop_FPWinClosable_errmsg=${b64('Not available.')}`,
    ].join('\r\n');

    const r = parsePropsResponseText(lines);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.selection, 'matched-target-labview-application');
    assert.strictEqual(r.connectedVersion, '17.0');
    assert.strictEqual(r.attempts, 1);

    assert.strictEqual(r.props['Name'].ok, true);
    assert.strictEqual(r.props['Name'].value, 'main.vi');
    assert.strictEqual(r.props['Description'].value, '多行\n描述');
    assert.strictEqual(r.props['VIType'].type, 'Number');
    assert.strictEqual(r.props['VIType'].value, '1');
    assert.strictEqual(r.props['FPWinClosable'].ok, false);
    assert.strictEqual(r.props['FPWinClosable'].error, 'Not available.');
    assert.strictEqual(r.props['FPWinClosable'].value, null);
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
  test('accepts the runtime JSON envelope for read results', () => {
    const env = parsePropsJson(JSON.stringify({
      vi_path: 'C:\\path\\main.vi',
      lv_version: '17.0',
      dynamic_props_loaded: true,
      props: {
        Description: {
          ok: true, type: 'String', value: 'd', error: null,
          loaded: true, pending: true, writable: true, accessMode: 'readwrite', description: 'desc', displayName: '说明', group: 'general', groupLabel: '通用信息',
          source: 'dynamic', sourceLabel: '动态', sourceDescription: '动态属性',
        },
        FPWinIsFrontMost: {
          ok: true, type: 'Boolean', value: null, error: null,
          loaded: true, writable: true, accessMode: 'writeonly', description: 'front', displayName: '前面板置顶', group: 'panel', groupLabel: '前面板窗口外观与行为',
          source: 'dynamic', sourceLabel: '动态', sourceDescription: '动态属性',
        },
      },
    }));
    assert.strictEqual(env.viPath, 'C:\\path\\main.vi');
    assert.strictEqual(env.lvVersion, '17.0');
    assert.strictEqual(env.dynamicPropsLoaded, true);
    assert.strictEqual(env.props['Description'].writable, true);
    assert.strictEqual(env.props['Description'].accessMode, 'readwrite');
    assert.strictEqual(env.props['Description'].loaded, true);
    assert.strictEqual(env.props['Description'].pending, true);
    assert.strictEqual(env.props['Description'].displayName, '说明');
    assert.strictEqual(env.props['Description'].source, 'dynamic');
    assert.strictEqual(env.props['FPWinIsFrontMost'].groupLabel, '前面板窗口外观与行为');
    assert.strictEqual(env.props['FPWinIsFrontMost'].accessMode, 'writeonly');
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
      dynamicPropsLoaded: false,
      saved: true,
      saveError: '',
      props: {
        SavedVersion: {
          ok: true,
          type: 'String',
          value: '17.0',
          error: null,
          loaded: true,
          writable: false,
          accessMode: 'readonly',
          description: '从 VI 文件头侦测到的保存版本，不通过 COM 读取。',
          displayName: '侦测到的VI版本',
          group: 'general',
          groupLabel: '通用信息',
          source: 'static',
          sourceLabel: '静态',
          sourceDescription: '静态属性：可直接离线读取，不需要启动 LabVIEW。',
        },
        Description: {
          ok: true,
          type: 'String',
          value: '中文说明',
          error: null,
          loaded: false,
          pending: true,
          writable: true,
          accessMode: 'readwrite',
          description: 'VI 的描述信息。',
          displayName: '说明',
          group: 'general',
          groupLabel: '通用信息',
          source: 'dynamic',
          sourceLabel: '动态',
          sourceDescription: '动态属性：需要通过 LabVIEW VI Server 读取，按需加载时可能触发 LabVIEW 窗口。',
        },
      },
    });

    assert.strictEqual(cached['_cacheVersion'], PROPS_CACHE_VERSION);
    assert.strictEqual(cached['dynamic_props_loaded'], false);
    const parsed = parseCachedPropsJson(JSON.stringify(cached));
    assert.strictEqual(parsed.props['SavedVersion'].value, '17.0');
    assert.strictEqual(parsed.props['SavedVersion'].source, 'static');
    assert.strictEqual(parsed.props['Description'].description, 'VI 的描述信息。');
    assert.strictEqual(parsed.props['Description'].displayName, '说明');
    assert.strictEqual(parsed.props['Description'].groupLabel, '通用信息');
    assert.strictEqual(parsed.props['Description'].loaded, false);
    assert.strictEqual(parsed.props['Description'].pending, true);
    assert.strictEqual(parsed.props['Description'].accessMode, 'readwrite');
    assert.strictEqual(parsed.props['Description'].source, 'dynamic');
    assert.strictEqual(parsed.dynamicPropsLoaded, false);
    assert.strictEqual(parsed.saved, true);
  });

  test('accepts compatible cache entries without the cache version marker', () => {
    const parsed = parseCachedPropsJson(JSON.stringify({
      vi_path: 'C:\\path\\main.vi',
      lv_version: '17.0',
      props: {},
    }));

    assert.strictEqual(parsed.viPath, 'C:\\path\\main.vi');
    assert.deepStrictEqual(parsed.props, {});
  });

  test('accepts compatible cache entries with an old cache version marker', () => {
    const parsed = parseCachedPropsJson(JSON.stringify({
      _cacheVersion: PROPS_CACHE_VERSION - 1,
      vi_path: 'C:\\path\\main.vi',
      lv_version: '17.0',
      props: {},
    }));

    assert.strictEqual(parsed.viPath, 'C:\\path\\main.vi');
    assert.deepStrictEqual(parsed.props, {});
  });

  test('rejects cache entries with an invalid cache version marker', () => {
    assert.throws(() => parseCachedPropsJson(JSON.stringify({
      _cacheVersion: 'legacy',
      vi_path: 'C:\\path\\main.vi',
      lv_version: '17.0',
      props: {},
    })));
  });

  test('merges refreshed static props, preserves cached values, and fills new entries as unread', () => {
    const merged = mergeStaticPropsIntoEnvelope(
      {
        viPath: 'C:\\old\\main.vi',
        lvVersion: '17.0',
        dynamicPropsLoaded: true,
        props: {
          Name: {
            ok: true,
            type: 'String',
            value: 'main.vi',
            error: null,
            loaded: true,
            writable: false,
            source: 'static',
            sourceLabel: '静态',
          },
          Description: {
            ok: true,
            type: 'String',
            value: 'cached description',
            error: null,
            loaded: true,
            writable: true,
            source: 'dynamic',
            sourceLabel: '动态',
          },
        },
      },
      {
        viPath: 'C:\\new\\renamed.vi',
        lvVersion: '17.0',
        dynamicPropsLoaded: false,
        props: {
          Name: {
            ok: true,
            type: 'String',
            value: 'renamed.vi',
            error: null,
            loaded: true,
            writable: false,
            source: 'static',
            sourceLabel: '静态',
          },
          Path: {
            ok: true,
            type: 'String',
            value: 'C:\\new\\renamed.vi',
            error: null,
            loaded: true,
            writable: false,
            source: 'static',
            sourceLabel: '静态',
          },
          Description: {
            ok: true,
            type: 'String',
            value: null,
            error: null,
            loaded: false,
            writable: true,
            source: 'dynamic',
            sourceLabel: '动态',
          },
          RevisionNumber: {
            ok: true,
            type: 'String',
            value: null,
            error: null,
            loaded: false,
            writable: true,
            source: 'dynamic',
            sourceLabel: '动态',
          },
          SavedVersion: {
            ok: true,
            type: 'String',
            value: '17.0',
            error: null,
            loaded: true,
            writable: false,
            source: 'static',
            sourceLabel: '静态',
          },
        },
      },
    );

    assert.strictEqual(merged.viPath, 'C:\\new\\renamed.vi');
    assert.strictEqual(merged.dynamicPropsLoaded, true);
    assert.deepStrictEqual(Object.keys(merged.props), ['Name', 'Path', 'Description', 'RevisionNumber', 'SavedVersion']);
    assert.strictEqual(merged.props['Name'].value, 'renamed.vi');
    assert.strictEqual(merged.props['Path'].value, 'C:\\new\\renamed.vi');
    assert.strictEqual(merged.props['SavedVersion'].value, '17.0');
    assert.strictEqual(merged.props['Description'].value, 'cached description');
    assert.strictEqual(merged.props['Description'].loaded, true);
    assert.strictEqual(merged.props['RevisionNumber'].loaded, false);
    assert.strictEqual(merged.props['RevisionNumber'].value, null);
  });

  test('merges write results without dropping untouched props', () => {
    const merged = mergeUpdatedPropsIntoEnvelope(
      {
        viPath: 'C:\\main.vi',
        lvVersion: '25.0',
        dynamicPropsLoaded: true,
        props: {
          Name: {
            ok: true,
            type: 'String',
            value: 'main.vi',
            error: null,
            loaded: true,
            writable: false,
            source: 'static',
            sourceLabel: '静态',
          },
          Description: {
            ok: true,
            type: 'String',
            value: 'old description',
            error: null,
            loaded: true,
            writable: true,
            source: 'dynamic',
            sourceLabel: '动态',
          },
          FPWinTitle: {
            ok: true,
            type: 'String',
            value: 'kept title',
            error: null,
            loaded: true,
            writable: true,
            source: 'dynamic',
            sourceLabel: '动态',
          },
        },
      },
      {
        viPath: 'C:\\main.vi',
        lvVersion: '25.3.2f2',
        dynamicPropsLoaded: true,
        saved: true,
        saveError: '',
        props: {
          Description: {
            ok: true,
            type: 'String',
            value: 'new description',
            error: null,
            loaded: true,
            writable: true,
            source: 'dynamic',
            sourceLabel: '动态',
          },
        },
      },
    );

    assert.strictEqual(merged.saved, true);
    assert.strictEqual(merged.saveError, '');
    assert.strictEqual(merged.lvVersion, '25.3.2f2');
    assert.strictEqual(merged.props['Description'].value, 'new description');
    assert.strictEqual(merged.props['FPWinTitle'].value, 'kept title');
    assert.strictEqual(merged.props['Name'].value, 'main.vi');
  });
});
