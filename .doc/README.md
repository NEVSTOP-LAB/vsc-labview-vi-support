# LabVIEW VI Support — 使用说明

## 项目简介

**LabVIEW VI Support** 是一款用于在 Visual Studio Code 中预览并编辑 LabVIEW VI（`.vi`）/ 模板（`.vit`）文件的扩展。它通过 Windows Script Host + LabVIEW COM/ActiveX 桥接，让你无需切换到 LabVIEW IDE 即可快速查看 VI 属性、前面板和程序框图截图，并可直接修改常用 VI 属性。

> **平台限制**：扩展底层依赖 LabVIEW COM 桥接，**仅支持 Windows**。

---

## 安装

### 通过 VS Code 扩展市场安装（推荐）

1. 打开 VS Code，按 `Ctrl+Shift+X` 打开扩展面板。
2. 搜索 **LabVIEW VI Support**。
3. 点击 **安装**。

### 手动安装 VSIX

1. 从 [GitHub Releases](https://github.com/NEVSTOP-LAB/vsc-labview-vi-support/releases) 下载最新的 `.vsix` 文件。
2. 在 VS Code 扩展面板右上角菜单中选择 **从 VSIX 安装…**，然后选择下载的文件。

---

## 快速开始

1. 安装扩展后，在 VS Code 文件浏览器中双击任意 `.vi` 或 `.vit` 文件。
2. 扩展的自定义编辑器会自动打开，默认显示属性表（`table-only` 模式）。
3. 点击工具栏按钮可切换到 **预览 + 属性表** 或 **仅预览** 模式。
4. 首次加载时扩展会调用本机 LabVIEW 导出前面板 / 程序框图图像；之后相同 VI（相同内容哈希）再次打开时会直接命中缓存，近乎即时响应。

---

## 功能特性

### 自定义编辑器

- 在 VS Code 中打开 `.vi` / `.vit` 文件后会弹出内置 WebView。
- 默认首次打开仅显示属性表；切换到预览模式后可查看前面板（FP）与程序框图（BD）图像，并附带可编辑的属性表。

### 视图模式与工具栏

| 视图模式 | 说明 |
|---|---|
| `table-only` | 仅显示属性表（默认） |
| `both` | 同时显示预览图像与属性表 |
| `preview-only` | 仅显示预览图像 |

预览区域还可在 *仅前面板* / *仅程序框图* / *同时显示* 之间切换。

### 平移与缩放

- **滚轮缩放**：缩放比例 10% – 500%，以鼠标光标位置为锚点。
- **拖动平移**：按住鼠标左键拖动图像。
- **双击自适应**：双击图像可自适应当前窗口大小。
- 前面板和程序框图各自维护独立的缩放比例与偏移状态。

### 可编辑属性

属性表覆盖以下 VI 属性，根据类型自动选用合适的控件：

| 属性 | 类型 | 说明 |
|---|---|---|
| `Description` | 文本域 | VI 说明文字 |
| `HistoryText` | 文本域 | 修订历史日志 |
| `AllowDebugging` | 布尔下拉 | 允许调试 |
| `ShowFPOnCall` | 布尔下拉 | 调用时显示前面板 |
| `CloseFPAfterCall` | 布尔下拉 | 调用后关闭前面板 |
| `IsReentrant` | 布尔下拉 | 允许重入执行 |
| `RunOnOpen` | 布尔下拉 | 打开后立即运行 |
| `PreferredExecSystem` | 数字输入 | 首选执行系统 |
| `ExecPriority` | 数字输入 | 执行优先级 |

此外，属性表还会显示从文件头解析出的**保存版本**（只读）。

修改通过 VI Server（TypeScript + Windows Script Host + LabVIEW COM）写回 VI 并保存。

### LabVIEW 版本解析与状态栏

状态栏左侧显示当前项目的 LabVIEW 版本配置状态：

- **已设置且已安装**：显示 `$(tools) LabVIEW: LabVIEW 2025 32bit`（绿色工具图标）。
- **多版本可用，项目未设置**：显示 `$(question) LabVIEW: 多版本可用，项目未设置`。
- **目标版本未安装**：以警告样式显示版本号，动态操作（图像导出、属性读取 / 写入）会**严格失败**，避免误连错误的 LabVIEW 实例。

点击状态栏按钮可列出本机已安装的全部 LabVIEW 版本，并为当前项目写入或更新目录标记文件。

### MD5 缓存

FP / BD 图像与属性 JSON 缓存在扩展的全局存储目录中，缓存键是源 `.vi` 文件内容的 MD5。再次打开同一份 VI 几乎是瞬时的。VI 内容更改后会自动计算新哈希并创建新的缓存条目。

---

## LabVIEW 版本判定规则

扩展按以下优先级解析目标 LabVIEW 版本：

1. **目录标记文件**（最高优先级）：如果当前目录或任一祖先目录存在  
   `DEV ENVIRONMENT LabVIEW 2020`、`DEV ENVIRONMENT LabVIEW 2020(64bit)` 这类文件，则该目录树优先采用该版本。距离当前文件最近的目录标记优先。
2. **`.lvproj` 项目文件**：如果没有目录标记，则在当前目录到根目录的链路上查找 `.lvproj`，并从 XML 中的版本字段解析目标版本；距离当前文件最近的 `.lvproj` 优先。
3. **VI 文件头**（最低优先级）：如果目录标记和 `.lvproj` 都不存在，则回落到读取 `.vi` / `.vit` 文件头中的保存版本。

---

## 根目录版本配置

点击状态栏里的 `LabVIEW: ...` 按钮后，扩展会枚举注册表中已安装的 LabVIEW 版本，并允许把选中的版本写成根目录标记文件：

| 安装类型 | 标记文件名示例 |
|---|---|
| 32 位（默认） | `DEV ENVIRONMENT LabVIEW 2020` |
| 64 位 | `DEV ENVIRONMENT LabVIEW 2020(64bit)` |

旧格式（`DEV ENVIRONMENT LabVIEW 2020 (32bit)` / `DEV ENVIRONMENT LabVIEW 2020 (64bit)`）仍然会被识别，用于兼容已有项目。

---

## 配置项

| 配置键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `labview-vi-support.cacheDirectory` | `string` | `""` | 当前缓存目录（由扩展自动维护）。可通过命令 **打开缓存目录** 查看。 |
| `labview-vi-support.viewMode` | `"both"` \| `"table-only"` \| `"preview-only"` | `"table-only"` | 编辑器默认视图模式。可在工作区设置中覆盖为项目统一默认值。 |
| `labview-vi-support.scriptTimeoutMs` | `number` | `120000` | 每次脚本调用的超时（毫秒），最小值 5000。 |

---

## 命令

以下命令可通过命令面板（`Ctrl+Shift+P`）或状态栏按钮触发：

| 命令 | 说明 |
|---|---|
| `LabVIEW VI Support: 配置 LabVIEW 版本` | 为当前项目根目录选择 LabVIEW 版本并写入标记文件 |
| `LabVIEW VI Support: 打开缓存目录` | 在文件资源管理器中打开缓存目录 |
| `LabVIEW VI Support: 清理缓存` | 清除所有缓存（下次打开 VI 时自动重建） |

---

## 运行环境要求

- **操作系统**：仅支持 Windows（依赖 LabVIEW COM / ActiveX 桥接）。
- **LabVIEW**：本机需安装与项目版本相匹配的 LabVIEW，方可使用图像导出和属性读写功能。
- **Python**：**不需要**。扩展已内置 TypeScript + Windows Script Host + LabVIEW COM 运行时链路，无需额外安装 Python、pywin32 或 Pillow。
- **VS Code**：版本 ≥ 1.85.0。

---

## 常见问题

**Q：打开 VI 后属性表为空，提示"加载中"但长时间没有响应？**  
A：请检查：① 本机是否已安装 LabVIEW；② 状态栏版本是否与已安装版本一致；③ `labview-vi-support.scriptTimeoutMs` 是否过短。

**Q：状态栏显示"目标版本未安装"，但我明明安装了 LabVIEW？**  
A：可能是目录标记文件指定的版本号与实际安装版本不一致。点击状态栏按钮后重新选择正确版本即可。

**Q：我修改了属性但 VI 里没有变化？**  
A：请确认当前 LabVIEW 版本是否正确，且属性写回时没有超时（可查看 VS Code 输出面板中的错误信息）。

**Q：在 macOS / Linux 上能用吗？**  
A：不能。扩展底层依赖 LabVIEW COM/ActiveX 接口，该接口仅在 Windows 上可用。

**Q：如何完全清除缓存？**  
A：执行命令 **LabVIEW VI Support: 清理缓存**，或手动删除 `labview-vi-support.cacheDirectory` 所指向的目录。
