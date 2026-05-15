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
│  │  ViEditorProvider  (WebView 初始化 / 视图模式)        │    │
│  │     └── ViEditorSession (缓存编排 / 消息收发)         │    │
│  │                                                        │    │
│  │   ┌──────────────┐    ┌────────────────────────────┐  │    │
│  │   │   ViCache    │    │  labviewRuntime.ts (barrel) │  │    │
│  │   │ (MD5 缓存)   │    │  ├─ workerInvoker.ts        │  │    │
│  │   └──────────────┘    │  ├─ installedLabview.ts     │  │    │
│  │                        │  └─ viPropsRuntime.ts       │  │    │
│  └───────────────────────└────────────┬────────────────┘    │
│                                       │                      │
└───────────────────────────────────────┼──────────────────────┘
                                        │ stdin/stdout (session host)
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

---

### `src/scripts/labviewStatusPresentation.ts` — 状态栏文案生成

**职责**：集中管理状态栏展示文案、提示文本和 QuickPick 辅助文本，保持 `labviewVersionStatus.ts` 只负责 VS Code 交互。

- `buildStatusPresentation()`：根据项目版本、活动 VI 版本与已安装版本生成状态栏显示结果（纯函数，可单元测试）。
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

### `src/scripts/scriptPaths.ts` — 脚本路径与解释器选择

**职责**：定位 worker 脚本文件路径，以及选择合适的 `cscript.exe` 解释器。

- `resolveScriptPaths(extensionRoot)`：返回 `ScriptPaths`，包含所有 worker 文件的绝对路径。
- `selectScriptHost(architecture)`：根据目标 LabVIEW 的位宽选择 `System32` 或 `SysWOW64` 下的 `cscript.exe`。

---

### `src/scripts/labviewRuntime.ts` — barrel re-export

**职责**：统一重新导出 `runtime/` 子目录的所有公开符号，保持现有 import 路径兼容。调用方无需感知底层的拆分结构。

---

### `src/scripts/runtime/workerInvoker.ts` — 子进程调用工具

**职责**：封装 `child_process.spawn` + 超时控制，为需要启动外部命令的上层模块提供统一接口。

- `runCommand(command, args, options)`：启动子进程，捕获 stdout/stderr，支持超时。
- `delay(timeoutMs)`：简单延时 Promise，供重试逻辑使用。

---

### `src/scripts/runtime/installedLabview.ts` — 安装版本探测

**职责**：通过 PowerShell 查询注册表，枚举本机已安装的 LabVIEW 版本，并读取 PE 头确认位宽。

- `discoverInstalledLabVIEWs(options)`：枚举已安装版本，结果带模块级缓存（支持 `refresh` 强制刷新）。
- `buildInstalledLabVIEWDiscoveryScript()`：生成 PowerShell 发现脚本（可单元测试）。
- `selectInstalledLabVIEW(installations, major, minor, arch)`：从安装列表中挑选最匹配的版本。

---

### `src/scripts/runtime/viPropsRuntime.ts` — VI 级运行时操作

**职责**：封装所有需要通过 LabVIEW COM/ActiveX 读写 VI 属性或导出预览图像的函数，以及 VI 文件头离线解析。

| 导出 | 说明 |
|---|---|
| `readViSavedVersion` | 读取 VI 文件头中的保存版本（异步，不依赖 LabVIEW） |
| `parseViSavedVersionHeader` | 解析 VI 文件头 Buffer，返回版本号（同步，可测试） |
| `exportViPanelImages` | 调用 session host 导出 FP / BD 图像 |
| `readViProps` | 通过 session host 读取 VI 属性 |
| `writeViProps` | 通过 session host 写入 VI 属性 |
| `readStaticViProps` | 离线读取静态属性（不启动 LabVIEW） |
| `hasReusableLabVIEWConnection` | 探测现有 LabVIEW session 是否可复用 |
| `normalizePropsEnvelope` | 修正属性信封中的已知数据异常（如 IsReentrant/ReentrancyType） |

---

### `src/scripts/propsParser.ts` — 响应解析器

**职责**：解析 Worker 输出的键值行格式响应文件，以及 JSON 信封的序列化 / 反序列化。

- `parsePropsResponseText(text)`：将 session host 输出的文本解析为 `PropsResponse` 对象。字符串值以 Base64 UTF-8 编码传输，在此解码。
- `decodeBase64Utf8(value)`：Base64 解码工具（已导出，供 `viPropsRuntime.ts` 复用）。
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

**职责**：实现 `vscode.CustomReadonlyEditorProvider` 接口，管理文档生命周期、WebView 初始化和视图模式配置。

- `ViEditorProvider.register(context, hooks)`：注册编辑器并监听视图模式配置变更。
- `resolveCustomEditor(document, webviewPanel, token)`：创建 `ViEditorSession`，挂接消息监听和面板生命周期事件。
- `renderHtml(webview)`：读取 HTML 模板，注入 CSP、nonce、初始属性 JSON 与表格行。

---

### `src/editor/viEditorSession.ts` — 编辑器会话

**职责**：单个 VI 编辑器会话，编排缓存查询、静态/动态属性加载、预览图导出和 WebView 消息收发。

- 实现串行加载队列（`_loadChain`），避免 `initialize` + `ready` 并发触发。
- 处理 WebView 消息：`ready`、`reload`、`loadDynamicProps`、`setViewMode`、`saveProps`。
- 监听文件系统变更（`FileSystemWatcher`），收敛去抖后自动重载。
- 打开 VI 文件时：
  1. 查询缓存（`ViCache.entryForFile`）。
  2. 优先准备静态属性（文件名、路径、保存版本），无需连接 LabVIEW。
  3. 仅在视图模式包含预览区域时，才按需导出 FP / BD 图像。
  4. 用户点击"读取动态属性"或执行强制刷新时，再调用 `readViProps` 拉取动态属性。

---

### `src/editor/viWebviewHtml.ts` — HTML 渲染工具

**职责**：提供纯函数 HTML 渲染工具，不依赖 `vscode`，可单元测试。

- `escapeHtml(value)`：HTML 特殊字符转义。
- `formatPropTypeForHtml(type)`：属性类型枚举转界面显示标签。
- `renderInitialPropsTableRows()`：生成属性表格初始加载占位行 HTML。

---

### `src/editor/viWebviewProtocol.ts` — WebView 消息协议

**职责**：集中定义 WebView 与扩展宿主之间的消息类型约定。

- `InboundMessage`：从 WebView 发往扩展宿主的消息结构。
- `OutboundState`：从扩展宿主推送给 WebView 的完整状态快照。

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
