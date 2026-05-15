const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDIT_TOOLS = new Set(['apply_patch', 'create_file', 'vscode_renameSymbol']);
const DOC_PATH_PREFIX = '.doc/';
const ROOT_DOC_FILES = new Set(['README.md']);
const IGNORED_PATH_PREFIXES = [
  '.git/',
  '.vscode/',
  '.vscode-test/',
  'dist/',
  'node_modules/',
  'out/',
  '.venv/'
];

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

  const changedFiles = extractChangedFiles(payload).filter(isTrackedFile);
  if (changedFiles.length === 0) {
    finish({});
    return;
  }

  const state = loadState(payload.cwd, payload.sessionId);
  state.editBatch = (state.editBatch || 0) + 1;

  const changedWorkFiles = changedFiles.filter(isWorkFile);
  const changedDocFiles = changedFiles.filter(isDocFile);
  const changedSubstantiveDocFiles = changedDocFiles.filter(isSubstantiveDocFile);

  if (changedWorkFiles.length > 0) {
    state.changedWorkFiles = mergeSorted(state.changedWorkFiles, changedWorkFiles);
    state.lastWorkBatch = state.editBatch;
  }

  if (changedDocFiles.length > 0) {
    state.changedDocFiles = mergeSorted(state.changedDocFiles, changedDocFiles);
  }

  if (changedSubstantiveDocFiles.length > 0) {
    state.changedSubstantiveDocFiles = mergeSorted(state.changedSubstantiveDocFiles, changedSubstantiveDocFiles);
    state.lastDocBatch = state.editBatch;
  }

  state.needsDocUpdate = Boolean(state.lastWorkBatch) && (state.lastDocBatch || 0) < state.lastWorkBatch;
  saveState(payload.cwd, payload.sessionId, state);
  finish({});
}

function handleStop(payload) {
  const state = loadState(payload.cwd, payload.sessionId);
  if (state.needsDocUpdate) {
    finish({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        decision: 'block',
        reason: buildFailureReason(state)
      }
    });
    return;
  }

  resetState(payload.cwd, payload.sessionId);
  finish({});
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

function isTrackedFile(relativePath) {
  if (!relativePath) {
    return false;
  }

  const normalizedPath = relativePath.replace(/\\/g, '/');
  return !IGNORED_PATH_PREFIXES.some((prefix) => normalizedPath === prefix.slice(0, -1) || normalizedPath.startsWith(prefix));
}

function isDocFile(relativePath) {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  return ROOT_DOC_FILES.has(normalizedPath) || normalizedPath.startsWith(DOC_PATH_PREFIX);
}

function isSubstantiveDocFile(relativePath) {
  return isDocFile(relativePath) && relativePath.replace(/\\/g, '/') !== '.doc/CHANGELOG.md';
}

function isWorkFile(relativePath) {
  return !isDocFile(relativePath);
}

function buildFailureReason(state) {
  const changedWorkSummary = state.changedWorkFiles.length > 0
    ? state.changedWorkFiles.join(', ')
    : 'unknown';
  const changedDocSummary = state.changedDocFiles.length > 0
    ? state.changedDocFiles.join(', ')
    : 'none';
  const substantiveDocSummary = state.changedSubstantiveDocFiles.length > 0
    ? state.changedSubstantiveDocFiles.join(', ')
    : 'none';
  const timingHint = state.changedSubstantiveDocFiles.length > 0
    ? 'Documentation was edited earlier in this session, but not after the latest non-documentation change.'
    : state.changedDocFiles.includes('.doc/CHANGELOG.md')
      ? 'Only .doc/CHANGELOG.md was updated so far; it does not satisfy the documentation sync check by itself.'
      : 'No documentation files were edited after the latest non-documentation change.';

  return [
    'Documentation update hook blocked stop because non-documentation edits are newer than the latest documentation edit.',
    `Changed non-documentation files: ${changedWorkSummary}`,
    `Changed documentation files: ${changedDocSummary}`,
    `Changed substantive documentation files: ${substantiveDocSummary}`,
    timingHint,
    'Update README.md or files under .doc/, and append a matching entry to .doc/CHANGELOG.md when documentation changes.'
  ].join('\n');
}

function mergeSorted(existingFiles = [], newFiles = []) {
  return Array.from(new Set([...existingFiles, ...newFiles])).sort();
}

function loadState(workspaceRoot, sessionId) {
  const filePath = getStateFilePath(workspaceRoot, sessionId);
  if (!fs.existsSync(filePath)) {
    return createEmptyState();
  }

  try {
    return {
      ...createEmptyState(),
      ...JSON.parse(fs.readFileSync(filePath, 'utf8'))
    };
  } catch {
    return createEmptyState();
  }
}

function resetState(workspaceRoot, sessionId) {
  const filePath = getStateFilePath(workspaceRoot, sessionId);
  if (!fs.existsSync(filePath)) {
    return;
  }

  fs.writeFileSync(filePath, JSON.stringify(createEmptyState()), 'utf8');
}

function saveState(workspaceRoot, sessionId, state) {
  const filePath = getStateFilePath(workspaceRoot, sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state), 'utf8');
}

function getStateFilePath(workspaceRoot, sessionId) {
  const workspaceHash = crypto.createHash('sha1').update(path.resolve(workspaceRoot)).digest('hex');
  return path.join(os.tmpdir(), 'vscode-copilot-hooks', workspaceHash, `${sessionId}-docs.json`);
}

function createEmptyState() {
  return {
    changedDocFiles: [],
    changedSubstantiveDocFiles: [],
    changedWorkFiles: [],
    editBatch: 0,
    lastDocBatch: 0,
    lastWorkBatch: 0,
    needsDocUpdate: false
  };
}

function readPayload() {
  const input = fs.readFileSync(0, 'utf8').trim();
  return input ? JSON.parse(input) : {};
}

function finish(output) {
  process.stdout.write(JSON.stringify(output));
}