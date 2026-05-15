# 仓库结构总览

本文档用于记录当前仓库的目录树、模块职责与整理重点，方便后续维护时快速定位代码与文档。

---

## 顶层目录树

```text
vsc-labview-vi-support/
├── .doc/
│   ├── CHANGELOG.md
│   ├── CONTRIBUTING.md
│   ├── README.md
│   ├── architecture.md
│   ├── repository-map.md
│   └── testing.md
├── .github/
│   ├── hooks/
│   └── workflows/
├── .vscode/
├── images/
├── media/
│   └── webview/
├── prototype/
│   ├── scripts/
│   └── vi/
├── scripts/
├── src/
│   ├── cache/
│   │   ├── cacheDirectory.ts
│   │   └── viCache.ts
│   ├── editor/
│   │   ├── viEditorProvider.ts
│   │   ├── viEditorSession.ts
│   │   ├── viWebviewHtml.ts
│   │   ├── viWebviewProtocol.ts
│   │   └── viewMode.ts
│   ├── scripts/
│   │   ├── runtime/
│   │   │   ├── installedLabview.ts
│   │   │   ├── viPropsRuntime.ts
│   │   │   └── workerInvoker.ts
│   │   ├── labviewAutomationGate.ts
│   │   ├── labviewRuntime.ts        ← barrel re-export
│   │   ├── labviewSession.ts
│   │   ├── labviewStatusPresentation.ts
│   │   ├── labviewVersionResolver.ts
│   │   ├── propMetadata.ts
│   │   ├── propsParser.ts
│   │   └── scriptPaths.ts
│   ├── test/
│   │   └── unit/
│   ├── extension.ts
│   └── labviewVersionStatus.ts
├── workers/
├── .gitignore
├── .vscode-test.mjs
├── .vscodeignore
├── AGENTS.md
├── README.md
├── esbuild.js
├── eslint.config.mjs
├── package-lock.json
├── package.json
├── package.nls.json
├── package.nls.zh-cn.json
└── tsconfig.json
```

---

## 主要模块

### `src/`

- `extension.ts`：扩展入口，负责注册自定义编辑器、状态栏与命令。
- `labviewVersionStatus.ts`：状态栏展示、版本扫描结果汇总、项目版本配置入口。
- `cache/`：VI 内容哈希缓存目录与缓存条目管理。
- `editor/`：自定义编辑器宿主与视图模式管理，细分为：
  - `viEditorProvider.ts`：`CustomReadonlyEditorProvider` 接口实现、文档生命周期与 WebView 初始化。
  - `viEditorSession.ts`：单个 VI 编辑器会话，负责缓存查询、静态/动态属性加载、预览图导出与消息编排。
  - `viWebviewHtml.ts`：HTML 渲染纯函数（`escapeHtml`、`renderInitialPropsTableRows` 等），不依赖 vscode。
  - `viWebviewProtocol.ts`：`InboundMessage` / `OutboundState` 类型定义，描述 WebView 消息协议。
  - `viewMode.ts`：视图模式枚举与配置工具函数。
- `scripts/`：运行时脚本调用、版本解析、属性元数据与响应解析，细分为：
  - `runtime/workerInvoker.ts`：底层子进程调用工具（`runCommand`、`delay`），不依赖 LabVIEW。
  - `runtime/installedLabview.ts`：本机 LabVIEW 安装探测（PowerShell + 注册表 + PE 架构读取）。
  - `runtime/viPropsRuntime.ts`：VI 级属性读写与预览图导出（依赖 LabVIEW COM）。
  - `labviewRuntime.ts`：barrel re-export，保持现有 import 路径兼容。
  - `labviewSession.ts`：LabVIEW session 池，复用长连接。
  - `labviewVersionResolver.ts`：版本解析纯逻辑（目录标记 / lvproj / VI 文件头）。
  - `labviewStatusPresentation.ts`：状态栏文案生成纯函数。
  - `labviewAutomationGate.ts`：串行化 LabVIEW 自动化调用队列。
  - `propMetadata.ts`：VI 属性元数据定义与装饰函数。
  - `propsParser.ts`：Worker 响应解析与 JSON 信封序列化/反序列化。
  - `scriptPaths.ts`：Worker 脚本路径解析与 `selectScriptHost`（cscript.exe 路径选择）。
- `test/`：集成测试与纯逻辑单元测试。

### `workers/`

- 正式分发包中随扩展一起发布的 VBScript Worker。
- 负责通过 Windows Script Host + LabVIEW COM/ActiveX 执行真实读写与截图操作。

### `media/webview/`

- WebView 前端资源（HTML/CSS/JS）。
- 负责属性表渲染、图片预览、用户交互与消息通信。

### `prototype/`

- 原型、诊断、对照验证内容。
- 不属于正式运行时依赖，也不应被正式扩展源码直接引用。

### `.doc/`

- 用户文档、贡献文档、架构说明、测试说明、仓库结构说明均统一维护于此。

---

## 配置与构建文件

- `package.json`：扩展清单、命令声明、NPM 脚本入口。
- `tsconfig.json`：TypeScript 编译配置。
- `eslint.config.mjs`：ESLint 规则。
- `esbuild.js`：扩展打包脚本。
- `.github/workflows/ci.yml`：CI 流水线（类型检查、测试、VSIX 构建与验证）。
- `.vscodeignore`：控制 VSIX 打包内容，确保 `prototype/**` 不进入正式分发。

---

## 当前整理关注点

1. **构建基线**：TypeScript 配置需要显式包含 Node / VS Code / Mocha 类型，避免本地与 CI 出现类型解析不一致。
2. **测试结构**：纯逻辑模块已有较好单元测试基础，但状态栏展示逻辑与扩展激活链路仍需要更聚焦的覆盖。
3. **文档一致性**：文档需与当前实现保持一致，尤其是“静态属性先展示、动态属性按需加载”“预览在需要时才导出”这类行为。
4. **边界划分**：`prototype/` 与正式运行时边界必须持续保持清晰，避免误把原型脚本写入发布链路。
