# vsc-labview-vi-support

一款用于在 Visual Studio Code 中预览并编辑 LabVIEW VI (`.vi`) /
模板 (`.vit`) 文件的扩展。

## 功能特性

- **`.vi` / `.vit` 自定义编辑器**：在 VS Code 中打开 VI 后会弹出一个
  WebView。默认首次打开仅显示属性表；切到预览后可查看前面板 (FP) 与
  程序框图 (BD) 图像，并附带一张可编辑的属性表。
- **视图模式与工具栏**：可在 *预览与属性表* / *仅显示属性表* /
  *仅显示预览* 之间切换；预览区域支持在 *仅前面板* / *仅程序框图* /
  *同时显示* 之间切换。
- **平移与缩放**：滚轮缩放（10% – 500%，以鼠标位置为锚点）、按住拖动
  平移、双击图像自适应窗口；前面板和程序框图各自维护独立缩放比例。
- **可编辑属性**：属性表已收敛为一组更常用、且在 LabVIEW COM 下更稳定的
  VI 设置，例如 `Description`、`HistoryText`、`AllowDebugging`、
  `ShowFPOnCall`、`CloseFPAfterCall`、`IsReentrant`、`RunOnOpen`、
  `PreferredExecSystem` 与 `ExecPriority`。根据属性类型自动选用文本框、
  文本域、布尔下拉和数字输入控件，并补充从文件头解析出的保存版本。
  修改通过 VI Server（由扩展内置的 TypeScript + Windows Script Host +
  LabVIEW COM 驱动）写回 VI 并保存。
- **LabVIEW 版本解析与状态栏配置**：状态栏优先显示当前项目根目录的
  LabVIEW 配置状态；当本机存在多个已安装版本而项目尚未设置时，会提示
  “多版本可用，项目未设置”。点击后会列出本机已安装的全部 LabVIEW
  版本，并在工作区根目录写入或更新 `DEV ENVIRONMENT LabVIEW ...`
  标记文件。
- **MD5 缓存**：FP/BD 图像与属性 JSON 缓存在扩展的全局存储目录中，缓存
  键是源 `.vi` 文件内容的 MD5。再次打开同一份 VI 几乎是瞬时的。

## LabVIEW 版本判定规则

扩展现在按以下优先级解析目标 LabVIEW 版本：

1. **目录标记文件**：如果当前目录或任一祖先目录存在
   `DEV ENVIRONMENT LabVIEW 2020`、
   `DEV ENVIRONMENT LabVIEW 2020 (64bit)`、
   `DEV ENVIRONMENT LabVIEW 2020 (32bit)` 这类文件，则该目录树优先采用
   这个版本。距离当前文件最近的目录标记优先。
2. **`.lvproj` 项目文件**：如果没有目录标记，则在当前目录到根目录的链路上
   查找 `.lvproj`，并从 XML 中的版本字段解析目标版本；距离当前文件最近的
   `.lvproj` 优先。
3. **VI 文件头**：如果目录标记和 `.lvproj` 都不存在，则回落到读取 `.vi` /
   `.vit` 文件头中的保存版本。

状态栏主要用于反映当前项目根目录是否已经设置版本；如果项目还没设置，
但当前活动 VI 可以从文件头读到保存版本，这个文件级信息会出现在状态栏提示
中，帮助你判断该不该补项目级标记。

## 未安装版本的处理

如果目录标记或 `.lvproj` 指向的 LabVIEW 版本在本机未安装：

- 状态栏会以警告样式显示该版本。
- 图像导出、属性读取、属性写入这类动态操作会**严格失败**，而不是偷偷回退到
  其他已安装版本，避免误连错误的 LabVIEW 实例。
- 点击状态栏按钮后，仍可从“本机已安装版本”列表里改写根目录标记，或清除
  根目录标记，回退到 `.lvproj` / VI 文件头判断。

## 运行环境

扩展运行时通过 VS Code 自带的 Node 扩展宿主调用内置的 Windows Script Host
worker（`workers/*.vbs`），这些 worker 再通过 ActiveX/COM 与
LabVIEW 通信，因此：

- **仅支持 Windows**：VI Server 桥接基于 COM。
- **动态功能要求本机安装与解析结果相匹配的 LabVIEW**。解析结果优先来自
  目录标记和 `.lvproj`，否则才回落到 VI 文件头；不匹配时不会再自动退到其他
  主版本或位数。
- **已安装版本探测同样走扩展宿主内的 TypeScript + PowerShell/注册表链路**，
  不依赖 Python bridge。
- **不需要额外安装 Python、pywin32 或 Pillow**。

## 设置项

- `labview-vi-support.cacheDirectory` — 当前缓存目录。该值由扩展自动维护；
  可在设置界面通过“打开缓存目录 / 清理缓存”动作链接操作。
- `labview-vi-support.viewMode` — 编辑器默认视图模式。当前默认值为
  `table-only`，可在用户设置中作为系统级默认值配置，也可在工作区设置中
  覆盖为当前项目统一使用的模式。
- `labview-vi-support.scriptTimeoutMs` — 每次脚本调用的超时（毫秒）。

## 根目录版本配置

点击状态栏里的 `LabVIEW: ...` 按钮后，扩展会枚举注册表中已安装的 LabVIEW
版本，并允许把选中的版本写成根目录标记文件。当前实现采用以下约定：

- 64 位安装写成 `DEV ENVIRONMENT LabVIEW 2020 (64bit)`。
- 32 位安装在需要显式区分时写成 `DEV ENVIRONMENT LabVIEW 2020 (32bit)`。
- 手工创建的 `DEV ENVIRONMENT LabVIEW 2020` 仍然被识别，表示只锁定版本、
  不显式指定位数。

## 运行时链路的当前状态

当前运行时已不再依赖 Python 解释器；已安装 LabVIEW 版本探测走扩展宿主内的
TypeScript + PowerShell/注册表链路，属性读写与图像导出走扩展内置的
TypeScript + VBS worker 链路。`prototype/` 目录仅保留仓库内的原型/调研
内容，不进入正式 VSIX，也不是客户环境所必需的运行时前置。
扩展源码与正式分发均不依赖 `prototype/` 中的任何文件。

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

```text
workers/                # 随扩展打包的 VBS worker
prototype/              # 原型/诊断脚本与样例（不进入正式 VSIX）
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
