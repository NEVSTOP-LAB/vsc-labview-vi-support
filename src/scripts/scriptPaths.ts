import * as path from 'path';

/**
 * Locate prototype Python scripts that ship inside the extension package.
 *
 * The prototype directory is copied verbatim into the extension at install
 * time and contains:
 *   - save_vi_panel_image.py
 *   - read_vi_props.py + read_vi_props_worker.vbs
 *   - write_vi_props.py + write_vi_props_worker.vbs
 *
 * Pure logic — no vscode imports — so it can be unit-tested directly.
 */
export interface ScriptPaths {
  readonly root: string;
  readonly savePanelImage: string;
  readonly readProps: string;
  readonly writeProps: string;
}

export function resolveScriptPaths(extensionRoot: string): ScriptPaths {
  const root = path.join(extensionRoot, 'prototype', 'scripts');
  return {
    root,
    savePanelImage: path.join(root, 'save_vi_panel_image.py'),
    readProps:      path.join(root, 'read_vi_props.py'),
    writeProps:     path.join(root, 'write_vi_props.py'),
  };
}
