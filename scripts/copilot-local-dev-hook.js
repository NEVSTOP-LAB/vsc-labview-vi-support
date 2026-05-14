const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.html', '.css']);
const EDIT_TOOLS = new Set(['apply_patch', 'create_file', 'vscode_renameSymbol']);

main();

function main() {
  const payload = readPayload();

  if (!payload?.cwd || !payload?.sessionId) {
    finish({});
    return;
  }

  if (payload.hookEventName === 'PostToolUse') {
    handlePostToolUse(payload);
    return;
  }

  if (payload.hookEventName === 'Stop') {
    handleStop(payload);
    return;
  }

  finish({});
}

function handlePostToolUse(payload) {
  if (!EDIT_TOOLS.has(payload.tool_name)) {
    finish({});
    return;
  }

  const changedFiles = extractChangedFiles(payload).filter(isRelevantSourceFile);
  if (changedFiles.length === 0) {
    finish({});
    return;
  }

  const state = loadState(payload.cwd, payload.sessionId);
  const mergedFiles = new Set([...(state.changedFiles || []), ...changedFiles]);
  state.changedFiles = Array.from(mergedFiles).sort();
  state.needsReload = true;
  saveState(payload.cwd, payload.sessionId, state);
  finish({});
}

function handleStop(payload) {
  const state = loadState(payload.cwd, payload.sessionId);
  if (!state.needsReload) {
    finish({});
    return;
  }

  const compileResult = runNpmCommand(payload.cwd, ['run', 'compile']);
  if (!compileResult.ok) {
    finish({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        decision: 'block',
        reason: buildFailureReason('npm run compile', state.changedFiles, compileResult.output)
      }
    });
    return;
  }

  const loadResult = runNpmCommand(payload.cwd, ['run', 'load:local']);
  if (!loadResult.ok) {
    finish({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        decision: 'block',
        reason: buildFailureReason('npm run load:local', state.changedFiles, loadResult.output)
      }
    });
    return;
  }

  state.needsReload = false;
  state.changedFiles = [];
  saveState(payload.cwd, payload.sessionId, state);

  finish({
    systemMessage: 'Local dev hook: source edits detected, and compile + load:local completed successfully.'
  });
}

function extractChangedFiles(payload) {
  if (payload.tool_name === 'create_file') {
    return normalizeFileList(payload.cwd, [payload.tool_input?.filePath]);
  }

  if (payload.tool_name === 'vscode_renameSymbol') {
    return normalizeFileList(payload.cwd, [payload.tool_input?.filePath]);
  }

  if (payload.tool_name === 'apply_patch') {
    const patchText = payload.tool_input?.input || '';
    const matches = patchText.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm) || [];
    const filePaths = matches.map((line) => line.replace(/^\*\*\* (?:Add|Update|Delete) File:\s*/, '').trim());
    return normalizeFileList(payload.cwd, filePaths);
  }

  return [];
}

function normalizeFileList(workspaceRoot, filePaths) {
  return filePaths
    .filter(Boolean)
    .map((filePath) => toWorkspaceRelative(workspaceRoot, filePath))
    .filter(Boolean);
}

function toWorkspaceRelative(workspaceRoot, filePath) {
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalizedPath = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(normalizedRoot, filePath);
  const relativePath = path.relative(normalizedRoot, normalizedPath);
  if (relativePath.startsWith('..')) {
    return null;
  }

  return relativePath.replace(/\\/g, '/');
}

function isRelevantSourceFile(relativePath) {
  if (!relativePath) {
    return false;
  }

  const normalizedPath = relativePath.replace(/\\/g, '/');
  if (normalizedPath.startsWith('.github/')) {
    return false;
  }

  if (normalizedPath.endsWith('.md')) {
    return false;
  }

  const extension = path.posix.extname(normalizedPath);
  return SOURCE_EXTENSIONS.has(extension);
}

function runNpmCommand(cwd, args) {
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', ['npm', ...args].join(' ')], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    : spawnSync('npm', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });

  const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return {
    ok: result.status === 0,
    output: combinedOutput || result.error?.message || 'Command failed without output.'
  };
}

function buildFailureReason(command, changedFiles, output) {
  const changedSummary = changedFiles.length > 0
    ? `Changed files: ${changedFiles.join(', ')}`
    : 'Changed files: unknown';
  return `Local dev hook blocked stop because ${command} failed. ${changedSummary}\n\n${tail(output, 20, 1600)}`;
}

function loadState(workspaceRoot, sessionId) {
  const filePath = getStateFilePath(workspaceRoot, sessionId);
  if (!fs.existsSync(filePath)) {
    return {
      changedFiles: [],
      needsReload: false
    };
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {
      changedFiles: [],
      needsReload: false
    };
  }
}

function saveState(workspaceRoot, sessionId, state) {
  const filePath = getStateFilePath(workspaceRoot, sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state), 'utf8');
}

function getStateFilePath(workspaceRoot, sessionId) {
  const workspaceHash = crypto.createHash('sha1').update(path.resolve(workspaceRoot)).digest('hex');
  return path.join(os.tmpdir(), 'vscode-copilot-hooks', workspaceHash, `${sessionId}.json`);
}

function readPayload() {
  const input = fs.readFileSync(0, 'utf8').trim();
  return input ? JSON.parse(input) : {};
}

function tail(text, maxLines, maxChars) {
  const lines = text.split(/\r?\n/);
  const lastLines = lines.slice(-maxLines).join('\n');
  if (lastLines.length <= maxChars) {
    return lastLines;
  }

  return lastLines.slice(lastLines.length - maxChars);
}

function finish(output) {
  process.stdout.write(JSON.stringify(output));
}