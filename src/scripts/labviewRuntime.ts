/**
 * LabVIEW 运行时接口 — barrel re-export。
 *
 * 本文件统一重新导出所有运行时相关符号，保持现有的 import 路径不变。
 * 实现已按职责拆分到 `runtime/` 子目录中的三个模块：
 *
 *   - `runtime/workerInvoker.ts`   — 底层子进程调用工具
 *   - `runtime/installedLabview.ts` — 本机 LabVIEW 安装探测
 *   - `runtime/viPropsRuntime.ts`  — VI 级属性读写与图像导出
 */

export { disposeLabVIEWSessions } from './labviewSession';

export type { InstalledLabVIEW } from './runtime/installedLabview';
export {
  discoverInstalledLabVIEWs,
  buildInstalledLabVIEWDiscoveryScript,
  selectInstalledLabVIEW,
} from './runtime/installedLabview';

export type { LabVIEWRuntimeOptions } from './runtime/viPropsRuntime';
export {
  UnsupportedPreviewExportError,
  getUnsafePreviewExportReason,
  parseViSavedVersionHeader,
  readViSavedVersion,
  buildWriteRequestLines,
  normalizePropsEnvelope,
  exportViPanelImage,
  exportViPanelImages,
  readViProps,
  hasReusableLabVIEWConnection,
  readStaticViProps,
  writeViProps,
} from './runtime/viPropsRuntime';
