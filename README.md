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
  （由内置的 Python / VBScript 脚本驱动）写回 VI 并保存。
- **MD5 缓存**：FP/BD 图像与属性 JSON 缓存在扩展的全局存储目录中，缓存
  键是源 `.vi` 文件内容的 MD5。再次打开同一份 VI 几乎是瞬时的。

## 运行环境

扩展通过子进程调用内置的 Python 原型脚本（`prototype/scripts/*.py`），
这些脚本再通过 ActiveX/COM 与 LabVIEW 通信，因此：

- **仅支持 Windows**：VI Server 桥接基于 COM。
- **必须安装与 VI 保存版本相匹配的 LabVIEW**（脚本会从 VI 文件头中
  自动识别版本与位数）。
- **必须有 Python 3** 位于 `PATH` 中（或通过
  `labview-vi-support.pythonPath` 显式指定）。

## 设置项

- `labview-vi-support.pythonPath` — 自定义 Python 可执行文件路径。
- `labview-vi-support.scriptTimeoutMs` — 每次脚本调用的超时（毫秒）。

## 写入脚本的当前状态

`write_vi_props.py` 与 `write_vi_props_worker.vbs` 的实现镜像了对应的
读取脚本，覆盖 `read_vi_props.py` 元数据中标记为 `R/W` 的 15 个属性。
受限于环境，该脚本属于 *尽力而为* 的实现，**未在真实 LabVIEW 环境中
验证过**，正式使用前请先在你自己的安装上做测试。

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
prototype/scripts/      # Python + VBScript 原型脚本（COM 桥）
src/
  cache/viCache.ts      # MD5 缓存
  scripts/              # 与原型脚本对话的纯 TS 适配层
    scriptPaths.ts
    propsParser.ts
    pythonRunner.ts
  editor/
    viEditorProvider.ts # 自定义编辑器宿主，编排缓存与脚本调用
  extension.ts          # 扩展入口
  test/unit/            # mocha 单元测试
media/webview/          # WebView 的 HTML / CSS / JS（无运行时依赖）
```