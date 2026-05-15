import type { PropAccess, PropEntry, PropSource, PropType } from './propsParser';

export type PropGroup = 'general' | 'execution' | 'panel' | 'memory';

interface PropDefinition {
  type: PropType;
  access: PropAccess;
  writable: boolean;
  description: string;
  displayName: string;
  group: PropGroup;
  source: PropSource;
}

export const PROP_GROUP_LABELS: Record<PropGroup, string> = {
  general: '通用信息',
  execution: '行为与执行控制',
  panel: '前面板窗口外观与行为',
  memory: '内部结构与内存信息',
};

export const PROP_SOURCE_LABELS: Record<PropSource, string> = {
  static: '静态',
  dynamic: '动态',
};

export const PROP_SOURCE_DESCRIPTIONS: Record<PropSource, string> = {
  static: '静态属性：可直接离线读取，不需要启动 LabVIEW。',
  dynamic: '动态属性：需要通过 LabVIEW VI Server 读取，按需加载时可能触发 LabVIEW 窗口。',
};

function defineProp(
  type: PropType,
  access: PropAccess,
  displayName: string,
  description: string,
  group: PropGroup,
  source: PropSource = 'dynamic',
): PropDefinition {
  return {
    type,
    access,
    writable: access !== 'readonly',
    displayName,
    description,
    group,
    source,
  };
}

export const PROP_DEFINITIONS: Record<string, PropDefinition> = {
  Name: defineProp('String', 'readonly', '名称', 'VI 文件名。', 'general', 'static'),
  Path: defineProp('String', 'readonly', '路径', 'VI 文件完整路径。', 'general', 'static'),
  OwningApp: defineProp('String', 'readonly', '所属应用', '拥有该 VI 的 Application 对象摘要。', 'general'),
  VIType: defineProp('Number', 'readonly', 'VI 类型', 'VI 类型枚举值，例如标准 VI、全局 VI 等。', 'general'),
  Description: defineProp('String', 'readwrite', '说明', 'VI 的描述信息。', 'general'),
  RevisionNumber: defineProp('String', 'readonly', '修订版本号', '当前 VI 的修订版本号。', 'general'),
  SavedVersion: defineProp('String', 'readonly', '侦测到的VI版本', '从 VI 文件头侦测到的保存版本，不通过 COM 读取。', 'general', 'static'),

  EditMode: defineProp('Boolean', 'readwrite', '编辑模式', '设置 VI 打开时为编辑模式或运行模式。', 'execution'),
  ExecState: defineProp('Number', 'readonly', '执行状态', 'VI 当前的执行状态枚举值。', 'execution'),
  RunOnOpen: defineProp('Boolean', 'readwrite', '打开时运行', '设置 VI 打开时是否自动运行。', 'execution'),
  PreferredExecSystem: defineProp('Number', 'readwrite', '首选执行系统', 'VI 运行的首选执行系统枚举值。', 'execution'),
  ShowFPOnCall: defineProp('Boolean', 'readwrite', '调用时显示前面板', '设置 VI 作为子 VI 被调用时是否显示前面板。', 'execution'),
  ShowFPOnLoad: defineProp('Boolean', 'readwrite', '加载时显示前面板', '设置 VI 加载时是否显示前面板。', 'execution'),
  AllowDebugging: defineProp('Boolean', 'readwrite', '允许调试', '设置是否允许对该 VI 进行调试。', 'execution'),
  IsReentrant: defineProp('Boolean', 'readwrite', '可重入', '指示或设置 VI 是否可重入。', 'execution'),
  ReentrancyType: defineProp('Number', 'readwrite', '重入类型', '可重入 VI 的重入类型枚举值。', 'execution'),
  CloseFPAfterCall: defineProp('Boolean', 'readwrite', '调用后关闭前面板', '设置 VI 运行后是否自动关闭前面板。', 'execution'),

  FPState: defineProp('Number', 'readonly', '前面板状态', '前面板窗口状态枚举值，例如标准、最小化、隐藏。', 'panel'),
  FPWinBounds: defineProp('String', 'readonly', '前面板窗口边界', '前面板窗口边界坐标，格式为 left,top,right,bottom。', 'panel'),
  FPWinTitle: defineProp('String', 'readwrite', '前面板窗口标题', '前面板窗口标题栏文字。', 'panel'),
  FPRunTransparently: defineProp('Boolean', 'readwrite', '透明运行', '设置 VI 运行时窗口是否透明。', 'panel'),
  FPTransparency: defineProp('Number', 'readwrite', '窗口透明度', '设置窗口透明度级别，范围通常为 0-100。', 'panel'),
  FPResizable: defineProp('Boolean', 'readwrite', '允许调整窗口大小', '设置运行时用户是否可以调整前面板窗口大小。', 'panel'),
  FPMinimizable: defineProp('Boolean', 'readwrite', '允许最小化', '设置运行时用户是否可以最小化前面板窗口。', 'panel'),
  FPShowMenuBar: defineProp('Boolean', 'readwrite', '显示菜单栏', '设置运行时是否显示菜单栏。', 'panel'),
  TBVisible: defineProp('Boolean', 'readwrite', '显示工具栏', '设置运行时是否显示工具栏。', 'panel'),
  TBShowRunButton: defineProp('Boolean', 'readwrite', '显示运行按钮', '设置运行时是否显示运行按钮。', 'panel'),
  TBShowAbortButton: defineProp('Boolean', 'readwrite', '显示中止按钮', '设置运行时是否显示中止按钮。', 'panel'),
  FPWinIsFrontMost: defineProp('Boolean', 'writeonly', '前面板置顶', '只写属性；将该 VI 的前面板窗口置于最前。', 'panel'),
  FPWinClosable: defineProp('Boolean', 'readwrite', '允许关闭窗口', '设置前面板关闭按钮是否可用。', 'panel'),

  BDSize: defineProp('Number', 'readonly', '程序框图大小', 'VI 程序框图占用大小，单位为字节。', 'memory'),
  FPSize: defineProp('Number', 'readonly', '前面板大小', 'VI 前面板占用大小，单位为字节。', 'memory'),
  CodeSize: defineProp('Number', 'readonly', '代码大小', 'VI 代码占用内存量，单位为字节。', 'memory'),
  DataSize: defineProp('Number', 'readonly', '数据大小', 'VI 数据占用内存量，单位为字节。', 'memory'),
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
  includeUnloadedDynamic?: boolean;
  savedVersion?: string | null;
}

function buildSavedVersionEntry(savedVersion: string): PropEntry {
  const definition = PROP_DEFINITIONS['SavedVersion'];
  return {
    ok: true,
    type: definition.type,
    value: savedVersion,
    error: null,
    loaded: true,
    writable: definition.writable,
    accessMode: definition.access,
    description: definition.description,
    displayName: definition.displayName,
    group: definition.group,
    groupLabel: PROP_GROUP_LABELS[definition.group],
    source: definition.source,
    sourceLabel: PROP_SOURCE_LABELS[definition.source],
    sourceDescription: PROP_SOURCE_DESCRIPTIONS[definition.source],
  };
}

function buildUnloadedDynamicEntry(definition: PropDefinition): PropEntry {
  return {
    ok: true,
    type: definition.type,
    value: null,
    error: null,
    loaded: false,
    writable: definition.writable,
    accessMode: definition.access,
    description: definition.description,
    displayName: definition.displayName,
    group: definition.group,
    groupLabel: PROP_GROUP_LABELS[definition.group],
    source: definition.source,
    sourceLabel: PROP_SOURCE_LABELS[definition.source],
    sourceDescription: PROP_SOURCE_DESCRIPTIONS[definition.source],
  };
}

function buildWriteOnlyEntry(definition: PropDefinition): PropEntry {
  return {
    ok: true,
    type: definition.type,
    value: null,
    error: null,
    loaded: true,
    writable: definition.writable,
    accessMode: definition.access,
    description: definition.description,
    displayName: definition.displayName,
    group: definition.group,
    groupLabel: PROP_GROUP_LABELS[definition.group],
    source: definition.source,
    sourceLabel: PROP_SOURCE_LABELS[definition.source],
    sourceDescription: PROP_SOURCE_DESCRIPTIONS[definition.source],
  };
}

export function decorateProps(
  rawProps: Record<string, PropEntry>,
  options: DecoratePropsOptions = {},
): Record<string, PropEntry> {
  const includeUnavailable = options.includeUnavailable === true;
  const includeUnloadedDynamic = options.includeUnloadedDynamic === true;
  const decorated: Record<string, PropEntry> = {};
  const savedVersion = options.savedVersion?.trim();

  for (const name of PROP_ORDER) {
    if (name === 'SavedVersion') {
      if (savedVersion) {
        decorated[name] = buildSavedVersionEntry(savedVersion);
      }
      continue;
    }
    const definition = PROP_DEFINITIONS[name];
    const raw = rawProps[name];
    if (!raw) {
      if (definition.access === 'writeonly') {
        decorated[name] = buildWriteOnlyEntry(definition);
        continue;
      }
      if (includeUnloadedDynamic && definition.source === 'dynamic') {
        decorated[name] = buildUnloadedDynamicEntry(definition);
      }
      continue;
    }
    const loaded = raw.loaded ?? true;
    if (!includeUnavailable && loaded && !raw.ok) {
      continue;
    }
    decorated[name] = {
      ...raw,
      type: raw.type || definition.type,
      loaded,
      writable: definition.writable,
      accessMode: raw.accessMode ?? definition.access,
      description: definition.description,
      displayName: definition.displayName,
      group: definition.group,
      groupLabel: PROP_GROUP_LABELS[definition.group],
      source: raw.source ?? definition.source,
      sourceLabel: raw.sourceLabel ?? PROP_SOURCE_LABELS[definition.source],
      sourceDescription: raw.sourceDescription ?? PROP_SOURCE_DESCRIPTIONS[definition.source],
    };
  }

  for (const [name, raw] of Object.entries(rawProps)) {
    if (name in decorated) {
      continue;
    }
    if (!includeUnavailable && (raw.loaded ?? true) && !raw.ok) {
      continue;
    }
    decorated[name] = raw;
  }

  return decorated;
}