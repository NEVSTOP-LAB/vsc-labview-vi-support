# Agent Notes

## 本次调研结论

- 当前仓库已经验证可以在本地自动编译 VSIX 并安装到本机 VS Code。
- 现有入口命令为 npm run package:vsix、npm run install:vsix、npm run load:local。
- load:local 会先执行 VSIX 打包，再调用本机 VS Code CLI 安装扩展。
- 扩展运行时已经切换为 TypeScript + Windows Script Host + LabVIEW COM，不再要求客户额外安装 Python、pywin32 或 Pillow。

## 已完成的实际验证

1. npm run compile 已成功执行，说明 TypeScript 检查、ESLint 与 esbuild 打包链路正常。
2. vsce package 已成功产出 VSIX，最初因为仓库缺少 LICENSE 文件而出现交互确认。
3. 通过在 package:vsix 中加入 --skip-license，打包流程已变为非交互。
4. npm run load:local 已成功执行，VS Code CLI 返回扩展安装成功。
5. 本机扩展列表已能看到 nevstop-lab.labview-vi-support@0.0.1。

## 过程中确认的问题与处理

- 初始 VSIX 会把 .venv、.github、prototype/vi、Python 缓存文件一起打进去，导致包体积膨胀到 24.67 MB。
- 现已通过 .vscodeignore 排除无关目录与缓存文件，重新打包后 VSIX 降到 67.02 KB。
- Windows 下直接调用带空格路径的 code.cmd 会遇到命令解析问题。
- 现已改为由 scripts/install-vsix.js 通过 PowerShell 调用 code.cmd，安装流程已验证通过。

## 当前实现要点

- package.json 中新增了 package:vsix、install:vsix、load:local 三个脚本。
- scripts/install-vsix.js 会在标准 VS Code 安装路径中查找 code.cmd，并执行 --install-extension <vsix> --force。
- 该安装脚本当前只支持 Windows，这与本扩展依赖 LabVIEW COM 桥接、仅支持 Windows 的前提一致。
- 图像导出已改为 `save_vi_panel_image_worker.vbs`，属性读写已改为 TS 包装层直接调用 `read_vi_props_worker.vbs` / `write_vi_props_worker.vbs`。
- 运行时不再依赖 Python 解释器；`prototype/scripts/*.py` 仅作为保留的原型/研究脚本存在。

## 当前约束

- 仓库目前仍然没有 LICENSE 文件，因此 VSIX 打包依赖 --skip-license。
- 自动安装依赖本机存在标准位置的 VS Code CLI。
- 扩展仍然只支持 Windows，因为底层依赖 LabVIEW ActiveX/COM 与 WSH。
- “已安装”已得到验证；若要继续验证运行时激活，需要在 VS Code 中实际打开 .vi 或 .vit 文件触发自定义编辑器。
- 如果是本地的vscode的AI开发，每次结束后，都要编译并尝试加载.

## 建议的后续人工冒烟测试

1. 执行 npm run load:local。
2. 在当前 VS Code 中打开 prototype/vi/2025.vi。
3. 确认自定义编辑器是否正常展示前面板、程序框图与属性表。
4. 若需要验证写回能力，再在已安装 LabVIEW 的机器上测试属性修改与保存。