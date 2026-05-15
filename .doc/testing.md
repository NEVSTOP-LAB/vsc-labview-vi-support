# 测试说明

本文档记录当前仓库的测试结构、覆盖范围与整理后的建议执行顺序。

---

## 测试入口

### 1. 类型检查 + Lint + 扩展打包

```bash
npm run compile
```

用途：

- 运行 TypeScript 类型检查；
- 运行 ESLint；
- 使用 esbuild 生成扩展产物。

### 2. 单元测试

```bash
npm run test:unit
```

用途：

- 编译 `src/test/unit/**/*.test.ts`；
- 运行纯逻辑测试，不依赖 VS Code 扩展宿主。

### 3. 集成测试

```bash
npm test
```

用途：

- 下载并启动 VS Code 测试宿主；
- 验证扩展能够激活、关键命令已注册。

---

## 当前覆盖范围

### 已覆盖的纯逻辑模块

- `cache/cacheDirectory.ts`
- `cache/viCache.ts`
- `editor/viewMode.ts`
- `scripts/labviewVersionResolver.ts`
- `scripts/scriptPaths.ts`
- `scripts/propsParser.ts`
- `scripts/propMetadata.ts`
- `scripts/labviewStatusPresentation.ts` 中的 `buildStatusPresentation`

### 已覆盖的集成场景

- 扩展可被 VS Code 成功加载并激活；
- 关键命令在激活后已注册。

---

## 当前未完全覆盖的部分

以下部分仍以人工验证为主：

1. **Windows 专属运行时链路**：`cscript.exe`、LabVIEW COM、注册表扫描。
2. **WebView 交互细节**：缩放、平移、视图切换、图片懒加载。
3. **真实 VI 读写**：需要已安装且版本匹配的 LabVIEW 环境。

这些能力依赖 Windows 与本机 LabVIEW 安装，无法在纯单元测试中完整模拟。

---

## 建议执行顺序

每次提交前建议至少执行以下顺序：

1. `npm run compile`
2. `npm run test:unit`
3. `npm test`（如环境允许）

若修改了扩展源码、构建脚本或本地加载脚本，还应补充执行：

4. `npm run load:local`（仅适用于 Windows 本机开发环境）

---

## 测试整理结论

- 当前仓库**已有测试框架**，无需更换。
- 当前重点不是引入新框架，而是**补齐纯函数与激活链路的覆盖**。
- 对于 Windows / LabVIEW 相关能力，应继续保持“单元测试 + 集成测试 + 本机人工验证”三层组合策略。
