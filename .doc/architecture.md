# 架构说明

本文档描述 **LabVIEW VI Support** 扩展的整体架构、核心模块职责、数据流与关键设计决策。

---

## 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        VS Code 扩展宿主                       │
│                                                               │
│  ┌──────────────┐    ┌──────────────────────────────────┐    │
│  │  extension.ts │    │   LabVIEWVersionStatusController  │    │
│  │  (激活入口)   │    │   (状态栏 UI + 版本选择)          │    │
│  └──────┬───────┘    └──────────────┬───────────────────┘    │
│         │                           │                         │
│         │            ┌──────────────▼───────────────────┐    │
│         │            │      labviewVersionResolver.ts    │    │
│         │            │   (目录标记 / lvproj / VI 文件头) │    │
│         │            └──────────────────────────────────┘    │
│         │                                                     │
│         ▼                                                     │
│  ┌──────────────────────────────────────────────────────┐    │
│  │               ViEditorProvider                        │    │
│  │        (自定义编辑器宿主 + WebView 管理)               │    │
│  │                                                        │    │
│  │   ┌──────────────┐    ┌────────────────────────────┐  │    │
│  │   │   ViCache    │    │     labviewRuntime.ts       │  │    │
│  │   │ (MD5 缓存)   │    │  (Worker 调用 + 版本探测)   │  │    │
│  │   └──────────────┘    └──────────┬─────────────────┘  │    │
│  └──────────────────────────────────┼────────────────────┘    │
│                                     │                         │
└─────────────────────────────────────┼─────────────────────────┘
                                      │ spawn cscript.exe
                                      ▼
                         ┌────────────────────────┐
                         │   Windows Script Host   │
                         │  workers/*.vbs          │
                         │  (VBScript + COM)       │
                         └──────────┬─────────────┘
                                    │ ActiveX/COM
                                    ▼
                         ┌────────────────────────┐
                         │     LabVIEW COM API     │
                         │  (VI Server / ActiveX) │
                         └────────────────────────┘
```

---

## 核心模块说明

### `src/extension.ts` — 扩展入口

- 在扩展激活时完成以下初始化：
  - 注册 `ViEditorProvider`（自定义编辑器）。
  - 创建 `LabVIEWVersionStatusController`（状态栏）。
  - 注册命令：`configureLabVIEWVersion`、`openCacheDirectory`、`clearCache`、`helloWorld`。
  - 同步缓存目录配置（`syncCacheDirectorySetting`）。
- 监听 `onDidChangeActiveTextEditor` 和 `onDidChangeWorkspaceFolders` 以刷新状态栏。

---

### `src/labviewVersionStatus.ts` — 状态栏控制器

**职责**：状态栏 UI 显示 + 版本选择交互。

- `LabVIEWVersionStatusController`：
  - 持有状态栏项（`vscode.StatusBarItem`），在激活资源变更时触发 `refresh()`。
  - `refresh()`：并发查询项目版本（`resolveDirectoryLabVIEWVersion`）、活动 VI 版本（`resolveLabVIEWVersionForPath`）和已安装版本列表（`discoverInstalledLabVIEWs`），并根据结果更新状态栏文本、提示和背景色。
  - `configureVersion()`：弹出 QuickPick 列表，允许用户为项目根目录写入或清除目录标记文件。
- `buildStatusPresentation()`：纯函数，根据输入状态生成状态栏显示文本和提示文字（可单元测试）。

---

### `src/scripts/labviewStatusPresentation.ts` — 状态栏文案生成

**职责**：集中管理状态栏展示文案、提示文本和 QuickPick 辅助文本，保持 `labviewVersionStatus.ts` 只负责 VS Code 交互。

- `buildStatusPresentation()`：根据项目版本、活动 VI 版本与已安装版本生成状态栏显示结果。
- `buildPickDetail()`：生成版本选择列表的附加说明。
- `buildQuickPickPlaceholder()`：生成 QuickPick 占位提示文案。

---

### `src/scripts/labviewVersionResolver.ts` — 版本解析器

**职责**：无副作用的版本解析逻辑（不依赖 `vscode`，可单元测试）。

| 导出函数 | 说明 |
|---|---|
| `resolveLabVIEWVersionForPath` | 对给定 VI 文件路径，按优先级（目录标记 → lvproj → VI 文件头）解析版本 |
| `resolveDirectoryLabVIEWVersion` | 对给定目录路径，解析目录标记或 lvproj 版本 |
| `parseDirectoryMarkerFileName` | 解析目录标记文件名，返回版本号和架构 |
| `parseLvprojVersion` | 从 `.lvproj` XML 文本中解析版本号 |
| `buildDirectoryMarkerFileName` | 生成规范的目录标记文件名 |
| `writeDirectoryLabVIEWMarker` | 写入目录标记文件（同时清理旧标记） |
| `clearDirectoryLabVIEWMarkers` | 删除指定目录下的全部标记文件 |
| `formatLabVIEWDisplayName` | 生成用于显示的版本名称字符串 |

**版本解析优先级**（由高到低）：

1. 目录标记文件：`DEV ENVIRONMENT LabVIEW <year|version>[(<arch>)]`
2. `.lvproj` XML 中的 `LVVersion` 属性
3. VI 文件头中的 BCD 编码版本字节

---

### `src/scripts/labviewRuntime.ts` — 运行时调用层

**职责**：封装所有需要启动外部进程（`cscript.exe`）的操作，以及 VI 文件头读取和已安装版本探测。

主要导出：

| 导出 | 说明 |
|---|---|
| `readViSavedVersion` | 读取 VI 文件头中的保存版本（异步，不依赖 LabVIEW） |
| `parseViSavedVersionHeader` | 解析 VI 文件头 Buffer，返回版本号（同步，可测试） |
| `discoverInstalledLabVIEWs` | 通过 PowerShell 查询注册表，枚举本机已安装的 LabVIEW 版本 |
| `exportViImages` | 调用 `save_vi_panel_image_worker.vbs` 导出 FP / BD 图像 |
| `readViProps` | 调用 `read_vi_props_worker.vbs` 读取 VI 属性 |
| `writeViProps` | 调用 `write_vi_props_worker.vbs` 写入 VI 属性 |

**Worker 调用机制**：

1. TypeScript 层通过 `child_process.spawn` 启动 `cscript.exe`，传入 `.vbs` Worker 脚本路径和参数。
2. Worker 输出结果写入临时文件（键值行格式）。
3. TypeScript 层读取临时文件并通过 `parsePropsResponseText`（`propsParser.ts`）解析结果。
4. 结果组装为 JSON 信封后通过 `postMessage` 发送给 WebView。

---

### `src/scripts/propsParser.ts` — 响应解析器

**职责**：解析 Worker 输出的键值行格式响应文件，以及 JSON 信封的序列化 / 反序列化。

- `parsePropsResponseText(text)`：将 `read_vi_props_worker.vbs` / `write_vi_props_worker.vbs` 输出的文本解析为 `PropsResponse` 对象。字符串值以 Base64 UTF-8 编码传输，在此解码。
- `parsePropsJson(jsonText)` / `toCachedPropsJson(envelope)`：JSON 信封的读写（用于缓存层和 WebView 通信）。
- `parseCachedPropsJson(jsonText)`：带版本号校验的缓存 JSON 读取（版本不符时直接抛出，强制重新加载）。
- `mergeStaticPropsIntoEnvelope`：将静态属性（文件头读取的 `SavedVersion` 等）合并进缓存的动态属性信封，防止静态属性因缓存而过时。

---

### `src/scripts/propMetadata.ts` — 属性元数据

**职责**：集中定义 VI 属性的显示名称、类型、分组、可写性和来源标签。

- `PROP_DEFINITIONS`：所有已知 VI 属性的元数据字典。
- `WRITABLE_PROP_TYPES`：可写属性名 → 类型的映射（供写 Worker 调用时使用）。
- `decorateProps(rawProps, options)`：将 Worker 返回的原始属性列表与元数据合并，补充显示名称、分组、可写性等信息；支持过滤不可用属性和未加载的动态属性。

---

### `src/cache/viCache.ts` — MD5 缓存

**职责**：以 VI 文件内容 MD5 为键的内容寻址缓存，存储图像和属性 JSON。

- 缓存目录结构：`<root>/<md5>/`，其中包含 `fp.png`、`bd.png`、`props.json`、`meta.json`。
- `entryForFile(viPath)`：计算 VI 文件 MD5，返回对应的缓存条目（不触发磁盘读写）。
- `ensureEntry(entry, viPath)`：创建缓存目录并写入 `meta.json`；如果同一哈希对应的 VI 路径变更（文件被复制），返回 `{ pathChanged: true }`，触发 Props 缓存失效。
- `invalidate(hash)`：删除缓存条目目录。

---

### `src/cache/cacheDirectory.ts` — 缓存目录管理

**职责**：确保缓存根目录存在，以及清理全部缓存。

- `ensureCacheRoot(path)`：若目录不存在则创建。
- `clearCacheRoot(path)`：删除并重建缓存根目录。
- `shouldSyncCacheDirectory(current, actual)`：判断配置项是否需要同步（避免无谓的配置写入）。

---

### `src/editor/viEditorProvider.ts` — 自定义编辑器宿主

**职责**：编排缓存查询、脚本调用和 WebView 消息通信，是扩展的业务核心。

- 实现 `vscode.CustomEditorProvider` 接口。
- 打开 VI 文件时：
  1. 查询缓存（`ViCache.entryForFile`）。
  2. 优先准备静态属性（文件名、路径、保存版本），无需连接 LabVIEW。
  3. 仅在视图模式包含预览区域时，才按需导出 FP / BD 图像。
  4. 用户点击“读取动态属性”或执行强制刷新时，再调用 `readViProps` 拉取动态属性。
- 处理 WebView 消息：
  - `reload`：触发强制刷新，可重读图像与已加载的动态属性。
  - `loadDynamicProps`：单独触发动态属性读取。
  - `saveProps`：调用 `writeViProps`，写回 VI 后重新计算 MD5 并更新缓存。

---

### `workers/*.vbs` — VBScript Worker

**职责**：在 Windows Script Host 环境中通过 LabVIEW COM/ActiveX 接口与 LabVIEW 通信。

| Worker 文件 | 功能 |
|---|---|
| `read_vi_props_worker.vbs` | 启动 / 连接 LabVIEW，读取指定 VI 的属性集，输出键值行文件 |
| `write_vi_props_worker.vbs` | 启动 / 连接 LabVIEW，将指定属性集写回 VI 并保存，输出键值行文件 |
| `save_vi_panel_image_worker.vbs` | 启动 / 连接 LabVIEW，导出 VI 的前面板和程序框图图像到指定路径 |

**输出格式**（键值行）：

```
ok=1
selection=<ascii>
reason_b64=<base64-utf8>
connected_version_b64=<base64-utf8>
connected_directory_b64=<base64-utf8>
attempts=<int>
prop_<Name>_type=String|Boolean|Number
prop_<Name>_ok=1|0
prop_<Name>_val=<base64-utf8>
prop_<Name>_errmsg=<base64-utf8>
```

字符串值统一以 Base64 UTF-8 编码，避免换行和特殊字符问题。

---

## 数据流

### 打开 VI 文件（首次，缓存未命中）

```
VS Code 打开 .vi 文件
        │
        ▼
ViEditorProvider.openCustomDocument()
        │ 计算 MD5
        ▼
ViCache.entryForFile()             ← 缓存未命中
        │
        ▼
labviewRuntime.readStaticViProps() ← 先构造静态属性
        │
        ▼
ViCache.writeProps()               ← 写入静态属性缓存
        │
        ▼
WebView.postMessage(propsJson)
        │
        ├── 视图包含预览时
        │        ▼
        │ labviewRuntime.exportViPanelImages()
        │        ▼
        │ WebView.postMessage(imagePaths)
        │
        └── 用户读取动态属性时
                 ▼
         labviewRuntime.readViProps()
                 ▼
         propsParser.parsePropsResponseText()
                 ▼
         propMetadata.decorateProps()
                 ▼
         ViCache.writeProps()      ← 更新为动态属性版本
```

### 打开 VI 文件（再次打开，缓存命中）

```
VS Code 打开 .vi 文件
        │
        ▼
ViEditorProvider.openCustomDocument()
        │ 计算 MD5
        ▼
ViCache.entryForFile()          ← 缓存命中
        │
        ▼
ViCache.readProps()             ← 直接读取缓存（静态或动态）
        │
        ▼
WebView.postMessage(propsJson, imagePaths)
```

---

## 缓存机制

缓存采用**内容寻址**设计：

- **缓存键**：VI 文件字节内容的 MD5 哈希。
- **优点**：VI 内容不变时无论路径如何变更，缓存始终命中；VI 内容改变后自动生成新条目。
- **副作用**：旧条目不会自动清理（磁盘空间随版本积累增长），用户可通过 **清理缓存** 命令手动清除。

缓存目录默认位于 VS Code 全局存储路径（`context.globalStorageUri.fsPath`）下的 `vi-cache/` 子目录，并同步写入 `labview-vi-support.cacheDirectory` 配置项，方便用户查看。

---

## 已知约束与设计决策

| 约束 | 原因 |
|---|---|
| 仅支持 Windows | 底层依赖 LabVIEW COM/ActiveX 接口，该接口仅在 Windows 上可用 |
| 不依赖 Python | 当前运行时全部通过 TypeScript + VBScript 实现；`prototype/` 中的 Python 脚本仅为研究用途 |
| 版本严格匹配 | 目录标记或 lvproj 指定版本未安装时动态操作直接失败，避免误连错误的 LabVIEW 实例 |
| 缓存版本号 | `propsParser.ts` 中的 `PROPS_CACHE_VERSION` 常量在缓存结构变更时递增，强制旧缓存失效 |
| 静态属性合并 | 每次打开 VI 时都会重新合并静态属性（`SavedVersion` 等），防止缓存导致静态信息过时 |
| 动态属性按需读取 | 默认先展示静态属性，避免首次打开即强依赖 LabVIEW 运行时，提高非预览场景响应速度 |
