// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Very small include preprocessor for the webview bundle.
 *
 * It inlines lines of the form:
 *   // @include <file>
 *
 * Relative to `media/webview/src/`, and writes the final runtime artifact to
 * `media/webview/editor.js` (single-script output keeps CSP simple).
 */
function buildWebviewBundle() {
  const workspaceRoot = path.resolve(__dirname, '..');
  const srcDir = path.join(workspaceRoot, 'media', 'webview', 'src');
  const entryPath = path.join(srcDir, 'editor.js');
  const outPath = path.join(workspaceRoot, 'media', 'webview', 'editor.js');

  const entry = fs.readFileSync(entryPath, 'utf8');
  const lines = entry.split(/\n/);

  /** @type {string[]} */
  const out = [];
  for (const line of lines) {
    const match = line.match(/^(\s*)\/\/\s*@include\s+([^\s]+)\s*$/);
    if (!match) {
      out.push(line);
      continue;
    }

    const rel = match[2];
    const includePath = path.join(srcDir, rel);
    if (!fs.existsSync(includePath)) {
      throw new Error(`Missing webview include: ${includePath}`);
    }
    const included = fs.readFileSync(includePath, 'utf8');
    out.push(...included.split(/\n/));
  }

  fs.writeFileSync(outPath, out.join('\n'), 'utf8');
}

if (require.main === module) {
  buildWebviewBundle();
}

module.exports = { buildWebviewBundle };
