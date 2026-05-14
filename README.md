# vsc-labview-vi-support

一款用于在 Visual Studio Code 中预览并编辑 LabVIEW VI (`.vi`) /
模板 (`.vit`) 文件的扩展。

## 功能特性

- **`.vi` / `.vit` 自定义编辑器**：在 VS Code 中打开 VI 后会弹出一个
  WebView，显示前面板 (FP) 与程序框图 (BD) 的图像，并附带一张可编辑的
  属性表。
- **工具栏**：在 *仅前面板* / *仅程序框图* / *两者皆显示* 之间切换；
  显示或隐藏属性表；放大、缩小、重置缩放。
- **平移与缩放**：滚轮缩放（10% – 500%，以鼠标位置为锚点）、按住拖动
  平移、双击图像自适应窗口。
- **可编辑属性**：根据属性类型自动选用文本框、文本域、布尔下拉、数字
  输入框，以及 `ReentrantType` / `Priority` 的枚举下拉。修改通过 VI Server
  （由扩展内置的 TypeScript + Windows Script Host + LabVIEW COM 驱动）
  写回 VI 并保存。
- **MD5 缓存**：FP/BD 图像与属性 JSON 缓存在扩展的全局存储目录中，缓存
  键是源 `.vi` 文件内容的 MD5。再次打开同一份 VI 几乎是瞬时的。

## 运行环境

扩展运行时通过 VS Code 自带的 Node 扩展宿主调用内置的 Windows Script Host
worker（`prototype/scripts/*.vbs`），这些 worker 再通过 ActiveX/COM 与
LabVIEW 通信，因此：

- **仅支持 Windows**：VI Server 桥接基于 COM。
- **必须安装与 VI 保存版本相匹配的 LabVIEW**（脚本会从 VI 文件头中
  自动识别版本与位数）。
- **不需要额外安装 Python、pywin32 或 Pillow**。

## 设置项

- `labview-vi-support.scriptTimeoutMs` — 每次脚本调用的超时（毫秒）。

## 写入脚本的当前状态

当前运行时已不再依赖 Python 解释器；属性读写与图像导出均走扩展内置的
TypeScript + VBS worker 链路。`prototype/scripts/*.py` 仍保留为原型/调研
代码，不是客户环境所必需的运行时前置。

## 本地开发

```bash
npm install
npm run compile        # 类型检查 + lint + esbuild 打包
npm run package:vsix   # 生成本地 VSIX 安装包
npm run load:local     # 生成 VSIX 并安装到本机 VS Code
npm run test:unit      # 纯逻辑模块的 mocha 单元测试（无需 VS Code 运行时）
npm test               # 完整集成测试（需要从网络下载 VS Code）
```

## 项目结构

```
prototype/scripts/      # VBS worker + 保留的 Python 原型脚本
src/
  cache/viCache.ts      # MD5 缓存
  scripts/              # 与 WSH/LabVIEW worker 对话的纯 TS 适配层
    scriptPaths.ts
    labviewRuntime.ts
    propsParser.ts
  editor/
    viEditorProvider.ts # 自定义编辑器宿主，编排缓存与脚本调用
  extension.ts          # 扩展入口
  test/unit/            # mocha 单元测试
media/webview/          # WebView 的 HTML / CSS / JS（无运行时依赖）
```