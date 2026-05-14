/**
 * 解析以下两个 worker 输出的响应文件：
 *   - read_vi_props_worker.vbs
 *   - write_vi_props_worker.vbs
 *
 * 二者共用同一种 `key=value` 行格式：
 *
 *   ok=1|0
 *   selection=<ascii>
 *   reason_b64=<base64-utf8>
 *   connected_version_b64=<base64-utf8>
 *   connected_directory_b64=<base64-utf8>
 *   attempts=<int>
 *   saved=1|0                       (仅写 worker)
 *   save_errmsg_b64=<base64-utf8>   (仅写 worker，且 saved=0 时)
 *   prop_<Name>_type=String|Boolean|Number
 *   prop_<Name>_ok=1|0
 *   prop_<Name>_val=<base64-utf8>     (ok=1)
 *   prop_<Name>_errmsg=<base64-utf8>  (ok=0)
 *
 * 实际运行时，read/write 的 Python 入口会把上述结果再以 JSON 输出到 stdout，
 * 因此本模块同时提供两种解析入口：
 *   1. `parsePropsResponseText` —— 直接解析原始响应文件；
 *   2. `parsePropsJson`         —— 校验 Python 包装层吐出的 JSON 信封，
 *                                  随后再喂给 WebView。
 */

export type PropType = 'String' | 'Boolean' | 'Number';
export type PropSource = 'static' | 'dynamic';

export interface PropEntry {
  ok: boolean;
  type: PropType | string;
  value: string | null;
  error: string | null;
  loaded?: boolean;
  /** Filled in by the runtime metadata layer. */
  writable?: boolean;
  description?: string;
  displayName?: string;
  group?: string;
  groupLabel?: string;
  source?: PropSource;
  sourceLabel?: string;
  sourceDescription?: string;
}

export interface PropsResponse {
  ok: boolean;
  selection: string;
  reason: string;
  connectedVersion: string;
  connectedDirectory: string;
  attempts: number;
  /** Present in write-worker responses. */
  saved?: boolean;
  saveError?: string;
  props: Record<string, PropEntry>;
}

function decodeBase64Utf8(value: string): string {
  if (!value) {
    return '';
  }
  // Strip a possible leading BOM (the read script does this too).
  return Buffer.from(value, 'base64').toString('utf-8').replace(/^\ufeff/, '');
}

export function parsePropsResponseText(text: string): PropsResponse {
  const raw: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/[\r\n]+$/, '');
    if (!line || !line.includes('=')) {
      continue;
    }
    const eq = line.indexOf('=');
    raw[line.slice(0, eq)] = line.slice(eq + 1);
  }

  const result: PropsResponse = {
    ok:                 raw['ok'] === '1',
    selection:          raw['selection'] ?? '',
    reason:             decodeBase64Utf8(raw['reason_b64'] ?? ''),
    connectedVersion:   decodeBase64Utf8(raw['connected_version_b64'] ?? ''),
    connectedDirectory: decodeBase64Utf8(raw['connected_directory_b64'] ?? ''),
    attempts:           parseInt(raw['attempts'] ?? '0', 10) || 0,
    props:              {},
  };

  if ('saved' in raw) {
    result.saved = raw['saved'] === '1';
  }
  if ('save_errmsg_b64' in raw) {
    result.saveError = decodeBase64Utf8(raw['save_errmsg_b64']);
  }

  for (const key of Object.keys(raw)) {
    if (!key.startsWith('prop_')) {
      continue;
    }
    const rest = key.slice(5);
    const lastUnderscore = rest.lastIndexOf('_');
    if (lastUnderscore < 0) {
      continue;
    }
    const propName = rest.slice(0, lastUnderscore);
    const suffix = rest.slice(lastUnderscore + 1);

    const entry = result.props[propName] ?? {
      ok: false, type: 'String' as PropType, value: null, error: null,
    };
    const value = raw[key];
    switch (suffix) {
      case 'type':   entry.type = value as PropType; break;
      case 'ok':     entry.ok = value === '1'; break;
      case 'val':    entry.value = decodeBase64Utf8(value); break;
      case 'errmsg': entry.error = decodeBase64Utf8(value); break;
      // unknown suffix → ignore (forward compat)
    }
    result.props[propName] = entry;
  }

  return result;
}

/**
 * Validate and normalize the JSON object emitted by the Python wrappers'
 * stdout. `read_vi_props.py --format json` returns:
 *
 *   { "vi_path": "...", "lv_version": "...", "props": { Name: PropEntry, ... } }
 *
 * `write_vi_props.py` returns:
 *
 *   { "vi_path": "...", "lv_version": "...", "saved": bool,
 *     "save_error": str, "props": { ... } }
 *
 * This function tolerates both shapes and returns a typed structure suitable
 * for the WebView.
 */
export interface PropsJsonEnvelope {
  viPath: string;
  lvVersion: string | null;
  dynamicPropsLoaded?: boolean;
  saved?: boolean;
  saveError?: string;
  props: Record<string, PropEntry>;
}

export const PROPS_CACHE_VERSION = 3;

export function toCachedPropsJson(envelope: PropsJsonEnvelope): Record<string, unknown> {
  const cached: Record<string, unknown> = {
    _cacheVersion: PROPS_CACHE_VERSION,
    vi_path: envelope.viPath,
    lv_version: envelope.lvVersion,
    dynamic_props_loaded: envelope.dynamicPropsLoaded === true,
    props: envelope.props,
  };
  if (typeof envelope.saved === 'boolean') {
    cached['saved'] = envelope.saved;
  }
  if (typeof envelope.saveError === 'string') {
    cached['save_error'] = envelope.saveError;
  }
  return cached;
}

export function parsePropsJson(jsonText: string): PropsJsonEnvelope {
  const parsed: unknown = JSON.parse(jsonText);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Props JSON must be an object.');
  }
  const obj = parsed as Record<string, unknown>;
  const propsObj = obj['props'];
  if (typeof propsObj !== 'object' || propsObj === null) {
    throw new Error('Props JSON missing "props" object.');
  }

  const props: Record<string, PropEntry> = {};
  for (const [name, raw] of Object.entries(propsObj as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    props[name] = {
      ok:          Boolean(entry['ok']),
      type:        (entry['type'] as PropType) ?? 'String',
      value:       (entry['value'] as string | null) ?? null,
      error:       (entry['error'] as string | null) ?? null,
      loaded:      typeof entry['loaded']      === 'boolean' ? entry['loaded']      as boolean : undefined,
      writable:    typeof entry['writable']    === 'boolean' ? entry['writable']    as boolean : undefined,
      description: typeof entry['description'] === 'string'  ? entry['description'] as string  : undefined,
      displayName: typeof entry['displayName'] === 'string'  ? entry['displayName'] as string  : undefined,
      group:       typeof entry['group']       === 'string'  ? entry['group']       as string  : undefined,
      groupLabel:  typeof entry['groupLabel']  === 'string'  ? entry['groupLabel']  as string  : undefined,
      source:      typeof entry['source']      === 'string'  ? entry['source']      as PropSource : undefined,
      sourceLabel: typeof entry['sourceLabel'] === 'string'  ? entry['sourceLabel'] as string  : undefined,
      sourceDescription: typeof entry['sourceDescription'] === 'string'
        ? entry['sourceDescription'] as string
        : undefined,
    };
  }

  const envelope: PropsJsonEnvelope = {
    viPath:    typeof obj['vi_path']    === 'string' ? (obj['vi_path']    as string) : '',
    lvVersion: typeof obj['lv_version'] === 'string' ? (obj['lv_version'] as string) : null,
    dynamicPropsLoaded: obj['dynamic_props_loaded'] === true,
    props,
  };
  if (typeof obj['saved'] === 'boolean') {
    envelope.saved = obj['saved'] as boolean;
  }
  if (typeof obj['save_error'] === 'string') {
    envelope.saveError = obj['save_error'] as string;
  }
  return envelope;
}

export function parseCachedPropsJson(jsonText: string): PropsJsonEnvelope {
  const parsed: unknown = JSON.parse(jsonText);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Cached props JSON must be an object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['_cacheVersion'] !== PROPS_CACHE_VERSION) {
    throw new Error(`Props cache version mismatch: expected ${PROPS_CACHE_VERSION}.`);
  }
  return parsePropsJson(jsonText);
}
