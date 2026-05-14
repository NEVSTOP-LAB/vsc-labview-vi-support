# 项目约定

## 本地扩展开发

- 修改扩展源码、构建脚本或本地安装/加载脚本后，在最终回复前运行 `npm run compile`。
- 如果 `npm run compile` 成功，再运行 `npm run load:local`，确保本机 VS Code 已刷新到最新扩展。
- 在最终回复中明确说明 `npm run compile` 与 `npm run load:local` 的结果。
- 只读分析或纯文档改动默认跳过上述步骤，除非用户明确要求。

## 运行约束

- 本扩展只支持 Windows，运行时依赖 LabVIEW COM 与 Windows Script Host。
- 当前运行时以 TypeScript + WSH 为主；`prototype/scripts/*.py` 仅保留为原型/研究脚本，不作为当前运行时依赖。