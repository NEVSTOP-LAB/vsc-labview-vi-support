# 项目约定

## 本地扩展开发

- 修改扩展源码、构建脚本或本地安装/加载脚本后，在最终回复前运行 `npm run compile`。
- 如果 `npm run compile` 成功，再运行 `npm run load:local`，确保本机 VS Code 已刷新到最新扩展。
- 在最终回复中明确说明 `npm run compile` 与 `npm run load:local` 的结果。
- 只读分析或纯文档改动默认跳过上述步骤，除非用户明确要求。

## 运行约束

- 本扩展只支持 Windows，运行时依赖 LabVIEW COM 与 Windows Script Host。
- 不要在 `%TEMP%`、临时目录或缓存目录中动态生成并执行 `.vbs` 脚本；这类行为容易被安全软件误判为病毒。
- 如需使用 VBS/WSH，优先复用仓库内 `workers/**` 下的固定脚本；调试、诊断或临时验证也遵循同样约束。
- 若必须生成临时 helper，优先选择非 `.vbs` 形式，并先评估安全软件误报风险与客户环境可接受性。

## 当前技术栈

- 当前扩展运行时技术栈保持为：VS Code Extension Host + TypeScript + Windows Script Host + LabVIEW COM/ActiveX。
- 已安装 LabVIEW 版本探测保持在扩展宿主内的 TypeScript + PowerShell/注册表链路中，不通过 Python bridge。
- 正式 VSIX 仅携带运行时必需资源；`prototype/**` 默认为仓库内的原型/诊断内容，不进入正式分发包。
- 扩展源码与正式分发默认不引用 `prototype/**` 中的任何文件；运行时所需内容应放在独立的正式目录中。
- `prototype/scripts/*.py` 可以作为原型、诊断、对照验证脚本存在和运行，但这不代表项目运行时技术栈切换为 Python。
- 任何引入到 `prototype/scripts/*.py` 的 Python 实现，默认都视为 prototype / research / diagnostic，不作为当前扩展运行时依赖。
- 当前客户侧运行时前提仍然是不需要额外安装 Python、pywin32 或其他 Python 第三方依赖。
- 如果某个 Python prototype 被验证有效，后续集成到扩展时应优先回归当前运行时技术栈，而不是直接把 Python 变成插件正式依赖。