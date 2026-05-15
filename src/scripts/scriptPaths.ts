import * as fs from 'fs';
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
  readonly sessionHostWorker: string;
  readonly savePanelImageWorker: string;
  readonly readPropsWorker: string;
  readonly writePropsWorker: string;
}

export function resolveScriptPaths(extensionRoot: string): ScriptPaths {
  const root = path.join(extensionRoot, 'workers');
  return {
    root,
    sessionHostWorker: path.join(root, 'labview_session_host.vbs'),
    savePanelImageWorker: path.join(root, 'save_vi_panel_image_worker.vbs'),
    readPropsWorker:      path.join(root, 'read_vi_props_worker.vbs'),
    writePropsWorker:     path.join(root, 'write_vi_props_worker.vbs'),
  };
}

/**
 * 选择用于启动 VBScript Worker 的 cscript.exe 解释器路径。
 *
 * 规则：若目标 LabVIEW 为 x86（32 位），则优先使用 SysWOW64 下的 cscript，
 * 以保证 COM 激活时进程位宽匹配；否则使用 System32 下的默认路径。
 */
export function selectScriptHost(architecture: string | undefined): string {
  const windir = process.env.WINDIR || 'C:\\Windows';
  if (architecture === 'x86') {
    const syswow64 = path.join(windir, 'SysWOW64', 'cscript.exe');
    if (fs.existsSync(syswow64)) {
      return syswow64;
    }
  }
  return path.join(windir, 'System32', 'cscript.exe');
}
