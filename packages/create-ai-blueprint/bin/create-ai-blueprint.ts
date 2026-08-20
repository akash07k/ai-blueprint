#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  formatHumanStatus,
  readProjectStatus,
  shouldUseColor
} from "../lib/status.js";
import { MANIFEST_PATH, applyPreparedUpdate, prepareUpdate, writeInstallManifest } from "../lib/update.js";
import type { AdapterMode, PreparedUpdate, UpdateResult } from "../lib/update.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..", "..");
const templateRoot = path.join(packageRoot, "template");

interface CliOptions {
  adapter: AdapterMode | null;
  command: "install" | "status" | "update";
  dryRun: boolean;
  force: boolean;
  help: boolean;
  json: boolean;
  target: string | null;
  version: boolean;
  yes: boolean;
}

interface TemplateEntry {
  source: string;
  target: string;
}

const adapterChoices = new Set<AdapterMode>(["codex", "claude", "both"]);

async function runCli(
  args: readonly string[] = process.argv.slice(2),
  surface: "package" | "global" = "package"
): Promise<void> {
  if (surface === "global" && args.length === 0) {
    printGlobalHelp();
    return;
  }

  const options = parseArgs(args);

  if (options.help) {
    surface === "global" ? printGlobalHelp() : printHelp();
    return;
  }

  if (options.version) {
    console.log(readPackageVersion());
    return;
  }

  if (surface === "global" && options.command !== "status") {
    throw new Error(
      "The global blueprint command supports project status only. Use `npx @akash07k/create-ai-blueprint@latest` to install Blueprint or `npx @akash07k/create-ai-blueprint@latest update` to update it."
    );
  }

  const targetDir = path.resolve(process.cwd(), options.target || ".");

  if (options.command === "status") {
    const status = await readProjectStatus(targetDir);
    console.log(
      options.json
        ? JSON.stringify(status, null, 2)
        : formatHumanStatus(status, { color: shouldUseColor() })
    );
    return;
  }

  if (!fsSync.existsSync(templateRoot)) {
    throw new Error(
      "Installer template is missing. Run `npm run prepare-template` before local testing."
    );
  }

  const version = readPackageVersion();

  if (options.command === "update") {
    const prepared = await prepareUpdate({
      targetDir,
      templateRoot,
      version
    });
    printUpdatePlan(prepared);

    if (options.dryRun) {
      return;
    }

    const replaceConflicts =
      options.force || (await confirmUpdateConflicts(prepared, options));
    const result = await applyPreparedUpdate(prepared, { replaceConflicts });
    printUpdateSuccess(prepared, result);
    return;
  }

  const adapter = await resolveAdapter(options);
  const entries = getTemplateEntries(adapter);
  const existingEntries = entries.filter((entry) =>
    fsSync.existsSync(path.join(targetDir, entry.target))
  );

  if (options.dryRun) {
    printPlan(targetDir, adapter, entries, existingEntries);
    return;
  }

  await confirmOverwrite(existingEntries, options);

  for (const entry of entries) {
    await copyTemplateEntry(entry, targetDir);
  }

  await writeInstallManifest({
    targetDir,
    templateRoot,
    version,
    adapter
  });

  printSuccess(targetDir, adapter, entries, existingEntries);
  await offerGlobalCliInstall(options, version);
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    adapter: null,
    command: "install",
    dryRun: false,
    force: false,
    help: false,
    json: false,
    target: null,
    version: false,
    yes: false
  };

  const modeFlags: AdapterMode[] = [];
  let commandSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "init") {
      continue;
    }

    if (arg === "status" || arg === "update") {
      if (commandSeen) {
        throw new Error("Choose only one command.");
      }

      options.command = arg;
      commandSeen = true;
      continue;
    }

    if (arg === "--") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      options.version = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--force" || arg === "-f") {
      options.force = true;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
      continue;
    }

    if (arg === "--codex" || arg === "--claude" || arg === "--both") {
      modeFlags.push(arg.slice(2) as AdapterMode);
      continue;
    }

    if (arg === "--target" || arg === "-t") {
      const next = args[index + 1];
      if (!next) {
        throw new Error(`${arg} needs a directory path.`);
      }
      options.target = next;
      index += 1;
      continue;
    }

    if (arg.startsWith("--target=")) {
      options.target = arg.slice("--target=".length);
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (modeFlags.length > 1) {
    throw new Error("Choose only one adapter option: --codex, --claude, or --both.");
  }

  options.adapter = modeFlags[0] || null;

  if (options.command === "update" && options.adapter) {
    throw new Error(
      "Update detects the installed adapters. Do not pass --codex, --claude, or --both."
    );
  }

  if (options.command !== "status" && options.json) {
    throw new Error("--json is available only with the status command.");
  }

  if (
    options.command === "status" &&
    (options.adapter || options.dryRun || options.force || options.yes)
  ) {
    throw new Error(
      "Status accepts only --json, --target, --help, and --version options."
    );
  }

  return options;
}

async function resolveAdapter(options: CliOptions): Promise<AdapterMode> {
  if (options.adapter) {
    return options.adapter;
  }

  if (options.yes || !process.stdin.isTTY) {
    return "both";
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = await rl.question(
      "Install which adapters? [1] Codex, [2] Claude Code, [3] both (default): "
    );

    const normalized = answer.trim().toLowerCase();

    if (normalized === "" || normalized === "3" || normalized === "both") {
      return "both";
    }

    if (normalized === "1" || normalized === "codex") {
      return "codex";
    }

    if (
      normalized === "2" ||
      normalized === "claude" ||
      normalized === "claude code"
    ) {
      return "claude";
    }

    throw new Error("Choose 1, 2, or 3.");
  } finally {
    rl.close();
  }
}

function getTemplateEntries(adapter: AdapterMode): TemplateEntry[] {
  if (!adapterChoices.has(adapter)) {
    throw new Error(`Unknown adapter mode: ${adapter}`);
  }

  const entries = [
    { source: "AGENTS.md", target: "AGENTS.md" },
    { source: "blueprint", target: "blueprint" }
  ];

  if (adapter === "codex" || adapter === "both") {
    entries.push({ source: ".agents", target: ".agents" });
  }

  if (adapter === "claude" || adapter === "both") {
    entries.push({ source: "CLAUDE.md", target: "CLAUDE.md" });
    entries.push({ source: ".claude", target: ".claude" });
  }

  return entries;
}

async function confirmOverwrite(
  existingEntries: readonly TemplateEntry[],
  options: CliOptions
): Promise<void> {
  if (existingEntries.length === 0 || options.force) {
    return;
  }

  if (options.yes || !process.stdin.isTTY) {
    throw new Error(
      `Existing Blueprint files found: ${existingEntries
        .map((entry) => entry.target)
        .join(", ")}. Re-run with --force to overwrite them.`
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    console.log("Existing Blueprint files found:");
    for (const entry of existingEntries) {
      console.log(`- ${entry.target}`);
    }

    const answer = await rl.question("Overwrite matching Blueprint files? [y/N] ");

    if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
      throw new Error("Install cancelled.");
    }
  } finally {
    rl.close();
  }
}

async function confirmUpdateConflicts(
  prepared: PreparedUpdate,
  options: CliOptions
): Promise<boolean> {
  const count = prepared.plan.conflicts.length;

  if (count === 0) {
    return false;
  }

  if (options.yes || !process.stdin.isTTY) {
    throw new Error(
      `${count} managed file conflict${count === 1 ? "" : "s"} found. Run the update interactively to review them, or pass --force to back them up and replace them.`
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = await rl.question(
      `Back up and replace ${count} conflicting managed file${count === 1 ? "" : "s"}? [y/N] `
    );
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function copyTemplateEntry(entry: TemplateEntry, targetDir: string): Promise<void> {
  const source = path.join(templateRoot, entry.source);
  const target = path.join(targetDir, entry.target);
  await copyPath(source, target);
}

async function copyPath(source: string, target: string): Promise<void> {
  const stats = await fs.stat(source);

  if (stats.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    const children = await fs.readdir(source);

    for (const child of children) {
      await copyPath(path.join(source, child), path.join(target, child));
    }

    return;
  }

  if (stats.isFile()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}

function printPlan(
  targetDir: string,
  adapter: AdapterMode,
  entries: readonly TemplateEntry[],
  existingEntries: readonly TemplateEntry[]
): void {
  console.log(`Target: ${targetDir}`);
  console.log(`Adapters: ${adapter}`);
  console.log("Would copy:");

  for (const entry of entries) {
    console.log(`- ${entry.target}`);
  }

  if (existingEntries.length > 0) {
    console.log("Would overwrite matching files under:");
    for (const entry of existingEntries) {
      console.log(`- ${entry.target}`);
    }
  }
}

function printUpdatePlan(prepared: PreparedUpdate): void {
  const { plan } = prepared;
  console.log("AI Blueprint update plan.");
  console.log(`Target: ${prepared.targetDir}`);
  console.log(`Adapters: ${prepared.adapters.join(", ")}`);
  console.log(`Version: ${prepared.previousVersion} -> ${prepared.version}`);
  console.log(`Add: ${plan.add.length}`);
  console.log(`Update: ${plan.update.length}`);
  console.log(`Remove: ${plan.remove.length}`);
  console.log(`Conflicts: ${plan.conflicts.length}`);
  console.log(`Unchanged: ${plan.unchanged.length}`);

  if (plan.conflicts.length > 0) {
    console.log("Conflicting managed files:");
    for (const conflict of plan.conflicts) {
      console.log(`- ${conflict.path} (${conflict.reason})`);
    }
  }

  console.log(
    "Preserved: AGENTS.md, CLAUDE.md, project and build plans, context, history, references, and prototypes."
  );
}

function printSuccess(
  targetDir: string,
  adapter: AdapterMode,
  entries: readonly TemplateEntry[],
  existingEntries: readonly TemplateEntry[]
): void {
  console.log("AI Blueprint installed.");
  console.log(`Target: ${targetDir}`);
  console.log(`Adapters: ${adapter}`);
  console.log("Copied:");

  for (const entry of entries) {
    console.log(`- ${entry.target}`);
  }
  console.log(`- ${MANIFEST_PATH}`);

  if (existingEntries.length > 0) {
    console.log("Overwrote matching Blueprint files where paths already existed.");
  }

  console.log("");
  console.log("Your app README was left alone.");
  console.log("Blueprint docs are at blueprint/README.md.");
  console.log("");
  console.log("Next:");
  console.log(getNextCommand(adapter));
  printClaudeRestartNote(adapter);
  console.log(
    "If a different skill loads, tell the agent to follow the local Blueprint skill file directly."
  );
}

function printUpdateSuccess(prepared: PreparedUpdate, result: UpdateResult): void {
  console.log("AI Blueprint updated.");
  console.log(`Version: ${prepared.previousVersion} -> ${prepared.version}`);
  console.log(`Added: ${result.added}`);
  console.log(`Updated: ${result.updated}`);
  console.log(`Removed: ${result.removed}`);
  console.log(`Unchanged: ${result.unchanged}`);

  if (result.backupDir) {
    console.log(`Backup: ${path.relative(prepared.targetDir, result.backupDir)}`);
  }

  console.log(
    "Preserved user-owned plans, context, history, references, prototypes, AGENTS.md, and CLAUDE.md."
  );
}

function getNextCommand(adapter: AdapterMode): string {
  if (adapter === "codex") {
    return "$onboard";
  }

  if (adapter === "claude") {
    return "/onboard";
  }

  return "$onboard or /onboard";
}

function printClaudeRestartNote(adapter: AdapterMode): void {
  if (adapter === "codex") {
    return;
  }

  console.log(
    "Claude Code: if this project was already open, restart Claude Code in this folder so /onboard appears."
  );
}

async function offerGlobalCliInstall(
  options: CliOptions,
  version: string
): Promise<void> {
  const command = getGlobalCliInstallCommand(version);

  if (!shouldOfferGlobalCliInstall(options)) {
    printOptionalGlobalCli(command);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  let answer = "";

  try {
    answer = await rl.question(
      `\nInstall the global blueprint command?\nThis runs: ${command}\nContinue? [y/N]: `
    );
  } finally {
    rl.close();
  }

  if (!isGlobalCliInstallConfirmed(answer)) {
    printOptionalGlobalCli(command);
    return;
  }

  try {
    await installGlobalCli(version);
    console.log("\nGlobal CLI installed. Run `blueprint status` from a Blueprint project.");
  } catch (error: unknown) {
    console.error(
      `\nGlobal CLI was not installed: ${error instanceof Error ? error.message : String(error)}`
    );
    printOptionalGlobalCli(command);
  }
}

function shouldOfferGlobalCliInstall(
  options: CliOptions,
  isTTY: boolean | undefined = process.stdin.isTTY
): boolean {
  return options.command === "install" && !options.yes && isTTY === true;
}

function isGlobalCliInstallConfirmed(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

function getGlobalCliInstallCommand(version: string): string {
  return `npm install --global @akash07k/create-ai-blueprint@${version}`;
}

async function installGlobalCli(version: string): Promise<void> {
  const npmExecPath = process.env.npm_execpath;
  const packageSpec = `@akash07k/create-ai-blueprint@${version}`;
  const command = npmExecPath
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const args = npmExecPath
    ? [npmExecPath, "install", "--global", packageSpec]
    : ["install", "--global", packageSpec];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: "inherit"
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `npm stopped with signal ${signal}`
            : `npm exited with code ${code ?? "unknown"}`
        )
      );
    });
  });
}

function printOptionalGlobalCli(command: string): void {
  console.log(`\nOptional global CLI:\n  ${command}\n  blueprint status`);
}

function printHelp(): void {
  console.log(`@akash07k/create-ai-blueprint

Install AI Blueprint into an already scaffolded app.

Usage:
  npx @akash07k/create-ai-blueprint@latest
  npx @akash07k/create-ai-blueprint@latest update
  npx @akash07k/create-ai-blueprint@latest status
  npx @akash07k/create-ai-blueprint@latest status --json
  npx @akash07k/create-ai-blueprint@latest -- --codex
  npx @akash07k/create-ai-blueprint@latest -- --claude
  npx @akash07k/create-ai-blueprint@latest -- --both

Options:
  --codex          Install AGENTS.md, .agents/, and blueprint/
  --claude         Install AGENTS.md, CLAUDE.md, .claude/, and blueprint/
  --both           Install both Codex and Claude Code adapters
  --target, -t     Target directory, defaults to the current directory
  --force, -f      Install: overwrite matching files. Update: back up and replace managed conflicts
  --yes, -y        Use defaults in non-interactive installs
  --dry-run        Print what would be copied without writing files
  --json            Print status as one JSON object
  --help, -h       Show help
  --version, -v    Show package version`);
}

function printGlobalHelp(): void {
  console.log(`blueprint

Read AI Blueprint project status.

This optional global command does not install or update Blueprint.

Usage:
  blueprint status
  blueprint status --json
  blueprint status --target ./my-app

Options:
  --target, -t     Project directory, defaults to the current directory
  --json            Print status as one JSON object
  --help, -h       Show help
  --version, -v    Show package version

Install or update Blueprint with:
  npx @akash07k/create-ai-blueprint@latest
  npx @akash07k/create-ai-blueprint@latest update`);
}

function readPackageVersion(): string {
  const packageJson = fsSync.readFileSync(
    path.join(packageRoot, "package.json"),
    "utf8"
  );
  const packageMetadata: unknown = JSON.parse(packageJson);

  if (
    typeof packageMetadata !== "object" ||
    packageMetadata === null ||
    typeof (packageMetadata as { version?: unknown }).version !== "string"
  ) {
    throw new Error("Package metadata has no valid version.");
  }

  return (packageMetadata as { version: string }).version;
}

if (
  process.argv[1] &&
  fsSync.realpathSync(process.argv[1]) === fsSync.realpathSync(fileURLToPath(import.meta.url))
) {
  runCli().catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export {
  getGlobalCliInstallCommand,
  getTemplateEntries,
  isGlobalCliInstallConfirmed,
  parseArgs,
  runCli,
  shouldOfferGlobalCliInstall
};
