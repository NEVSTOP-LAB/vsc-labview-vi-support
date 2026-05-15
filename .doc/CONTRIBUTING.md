# 贡献指南

欢迎向 **LabVIEW VI Support** 贡献代码和文档！本文档描述了如何搭建开发环境、运行测试、遵守代码规范，以及提交 Pull Request 的完整流程。

---

## 目录

1. [开发环境搭建](#开发环境搭建)
2. [项目结构](#项目结构)
3. [代码规范](#代码规范)
4. [构建](#构建)
5. [测试](#测试)
6. [测试说明与覆盖策略](#测试说明与覆盖策略)
7. [本地安装与验证](#本地安装与验证)
8. [提交 Pull Request 流程](#提交-pull-request-流程)
9. [发布步骤](#发布步骤)

---

## 开发环境搭建

### 前置要求

- **操作系统**：Windows（运行时依赖 LabVIEW COM，仅支持 Windows）
- **Node.js**：推荐 LTS 版本（v20+）
- **VS Code**：版本 ≥ 1.85.0
- **LabVIEW**（可选）：本机安装 LabVIEW 后可验证图像导出和属性读写的完整功能

### 步骤

```bash
# 1. 克隆仓库
git clone https://github.com/NEVSTOP-LAB/vsc-labview-vi-support.git
cd vsc-labview-vi-support

# 2. 安装依赖
npm install

# 3. 类型检查 + Lint + 打包（验证环境是否正常）
npm run compile
```

---

## 项目结构

```text
vsc-labview-vi-support/
├── src/
│   ├── extension.ts              # 扩展入口（激活/注销逻辑）
│   ├── labviewVersionStatus.ts   # 状态栏控制器与版本选择 UI
│   ├── cache/
│   │   ├── cacheDirectory.ts     # 缓存根目录管理（确保/清理）
│   │   └── viCache.ts            # MD5 内容寻址缓存（图像 + 属性 JSON）
│   ├── editor/
│   │   ├── viEditorProvider.ts   # 自定义编辑器宿主，编排缓存与脚本调用
│   │   └── viewMode.ts           # 视图模式枚举与校验工具
│   ├── scripts/
│   │   ├── labviewRuntime.ts     # WSH Worker 调用封装 + LabVIEW 安装探测
│   │   ├── labviewStatusPresentation.ts # 状态栏文案与提示生成（纯逻辑）
│   │   ├── labviewVersionResolver.ts  # 版本解析（目录标记 / lvproj / VI 文件头）
│   │   ├── propMetadata.ts       # VI 属性元数据定义（名称 / 类型 / 分组 / 可写性）
│   │   ├── propsParser.ts        # Worker 响应文件解析 + JSON 信封读写
│   │   └── scriptPaths.ts        # Worker 脚本路径解析工具
│   └── test/
│       ├── extension.test.ts     # VS Code 集成测试（需要 VS Code 运行时）
│       └── unit/                 # 纯逻辑单元测试（无需 VS Code 运行时）
│           ├── cacheDirectory.test.ts
│           ├── labviewVersionResolver.test.ts
│           ├── propMetadata.test.ts
│           ├── propsParser.test.ts
│           ├── scriptPaths.test.ts
│           ├── viCache.test.ts
│           └── viewMode.test.ts
├── workers/                      # 随扩展打包的 VBS Worker
│   ├── read_vi_props_worker.vbs
│   ├── write_vi_props_worker.vbs
│   └── save_vi_panel_image_worker.vbs
├── media/
│   └── webview/                  # WebView 的 HTML / CSS / JS（无运行时依赖）
├── scripts/                      # 开发辅助脚本（不进入 VSIX）
│   ├── clean-out.js
│   ├── copilot-doc-update-hook.js
│   ├── copilot-local-dev-hook.js
│   ├── generate-icon.js
│   └── install-vsix.js
├── prototype/                    # 原型 / 诊断脚本与样例（不进入正式 VSIX）
├── .doc/                         # 项目文档（中文）
│   ├── README.md                 # 用户使用说明
│   ├── CONTRIBUTING.md           # 开发与贡献流程
│   ├── architecture.md           # 架构设计说明
│   ├── repository-map.md         # 仓库结构扫描结果
│   ├── testing.md                # 测试结构与覆盖说明
│   └── CHANGELOG.md              # 文档变更记录
├── esbuild.js                    # 打包配置
├── eslint.config.mjs             # ESLint 配置
├── tsconfig.json                 # TypeScript 编译配置
└── package.json                  # 扩展清单与 NPM 脚本
```

---

## 代码规范

### TypeScript

- **严格模式**：`tsconfig.json` 开启了 `"strict": true`，所有代码必须通过类型检查（`npm run check-types`）。
- **环境类型声明**：TypeScript 配置显式包含 `node`、`vscode`、`mocha` 类型，避免构建环境与测试环境出现解析不一致。
- **ESLint**：使用 `eslint.config.mjs` 中的规则（基于 `typescript-eslint`），提交前必须通过 lint（`npm run lint`）。
- **命名约定**：
  - 文件名：`camelCase.ts`（类文件可用 `PascalCase.ts`）。
  - 导出函数 / 类：`PascalCase`（类）、`camelCase`（函数）。
  - 常量：`UPPER_SNAKE_CASE`（模块级常量）。
- **注释**：公共 API 使用 JSDoc 注释；复杂逻辑需补充行内注释。

### VBScript (`.vbs` Worker)

- Worker 文件位于 `workers/` 目录，需保持与 TypeScript 层的接口约定（键值行格式，参见 `src/scripts/propsParser.ts` 文件头注释）。
- 不引入外部 COM 依赖（除 LabVIEW COM 本身）。

### 文档

- 所有 `.doc/` 下的 `.md` 文件必须使用**中文**撰写。
- `README.md`（根目录）仅包含用户向内容；开发细节一律放入 `.doc/CONTRIBUTING.md`。
- 每次非文档改动后，都要补一次对应的说明文档更新；`.doc/CHANGELOG.md` 只能作为记录，不能单独代替说明文档同步。

### Copilot Hook

- `.github/hooks/local-dev.json` 为 Copilot 本地会话注册了两个 hook：文档同步检查和本地构建/安装。
- `scripts/copilot-doc-update-hook.js` 会跟踪当前会话中的非文档改动；如果最近一次非文档改动之后没有更新 `README.md` 或 `.doc/` 下的说明文档，就会在 `Stop` 阶段阻断结束。
- `scripts/copilot-local-dev-hook.js` 会在检测到相关源码改动后执行 `npm run compile` 和 `npm run load:local`。

---

## 构建

```bash
# 开发构建（类型检查 + Lint + esbuild）
npm run compile

# 监视模式（并行运行 esbuild 和 tsc 监视）
npm run watch

# 生产构建（供发布）
npm run package

# 生成 VSIX 安装包
npm run package:vsix
```

> `npm run compile` 会依次执行：
> 1. `check-types`（`tsc --noEmit`）
> 2. `lint`（`eslint src`）
> 3. `node esbuild.js`（打包到 `dist/`）

---

## 测试

### 单元测试（推荐，无需 VS Code）

```bash
# 编译测试文件并运行 mocha 单元测试
npm run test:unit
```

单元测试覆盖以下核心模块（位于 `src/test/unit/`）：

| 测试文件 | 覆盖模块 |
|---|---|
| `labviewVersionResolver.test.ts` | 版本解析（目录标记 / lvproj / VI 文件头） |
| `propsParser.test.ts` | Worker 响应文件解析 + JSON 信封读写 |
| `propMetadata.test.ts` | VI 属性元数据装饰逻辑 |
| `viCache.test.ts` | MD5 缓存读写 + 失效逻辑 |
| `cacheDirectory.test.ts` | 缓存目录管理 |
| `scriptPaths.test.ts` | Worker 路径解析 |
| `viewMode.test.ts` | 视图模式枚举校验 |

### 集成测试（需要 VS Code 运行时）

```bash
# 下载 VS Code 并运行完整集成测试
npm test
```

> 集成测试需要从网络下载 VS Code 测试环境，首次运行可能较慢。

### 新增测试

1. 在 `src/test/unit/` 下创建 `<module>.test.ts` 文件。
2. 使用 Mocha TDD 风格（`suite` / `test` / `setup` / `teardown`）。
3. 纯逻辑测试不得依赖 `vscode` 模块。
4. 运行 `npm run test:unit` 确认通过。

---

## 测试说明与覆盖策略

- 仓库当前同时保留 **单元测试** 与 **集成测试** 两层结构，不需要更换测试框架。
- 纯函数、解析器、缓存与展示决策逻辑优先进入 `src/test/unit/`。
- VS Code 激活链路、命令注册等扩展宿主行为放入 `src/test/extension.test.ts`。
- Windows + LabVIEW COM 专属能力依赖真实环境，仍需在本机进行人工验证。
- 更详细的测试矩阵请参见 [.doc/testing.md](./testing.md)。

---

## 本地安装与验证

```bash
# 生成 VSIX 并安装到本机 VS Code
npm run load:local
```

`load:local` 会依次执行：
1. `npm run package:vsix`（生成 `.vsix`）
2. `npm run install:vsix`（通过 PowerShell 调用 `code.cmd --install-extension` 安装）

安装成功后，在 VS Code 中打开任意 `.vi` 文件即可验证扩展是否正常激活。

> **注意**：`scripts/install-vsix.js` 只支持 Windows，会在标准路径下查找 `code.cmd`。

---

## 提交 Pull Request 流程

1. **Fork** 仓库并基于 `main` 创建功能分支：
   ```bash
   git checkout -b feat/my-feature
   ```
2. 完成修改后，确保以下命令全部通过：
   ```bash
   npm run compile   # 类型检查 + Lint + 打包
   npm run test:unit # 单元测试
   ```
3. 提交时使用语义化提交信息（[Conventional Commits](https://www.conventionalcommits.org/)）：
   ```
   feat: 添加 XXX 功能
   fix: 修复 XXX 问题
   docs: 更新 XXX 文档
   refactor: 重构 XXX 模块
   test: 补充 XXX 测试
   chore: 更新依赖 / 构建配置
   ```
4. 推送分支并在 GitHub 上创建 Pull Request，填写以下信息：
   - **标题**：简明描述改动（与提交信息风格一致）。
   - **描述**：说明改动目的、测试方式、需要关注的兼容性问题。
5. 等待 CI 通过和 Code Review。

---

## 发布步骤

1. 更新 `package.json` 中的 `version` 字段（遵循语义版本 `MAJOR.MINOR.PATCH`）。
2. 更新 `.doc/CHANGELOG.md`，记录新版本的改动。
3. 运行完整构建与测试：
   ```bash
   npm run compile
   npm run test:unit
   ```
4. 生成 VSIX：
   ```bash
   npm run package:vsix
   ```
5. 在 GitHub 上创建新的 Release，上传 VSIX 文件，并填写发布说明。
6. 如需发布到 VS Code 扩展市场，运行：
   ```bash
   npx vsce publish
   ```
   （需要配置 Personal Access Token）
