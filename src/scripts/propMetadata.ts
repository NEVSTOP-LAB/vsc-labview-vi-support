import type { PropEntry, PropType } from './propsParser';

export type PropGroup = 'identity' | 'execution' | 'panel';

interface PropDefinition {
  type: PropType;
  writable: boolean;
  description: string;
  displayName: string;
  group: PropGroup;
}

export const PROP_GROUP_LABELS: Record<PropGroup, string> = {
  identity: '基础信息',
  execution: '执行设置',
  panel: '前面板行为',
};

export const PROP_DEFINITIONS: Record<string, PropDefinition> = {
  Name: {
    type: 'String',
    writable: false,
    displayName: '文件名',
    description: 'VI 文件名（不含路径）',
    group: 'identity',
  },
  Path: {
    type: 'String',
    writable: false,
    displayName: '文件路径',
    description: 'VI 文件完整路径',
    group: 'identity',
  },
  SavedVersion: {
    type: 'String',
    writable: false,
    displayName: '保存版本',
    description: '从文件头解析的保存版本',
    group: 'identity',
  },
  Description: {
    type: 'String',
    writable: true,
    displayName: '说明',
    description: 'VI 描述（属性对话框中的说明文字）',
    group: 'identity',
  },
  HistoryText: {
    type: 'String',
    writable: true,
    displayName: '修订历史',
    description: '修订历史日志文本',
    group: 'identity',
  },
  AllowDebugging: {
    type: 'Boolean',
    writable: true,
    displayName: '允许调试',
    description: '允许调试',
    group: 'execution',
  },
  IsReentrant: {
    type: 'Boolean',
    writable: true,
    displayName: '允许重入',
    description: '是否允许重入执行',
    group: 'execution',
  },
  RunOnOpen: {
    type: 'Boolean',
    writable: true,
    displayName: '打开后运行',
    description: '打开后立即运行（常见于顶层 VI）',
    group: 'execution',
  },
  PreferredExecSystem: {
    type: 'Number',
    writable: true,
    displayName: '首选执行系统',
    description: '首选执行系统',
    group: 'execution',
  },
  ExecPriority: {
    type: 'Number',
    writable: true,
    displayName: '执行优先级',
    description: '执行优先级（VI Server 枚举值）',
    group: 'execution',
  },
  ShowFPOnCall: {
    type: 'Boolean',
    writable: true,
    displayName: '调用时显示前面板',
    description: '被调用时显示前面板',
    group: 'panel',
  },
  CloseFPAfterCall: {
    type: 'Boolean',
    writable: true,
    displayName: '调用后关闭前面板',
    description: '调用完毕后关闭前面板',
    group: 'panel',
  },
};

const PROP_ORDER = Object.freeze(Object.keys(PROP_DEFINITIONS));

export const WRITABLE_PROP_TYPES = Object.freeze(
  Object.fromEntries(
    Object.entries(PROP_DEFINITIONS)
      .filter(([, definition]) => definition.writable)
      .map(([name, definition]) => [name, definition.type]),
  ) as Record<string, PropType>,
);

interface DecoratePropsOptions {
  includeUnavailable?: boolean;
  savedVersion?: string | null;
}

function buildSavedVersionEntry(savedVersion: string): PropEntry {
  const definition = PROP_DEFINITIONS['SavedVersion'];
  return {
    ok: true,
    type: definition.type,
    value: savedVersion,
    error: null,
    writable: definition.writable,
    description: definition.description,
    displayName: definition.displayName,
    group: definition.group,
    groupLabel: PROP_GROUP_LABELS[definition.group],
  };
}

export function decorateProps(
  rawProps: Record<string, PropEntry>,
  options: DecoratePropsOptions = {},
): Record<string, PropEntry> {
  const includeUnavailable = options.includeUnavailable === true;
  const decorated: Record<string, PropEntry> = {};

  const savedVersion = options.savedVersion?.trim();
  if (savedVersion) {
    decorated['SavedVersion'] = buildSavedVersionEntry(savedVersion);
  }

  for (const name of PROP_ORDER) {
    if (name === 'SavedVersion') {
      continue;
    }
    const raw = rawProps[name];
    if (!raw) {
      continue;
    }
    if (!includeUnavailable && !raw.ok) {
      continue;
    }
    const definition = PROP_DEFINITIONS[name];
    decorated[name] = {
      ...raw,
      type: raw.type || definition.type,
      writable: definition.writable,
      description: definition.description,
      displayName: definition.displayName,
      group: definition.group,
      groupLabel: PROP_GROUP_LABELS[definition.group],
    };
  }

  for (const [name, raw] of Object.entries(rawProps)) {
    if (name in decorated) {
      continue;
    }
    if (!includeUnavailable && !raw.ok) {
      continue;
    }
    decorated[name] = raw;
  }

  return decorated;
}