# vsc-labview-vi-support

一款用于在 Visual Studio Code 中预览并编辑 LabVIEW VI (`.vi`) /
模板 (`.vit`) 文件的扩展。

> **平台限制**：扩展底层依赖 LabVIEW COM 桥接，**仅支持 Windows**。

## 主要功能

- **自定义编辑器**：在 VS Code 中打开 VI 后弹出 WebView，可查看前面板（FP）与程序框图（BD）图像，并附带可编辑的属性表。
- **视图模式切换**：支持 *预览 + 属性表* / *仅属性表* / *仅预览* 三种模式，以及前面板 / 程序框图的独立切换。
- **平移与缩放**：滚轮缩放（10% – 500%）、拖动平移、双击自适应窗口。
- **可编辑属性**：支持 `Description`、`HistoryText`、`AllowDebugging`、`ShowFPOnCall`、`CloseFPAfterCall`、`IsReentrant`、`RunOnOpen`、`PreferredExecSystem`、`ExecPriority` 等 VI 属性的读取与写回。
- **版本解析与状态栏**：按优先级（目录标记 → `.lvproj` → VI 文件头）自动解析目标 LabVIEW 版本，并在状态栏显示配置状态。
- **MD5 内容缓存**：FP/BD 图像与属性 JSON 以 VI 文件内容的 MD5 为键缓存，再次打开同一 VI 几乎即时响应。

## 文档

| 文档 | 说明 |
|---|---|
| [.doc/README.md](.doc/README.md) | 完整使用说明（安装、功能、配置、常见问题） |
| [.doc/CONTRIBUTING.md](.doc/CONTRIBUTING.md) | 开发者贡献指南（搭建环境、代码规范、测试、发布） |
| [.doc/architecture.md](.doc/architecture.md) | 架构说明（模块设计、数据流、缓存机制） |
| [.doc/vi-server-backup-plan.html](.doc/vi-server-backup-plan.html) | “VI Server 替代 COM”调研结论与备份实施建议 |
| [.doc/CHANGELOG.md](.doc/CHANGELOG.md) | 文档变更记录 |

## 快速开始

1. 安装扩展（[VS Code 扩展市场](https://marketplace.visualstudio.com/items?itemName=NEVSTOP-LAB.labview-vi-support) 或手动安装 VSIX）。
2. 在 VS Code 文件浏览器中双击 `.vi` / `.vit` 文件，自定义编辑器会自动打开。
3. 点击状态栏的 `LabVIEW: ...` 按钮为当前项目配置 LabVIEW 版本。

详细说明请参阅 [.doc/README.md](.doc/README.md)。
