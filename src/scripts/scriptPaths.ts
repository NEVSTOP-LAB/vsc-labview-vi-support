import * as path from 'path';

/**
 * 定位扩展打包后随附的 LabVIEW worker 脚本。
 *
 * `workers/` 目录会随扩展一起打包，包含：
 *   - save_vi_panel_image_worker.vbs
 *   - read_vi_props_worker.vbs
 *   - write_vi_props_worker.vbs
 *
 * 本模块为纯逻辑（不依赖 vscode 模块），可直接做单元测试。
 */
export interface ScriptPaths {
  readonly root: string;
  readonly savePanelImageWorker: string;
  readonly readPropsWorker: string;
  readonly writePropsWorker: string;
}

export function resolveScriptPaths(extensionRoot: string): ScriptPaths {
  const root = path.join(extensionRoot, 'workers');
  return {
    root,
    savePanelImageWorker: path.join(root, 'save_vi_panel_image_worker.vbs'),
    readPropsWorker:      path.join(root, 'read_vi_props_worker.vbs'),
    writePropsWorker:     path.join(root, 'write_vi_props_worker.vbs'),
  };
}
