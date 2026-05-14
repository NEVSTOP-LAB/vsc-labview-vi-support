const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join, resolve } = require("node:path");

const packageJson = require("../package.json");

if (process.platform !== "win32") {
  console.error("install:vsix currently supports Windows only.");
  process.exit(1);
}

const workspaceRoot = resolve(__dirname, "..");
const vsixPath = resolve(
  workspaceRoot,
  `${packageJson.name}-${packageJson.version}.vsix`
);

if (!existsSync(vsixPath)) {
  console.error(`VSIX not found: ${vsixPath}`);
  process.exit(1);
}

const candidates = [
  process.env.LOCALAPPDATA &&
    join(
      process.env.LOCALAPPDATA,
      "Programs",
      "Microsoft VS Code",
      "bin",
      "code.cmd"
    ),
  process.env.LOCALAPPDATA &&
    join(
      process.env.LOCALAPPDATA,
      "Programs",
      "Microsoft VS Code Insiders",
      "bin",
      "code-insiders.cmd"
    ),
  process.env.ProgramFiles &&
    join(
      process.env.ProgramFiles,
      "Microsoft VS Code",
      "bin",
      "code.cmd"
    ),
  process.env["ProgramFiles(x86)"] &&
    join(
      process.env["ProgramFiles(x86)"],
      "Microsoft VS Code",
      "bin",
      "code.cmd"
    ),
].filter((candidate, index, all) => candidate && existsSync(candidate) && all.indexOf(candidate) === index);

if (!candidates.length) {
  console.error("VS Code CLI not found. Expected code.cmd in a standard VS Code install location.");
  process.exit(1);
}

for (const command of candidates) {
  const escapedCommand = command.replace(/'/g, "''");
  const escapedVsixPath = vsixPath.replace(/'/g, "''");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `& '${escapedCommand}' --install-extension '${escapedVsixPath}' --force`,
  ], {
    stdio: "inherit",
  });

  if (result.status === 0) {
    process.exit(0);
  }
}

console.error("Failed to install VSIX with the detected VS Code CLI.");
process.exit(1);