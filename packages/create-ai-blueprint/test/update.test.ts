import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  ADAPTER_PROMPT,
  formatCommandArgument,
  getTemplateEntries,
  getGlobalCliInstallCommand,
  isGlobalCliInstallConfirmed,
  parseArgs,
  resolveAdapter,
  runCli,
  shouldOfferGlobalCliInstall
} from "../bin/create-ai-blueprint.js";
import type { CliRuntime } from "../bin/create-ai-blueprint.js";
import {
  CONTROL_DIR,
  MANIFEST_PATH,
  adapterListFromMode,
  applyPreparedSync,
  applyPreparedUpdate,
  prepareSync,
  prepareUpdate,
  readManifest,
  writeInstallManifest
} from "../lib/update.js";

test("adapter prompt lists Copilot first and defaults to it", () => {
  assert.equal(
    ADAPTER_PROMPT,
    "Install which adapter?\n" +
      "  [1] GitHub Copilot (default)\n" +
      "  [2] Codex\n" +
      "  [3] Claude Code\n" +
      "  [4] all\n" +
      "> "
  );
});

test("parseArgs supports install and update modes", () => {
  assert.equal(parseArgs([]).command, "install");
  assert.deepEqual(parseArgs(["update", "--dry-run"]), {
    adapter: null,
    command: "update",
    deprecatedBoth: false,
    dryRun: true,
    force: false,
    help: false,
    json: false,
    target: null,
    version: false,
    yes: false
  });
  assert.deepEqual(parseArgs(["status", "--json", "--target", "./app"]), {
    adapter: null,
    command: "status",
    deprecatedBoth: false,
    dryRun: false,
    force: false,
    help: false,
    json: true,
    target: "./app",
    version: false,
    yes: false
  });
  assert.deepEqual(parseArgs(["sync", "--dry-run", "--force", "--target", "./app"]), {
    adapter: null,
    command: "sync",
    deprecatedBoth: false,
    dryRun: true,
    force: true,
    help: false,
    json: false,
    target: "./app",
    version: false,
    yes: false
  });
  assert.throws(
    () => parseArgs(["update", "--codex"]),
    /Update detects the installed adapters/
  );
  assert.throws(
    () => parseArgs(["status", "--force"]),
    /Status accepts only/
  );
  assert.throws(
    () => parseArgs(["--json"]),
    /--json is available only with the status command/
  );
  assert.throws(() => parseArgs(["sync", "--json"]), /Sync accepts only/);
  assert.throws(() => parseArgs(["sync", "--codex"]), /Sync accepts only/);
  assert.throws(() => parseArgs(["sync", "--yes"]), /Sync accepts only/);
  assert.equal(parseArgs(["--copilot"]).adapter, "copilot");
  assert.equal(parseArgs(["--all"]).adapter, "all");
  assert.deepEqual(
    parseArgs(["--both"]),
    {
      adapter: "all",
      command: "install",
      deprecatedBoth: true,
      dryRun: false,
      force: false,
      help: false,
      json: false,
      target: null,
      version: false,
      yes: false
    }
  );
});

test("package sync dry run prints a skills-only plan without writes", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const rootGitIgnore = await fs.readFile(path.join(targetDir, ".gitignore"), "utf8");
  await fs.rm(path.join(targetDir, ".agents/skills/check/SKILL.md"));

  const output = await captureConsole(() =>
    runCli(["sync", "--dry-run", "--target", targetDir], "package", cliRuntime(templateRoot))
  );

  assert.match(output, /AI Blueprint skill sync plan/);
  assert.match(output, /Scope: generated Blueprint adapter skills only/);
  await assert.rejects(fs.access(path.join(targetDir, ".agents/skills/check/SKILL.md")), {
    code: "ENOENT"
  });
  assert.equal(await fs.readFile(path.join(targetDir, ".gitignore"), "utf8"), rootGitIgnore);
});

test("package and global sync restore skills and forward force conflict replacement", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const skillPath = path.join(targetDir, ".agents/skills/check/SKILL.md");
  await fs.rm(skillPath);
  await captureConsole(() => runCli(["sync", "--target", targetDir], "global", cliRuntime(templateRoot)));
  assert.equal(await fs.readFile(skillPath, "utf8"), "Check skill\n");

  await fs.writeFile(skillPath, "Customized skill\n");
  const output = await captureConsole(() =>
    runCli(["sync", "--force", "--target", targetDir], "package", cliRuntime(templateRoot))
  );

  assert.match(output, /Backup:/);
  assert.equal(await fs.readFile(skillPath, "utf8"), "Check skill\n");
  const backupDirectories = await fs.readdir(path.join(targetDir, CONTROL_DIR, "backups"));
  assert.equal(backupDirectories.length, 1);
});

test("sync prints a version-pinned recovery command without writes", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target with spaces");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const manifest = await fs.readFile(manifestPath, "utf8");
  await fs.rm(path.join(targetDir, ".agents/skills/check/SKILL.md"));

  const output = await captureConsole(() =>
    runCli(
      ["sync", "--target", targetDir],
      "package",
      { ...cliRuntime(templateRoot), version: "1.1.0" }
    )
  );

  assert.match(
    output,
    new RegExp(
      `npx @akash07k/create-ai-blueprint@1\\.0\\.0 sync --target ${escapeRegExp(
        formatCommandArgument(targetDir)
      )}`
    )
  );
  await assert.rejects(fs.access(path.join(targetDir, ".agents/skills/check/SKILL.md")), {
    code: "ENOENT"
  });
  assert.equal(await fs.readFile(manifestPath, "utf8"), manifest);
});

test("sync rejects unsafe locked versions before recovery output", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  const manifest = await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const unsafeManifest = `${JSON.stringify(
    { ...manifest, version: "1.0.0; echo unsafe" },
    null,
    2
  )}\n`;
  const skillPath = path.join(targetDir, ".agents/skills/check/SKILL.md");
  await fs.writeFile(manifestPath, unsafeManifest);
  await fs.rm(skillPath);

  await assert.rejects(
    runCli(["sync", "--target", targetDir], "package", {
      ...cliRuntime(templateRoot),
      version: "1.1.0"
    }),
    /Unsupported or invalid Blueprint manifest/
  );

  await assert.rejects(fs.access(skillPath), { code: "ENOENT" });
  assert.equal(await fs.readFile(manifestPath, "utf8"), unsafeManifest);
});

test("recovery command arguments quote shell-special target paths by platform", () => {
  assert.equal(formatCommandArgument("./app", "linux"), "./app");
  assert.equal(formatCommandArgument("/tmp/Blueprint Projects/app", "linux"), "'/tmp/Blueprint Projects/app'");
  assert.equal(formatCommandArgument("/tmp/Blueprint's/app", "linux"), "'/tmp/Blueprint'\"'\"'s/app'");
  assert.equal(formatCommandArgument("C:\\Blueprint Projects\\app", "win32"), "\"C:\\Blueprint Projects\\app\"");
  assert.equal(
    formatCommandArgument("C:\\Blueprint&skills\\app", "win32"),
    "\"C:\\Blueprint&skills\\app\""
  );
});

test("global CLI continues to reject update and upgrade", async () => {
  await assert.rejects(
    runCli(["update"], "global", cliRuntime("missing-template")),
    /supports project status and skill sync only/
  );
  await assert.rejects(runCli(["upgrade"], "global", cliRuntime("missing-template")), /Unknown option/);
});

test("Copilot is the non-interactive and --yes install default", async () => {
  assert.equal(await resolveAdapter(parseArgs([]), false), "copilot");
  assert.equal(await resolveAdapter(parseArgs(["--yes"]), true), "copilot");
});

test("Copilot shares the .agents adapter files without managing Copilot instructions", () => {
  assert.deepEqual(
    getTemplateEntries("copilot").map((entry) => entry.target),
    ["AGENTS.md", "blueprint", ".agents"]
  );
  assert.deepEqual(
    getTemplateEntries("all").map((entry) => entry.target),
    ["AGENTS.md", "blueprint", ".agents", "CLAUDE.md", ".claude"]
  );
  assert.deepEqual(adapterListFromMode("all"), ["codex", "claude", "copilot"]);
});

test("global CLI installation is offered only after an interactive install", () => {
  assert.equal(shouldOfferGlobalCliInstall(parseArgs([]), true), true);
  assert.equal(shouldOfferGlobalCliInstall(parseArgs([]), false), false);
  assert.equal(
    shouldOfferGlobalCliInstall(parseArgs(["--yes"]), true),
    false
  );
  assert.equal(
    shouldOfferGlobalCliInstall(parseArgs(["update"]), true),
    false
  );
  assert.equal(isGlobalCliInstallConfirmed("y"), true);
  assert.equal(isGlobalCliInstallConfirmed(" YES "), true);
  assert.equal(isGlobalCliInstallConfirmed(""), false);
  assert.equal(isGlobalCliInstallConfirmed("no"), false);
  assert.equal(
    getGlobalCliInstallCommand("0.9.0"),
    "npm install --global @akash07k/create-ai-blueprint@0.9.0"
  );
});

test("new installs record only Blueprint-owned managed files", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeFiles(targetDir, {
    "AGENTS.md": "Project instructions\n",
    "blueprint/build-plan.md": "Project roadmap\n",
    ".gitignore": "node_modules/\ncustom-rule\n"
  });

  const manifest = await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });

  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.packageName, "@akash07k/create-ai-blueprint");
  assert.deepEqual(manifest.adapters, ["codex"]);
  assert.deepEqual(Object.keys(manifest.managedFiles), [
    ".agents/skills/check/SKILL.md",
    "blueprint/README.md"
  ]);
  assert.equal(
    await fs.readFile(path.join(targetDir, CONTROL_DIR, ".gitignore"), "utf8"),
    "backups/\nstaging/\n"
  );
  assert.equal(
    await fs.readFile(path.join(targetDir, ".gitignore"), "utf8"),
    "node_modules/\n" +
      "custom-rule\n\n" +
      "# BEGIN AI BLUEPRINT MANAGED SKILLS\n" +
      "/.agents/skills/check/\n" +
      "# END AI BLUEPRINT MANAGED SKILLS\n"
  );
  assert.equal((await readManifest(targetDir))?.version, "1.0.0");
  await assert.rejects(fs.access(path.join(targetDir, ".ai-blueprint")), {
    code: "ENOENT"
  });
  assert.equal(
    await fs.readFile(path.join(targetDir, "blueprint/build-plan.md"), "utf8"),
    "Project roadmap\n"
  );
});

test("managed skill ignore blocks replace only their markers and preserve custom skills", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const originalGitIgnore =
    "before\r\n" +
    "custom-rule\r\n" +
    "# BEGIN AI BLUEPRINT MANAGED SKILLS\r\n" +
    ".agents/skills/stale/\r\n" +
    "# END AI BLUEPRINT MANAGED SKILLS\r\n" +
    "after";

  await writeFiles(templateRoot, {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/zeta/SKILL.md": "Zeta skill\n",
    ".agents/skills/alpha/SKILL.md": "Alpha skill\n",
    ".agents/skills/alpha/reference.md": "Alpha reference\n",
    ".claude/skills/beta/SKILL.md": "Beta skill\n"
  });
  await writeFiles(targetDir, {
    ".gitignore": originalGitIgnore,
    ".agents/skills/custom/SKILL.md": "Custom skill\n",
    ".claude/skills/private/SKILL.md": "Private skill\n"
  });

  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "all"
  });
  const expectedGitIgnore =
    "before\r\n" +
    "custom-rule\r\n" +
    "# BEGIN AI BLUEPRINT MANAGED SKILLS\n" +
    "/.agents/skills/alpha/\n" +
    "/.agents/skills/zeta/\n" +
    "/.claude/skills/beta/\n" +
    "# END AI BLUEPRINT MANAGED SKILLS\n" +
    "after";

  assert.equal(await fs.readFile(path.join(targetDir, ".gitignore"), "utf8"), expectedGitIgnore);
  assert.doesNotMatch(expectedGitIgnore, /\.agents\/skills\/custom\//);
  assert.doesNotMatch(expectedGitIgnore, /\.claude\/skills\/private\//);
  assert.equal(
    await fs.readFile(path.join(targetDir, ".agents/skills/custom/SKILL.md"), "utf8"),
    "Custom skill\n"
  );
  assert.equal(
    await fs.readFile(path.join(targetDir, ".claude/skills/private/SKILL.md"), "utf8"),
    "Private skill\n"
  );

  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "all"
  });

  assert.equal(await fs.readFile(path.join(targetDir, ".gitignore"), "utf8"), expectedGitIgnore);
});

test("symbolic-link root gitignore rejects installation before manifest writes", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const outsideFile = path.join(workspace, "outside.gitignore");

  await writeFiles(templateRoot, {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(outsideFile, "outside-rule\n");
  await fs.symlink(outsideFile, path.join(targetDir, ".gitignore"));

  await assert.rejects(
    writeInstallManifest({
      targetDir,
      templateRoot,
      version: "1.0.0",
      adapter: "codex"
    }),
    /symbolic-link root \.gitignore/
  );
  await assert.rejects(fs.access(path.join(targetDir, MANIFEST_PATH)), { code: "ENOENT" });
  assert.equal(await fs.readFile(outsideFile, "utf8"), "outside-rule\n");
});

test("malformed managed-skill markers reject installation before manifest writes", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const gitIgnore = "# BEGIN AI BLUEPRINT MANAGED SKILLS\ncustom-rule\n";

  await writeFiles(templateRoot, {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  });
  await writeFiles(targetDir, { ".gitignore": gitIgnore });

  await assert.rejects(
    writeInstallManifest({
      targetDir,
      templateRoot,
      version: "1.0.0",
      adapter: "codex"
    }),
    /Malformed AI Blueprint managed-skills block/
  );
  await assert.rejects(fs.access(path.join(targetDir, MANIFEST_PATH)), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(targetDir, ".gitignore"), "utf8"), gitIgnore);
});

test("root ignore write failures roll back install state without replacing concurrent content", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const rootGitIgnore = path.join(targetDir, ".gitignore");
  const originalRename = fs.rename;
  let injectedFailure = false;

  await writeFiles(templateRoot, {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  });
  await writeFiles(targetDir, { ".gitignore": "initial-rule\n" });
  fs.rename = async (source, target) => {
    if (!injectedFailure && target === rootGitIgnore) {
      injectedFailure = true;
      await fs.writeFile(rootGitIgnore, "external-rule\n");
      throw Object.assign(new Error("injected root ignore failure"), { code: "EIO" });
    }

    return originalRename(source, target);
  };

  try {
    await assert.rejects(
      writeInstallManifest({
        targetDir,
        templateRoot,
        version: "1.0.0",
        adapter: "codex"
      }),
      /Blueprint install manifest write failed and was rolled back/
    );
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(await fs.readFile(rootGitIgnore, "utf8"), "external-rule\n");
  await assert.rejects(fs.access(path.join(targetDir, MANIFEST_PATH)), { code: "ENOENT" });
  await assert.rejects(
    fs.access(path.join(targetDir, CONTROL_DIR, ".gitignore")),
    { code: "ENOENT" }
  );
});

test("managed updates migrate schema-1 manifests to schema 2", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const oldFiles = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Old check skill\n"
  };

  await writeFiles(templateRoot, oldFiles);
  await writeFiles(targetDir, {
    ...oldFiles,
    "AGENTS.md": "Project instructions\n"
  });
  const manifest = await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await fs.writeFile(
    path.join(targetDir, MANIFEST_PATH),
    `${JSON.stringify({
      schemaVersion: 1,
      version: manifest.version,
      adapters: manifest.adapters,
      managedFiles: manifest.managedFiles
    }, null, 2)}\n`
  );
  await writeFiles(templateRoot, {
    ".agents/skills/check/SKILL.md": "Updated check skill\n"
  });

  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });

  assert.equal(prepared.manifest?.schemaVersion, 1);
  assert.equal(prepared.desiredManifest.schemaVersion, 2);
  assert.equal(prepared.desiredManifest.packageName, "@akash07k/create-ai-blueprint");
  await applyPreparedUpdate(prepared);

  assert.deepEqual(await readManifest(targetDir), prepared.desiredManifest);
  assert.equal(
    await fs.readFile(path.join(targetDir, "AGENTS.md"), "utf8"),
    "Project instructions\n"
  );
});

test("invalid schema-2 package identity rejects an update without writes", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  const manifest = await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const invalidManifest = `${JSON.stringify({
    ...manifest,
    packageName: "@example/not-ai-blueprint"
  }, null, 2)}\n`;
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  await fs.writeFile(manifestPath, invalidManifest);

  await assert.rejects(
    prepareUpdate({ targetDir, templateRoot, version: "1.1.0" }),
    /Unsupported or invalid Blueprint manifest/
  );
  assert.equal(await fs.readFile(manifestPath, "utf8"), invalidManifest);
  assert.equal(
    await fs.readFile(path.join(targetDir, ".agents/skills/check/SKILL.md"), "utf8"),
    "Check skill\n"
  );
});

test("Copilot manifests remain distinct from Codex when they share skills", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  const manifest = await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "copilot"
  });

  assert.deepEqual(manifest.adapters, ["copilot"]);
  assert.deepEqual(Object.keys(manifest.managedFiles), [
    ".agents/skills/check/SKILL.md",
    "blueprint/README.md"
  ]);

  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });

  assert.deepEqual(prepared.adapters, ["copilot"]);
});

test("manifest-backed adapters remain authoritative while manifest-less skills infer Codex", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n",
    ".claude/skills/check/SKILL.md": "Claude check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, {
    "blueprint/README.md": files["blueprint/README.md"],
    ".agents/skills/check/SKILL.md": files[".agents/skills/check/SKILL.md"]
  });

  const legacy = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.0.0"
  });
  assert.deepEqual(legacy.adapters, ["codex"]);

  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const codex = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });
  assert.deepEqual(codex.adapters, ["codex"]);

  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.1.0",
    adapter: "copilot"
  });
  const copilot = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.2.0"
  });
  assert.deepEqual(copilot.adapters, ["copilot"]);
});

test("updates preserve pre-Copilot Codex and Claude manifests", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n",
    ".claude/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  const allManifest = await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "all"
  });
  await fs.writeFile(
    path.join(targetDir, MANIFEST_PATH),
    `${JSON.stringify({ ...allManifest, adapters: ["claude", "codex"] }, null, 2)}\n`
  );

  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });

  assert.deepEqual(prepared.adapters, ["claude", "codex"]);
  assert.deepEqual(prepared.desiredManifest.adapters, ["claude", "codex"]);

  await applyPreparedUpdate(prepared);

  assert.deepEqual((await readManifest(targetDir))?.adapters, ["claude", "codex"]);
});

test("update replaces unchanged managed files and preserves project files", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const oldFiles = {
    "blueprint/README.md": "Old Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Old check skill\n"
  };

  await writeFiles(templateRoot, oldFiles);
  await writeFiles(targetDir, oldFiles);
  await writeFiles(targetDir, {
    "AGENTS.md": "Custom project instructions\n",
    "blueprint/build-plan.md": "Custom roadmap\n",
    "blueprint/context/decisions.md": "Keep this decision\n"
  });
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });

  await writeFiles(templateRoot, {
    "blueprint/README.md": "New Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "New check skill\n",
    ".agents/skills/feature/SKILL.md": "New feature skill\n"
  });

  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });

  assert.deepEqual(
    prepared.plan.update.map((operation) => operation.path),
    [".agents/skills/check/SKILL.md", "blueprint/README.md"]
  );
  assert.deepEqual(
    prepared.plan.add.map((operation) => operation.path),
    [".agents/skills/feature/SKILL.md"]
  );
  assert.equal(prepared.plan.conflicts.length, 0);

  const result = await applyPreparedUpdate(prepared, {
    now: () => new Date("2026-07-15T12:00:00Z")
  });

  assert.equal(result.updated, 2);
  assert.equal(result.added, 1);
  assert.ok(result.backupDir);
  assert.match(
    path.relative(targetDir, result.backupDir).replaceAll(path.sep, "/"),
    /^blueprint\/\.state\/backups\/2026-07-15T12-00-00Z-1\.0\.0-to-1\.1\.0-[a-f0-9]{8}$/
  );
  assert.ok(result.backupDir);
  assert.equal(
    await fs.readFile(path.join(targetDir, ".agents/skills/check/SKILL.md"), "utf8"),
    "New check skill\n"
  );
  assert.ok(result.backupDir);
  assert.equal(
    await fs.readFile(path.join(targetDir, "AGENTS.md"), "utf8"),
    "Custom project instructions\n"
  );
  assert.ok(result.backupDir);
  assert.equal(
    await fs.readFile(path.join(targetDir, "blueprint/build-plan.md"), "utf8"),
    "Custom roadmap\n"
  );
  assert.equal(
    await fs.readFile(path.join(targetDir, "blueprint/context/decisions.md"), "utf8"),
    "Keep this decision\n"
  );
  assert.equal(
    await fs.readFile(path.join(targetDir, ".gitignore"), "utf8"),
    "# BEGIN AI BLUEPRINT MANAGED SKILLS\n" +
      "/.agents/skills/check/\n" +
      "/.agents/skills/feature/\n" +
      "# END AI BLUEPRINT MANAGED SKILLS\n"
  );
  assert.equal(
    await fs.readFile(
      path.join(result.backupDir, "files/.agents/skills/check/SKILL.md"),
      "utf8"
    ),
    "Old check skill\n"
  );
  assert.equal((await readManifest(targetDir))?.version, "1.1.0");
});

test("local changes to managed files require explicit replacement and are backed up", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const oldFiles = {
    "blueprint/README.md": "Old Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Old check skill\n"
  };

  await writeFiles(templateRoot, oldFiles);
  await writeFiles(targetDir, oldFiles);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await writeFiles(targetDir, {
    ".agents/skills/check/SKILL.md": "Locally customized skill\n"
  });
  await writeFiles(templateRoot, {
    ".agents/skills/check/SKILL.md": "Upstream skill\n"
  });

  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });

  assert.deepEqual(
    prepared.plan.conflicts.map((operation) => operation.path),
    [".agents/skills/check/SKILL.md"]
  );
  await assert.rejects(
    applyPreparedUpdate(prepared),
    /must be resolved or explicitly replaced/
  );
  assert.equal(
    await fs.readFile(path.join(targetDir, ".agents/skills/check/SKILL.md"), "utf8"),
    "Locally customized skill\n"
  );

  const result = await applyPreparedUpdate(prepared, {
    replaceConflicts: true
  });
  assert.ok(result.backupDir);

  assert.equal(
    await fs.readFile(path.join(targetDir, ".agents/skills/check/SKILL.md"), "utf8"),
    "Upstream skill\n"
  );
  assert.equal(
    await fs.readFile(
      path.join(result.backupDir, "files/.agents/skills/check/SKILL.md"),
      "utf8"
    ),
    "Locally customized skill\n"
  );
});

test("update removes only obsolete managed files that remain unchanged", async (t) => {
  const workspace = await createWorkspace(t);
  const oldTemplateRoot = path.join(workspace, "template-old");
  const newTemplateRoot = path.join(workspace, "template-new");
  const targetDir = path.join(workspace, "target");
  const oldFiles = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n",
    ".agents/skills/retired/SKILL.md": "Retired skill\n"
  };

  await writeFiles(oldTemplateRoot, oldFiles);
  await writeFiles(targetDir, oldFiles);
  await writeInstallManifest({
    targetDir,
    templateRoot: oldTemplateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await writeFiles(newTemplateRoot, {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  });

  const prepared = await prepareUpdate({
    targetDir,
    templateRoot: newTemplateRoot,
    version: "1.1.0"
  });

  assert.deepEqual(
    prepared.plan.remove.map((operation) => operation.path),
    [".agents/skills/retired/SKILL.md"]
  );
  const result = await applyPreparedUpdate(prepared);
  assert.ok(result.backupDir);
  await assert.rejects(
    fs.access(path.join(targetDir, ".agents/skills/retired/SKILL.md")),
    { code: "ENOENT" }
  );
  assert.equal(
    await fs.readFile(
      path.join(result.backupDir, "files/.agents/skills/retired/SKILL.md"),
      "utf8"
    ),
    "Retired skill\n"
  );
});

test("legacy installs treat differing managed files as conflicts", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");

  await writeFiles(templateRoot, {
    "blueprint/README.md": "Current Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Current check skill\n"
  });
  await writeFiles(targetDir, {
    "blueprint/README.md": "Current Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Legacy customized skill\n"
  });

  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });

  assert.equal(prepared.previousVersion, "legacy");
  assert.deepEqual(
    prepared.plan.conflicts.map((operation) => operation.path),
    [".agents/skills/check/SKILL.md"]
  );
  assert.deepEqual(
    prepared.plan.unchanged.map((operation) => operation.path),
    ["blueprint/README.md"]
  );
});

test("update aborts when a managed file changes after the plan is created", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const oldFiles = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Old check skill\n"
  };

  await writeFiles(templateRoot, oldFiles);
  await writeFiles(targetDir, oldFiles);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await writeFiles(templateRoot, {
    ".agents/skills/check/SKILL.md": "New check skill\n"
  });

  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });
  await writeFiles(targetDir, {
    "blueprint/README.md": "Changed after preview\n"
  });

  await assert.rejects(
    applyPreparedUpdate(prepared),
    /Managed path changed after the update plan was created/
  );
  assert.equal(
    await fs.readFile(path.join(targetDir, ".agents/skills/check/SKILL.md"), "utf8"),
    "Old check skill\n"
  );
  assert.equal((await readManifest(targetDir))?.version, "1.0.0");
});

test("update aborts without writes when the manifest changes after planning", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Old Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Old check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await writeFiles(templateRoot, {
    ".agents/skills/check/SKILL.md": "New check skill\n"
  });
  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  await fs.writeFile(manifestPath, "externally changed manifest\n");

  await assert.rejects(
    applyPreparedUpdate(prepared),
    /Blueprint manifest changed after the update plan was created/
  );
  assert.equal(await fs.readFile(manifestPath, "utf8"), "externally changed manifest\n");
  assert.equal(
    await fs.readFile(path.join(targetDir, ".agents/skills/check/SKILL.md"), "utf8"),
    "Old check skill\n"
  );
});

test("update revalidates targets after staging before writing backups", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Old check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await writeFiles(templateRoot, {
    ".agents/skills/check/SKILL.md": "New check skill\n"
  });
  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });
  const skillPath = path.join(targetDir, ".agents/skills/check/SKILL.md");
  const originalCopyFile = fs.copyFile;
  let injectedEdit = false;

  fs.copyFile = async (source, destination, mode) => {
    const result = await originalCopyFile(source, destination, mode);

    if (!injectedEdit && typeof destination === "string" && destination.includes(`${path.sep}staging${path.sep}`)) {
      injectedEdit = true;
      await fs.writeFile(skillPath, "External edit during staging\n");
    }

    return result;
  };

  try {
    await assert.rejects(
      applyPreparedUpdate(prepared),
      /Managed path changed after the update plan was created/
    );
  } finally {
    fs.copyFile = originalCopyFile;
  }

  assert.equal(injectedEdit, true);
  assert.equal(await fs.readFile(skillPath, "utf8"), "External edit during staging\n");
  assert.equal((await readManifest(targetDir))?.version, "1.0.0");
});

test("update revalidates the manifest after staging before writing backups", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Old check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await writeFiles(templateRoot, {
    ".agents/skills/check/SKILL.md": "New check skill\n"
  });
  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const originalCopyFile = fs.copyFile;
  let injectedChange = false;

  fs.copyFile = async (source, destination, mode) => {
    const result = await originalCopyFile(source, destination, mode);

    if (!injectedChange && typeof destination === "string" && destination.includes(`${path.sep}staging${path.sep}`)) {
      injectedChange = true;
      await fs.writeFile(manifestPath, "External manifest change during staging\n");
    }

    return result;
  };

  try {
    await assert.rejects(
      applyPreparedUpdate(prepared),
      /Blueprint manifest changed after the update plan was created/
    );
  } finally {
    fs.copyFile = originalCopyFile;
  }

  assert.equal(injectedChange, true);
  assert.equal(await fs.readFile(manifestPath, "utf8"), "External manifest change during staging\n");
  assert.equal(
    await fs.readFile(path.join(targetDir, ".agents/skills/check/SKILL.md"), "utf8"),
    "Old check skill\n"
  );
});

test("update rollback preserves a late external target edit", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Old Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Old check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await writeFiles(templateRoot, {
    "blueprint/README.md": "New Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "New check skill\n"
  });
  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });
  const skillPath = path.join(targetDir, ".agents/skills/check/SKILL.md");
  const readmePath = path.join(targetDir, "blueprint/README.md");
  const originalRename = fs.rename;
  let injectedEdit = false;

  fs.rename = async (source, destination) => {
    if (destination === readmePath) {
      throw new Error("injected update write failure");
    }

    const result = await originalRename(source, destination);

    if (!injectedEdit && destination === skillPath) {
      injectedEdit = true;
      await fs.writeFile(skillPath, "External edit after update write\n");
    }

    return result;
  };

  try {
    await assert.rejects(
      applyPreparedUpdate(prepared),
      /Rollback also failed: Preserved concurrent changes during rollback/
    );
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(injectedEdit, true);
  assert.equal(await fs.readFile(skillPath, "utf8"), "External edit after update write\n");
  assert.equal(await fs.readFile(readmePath, "utf8"), "Old Blueprint docs\n");
});

test("update rejects a late replacement edit at the final rename boundary", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Old check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await writeFiles(templateRoot, {
    ".agents/skills/check/SKILL.md": "New check skill\n"
  });
  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });
  const skillPath = path.join(targetDir, ".agents/skills/check/SKILL.md");
  const originalWriteFile = fs.writeFile;
  let injectedEdit = false;

  fs.writeFile = async (file, content, options) => {
    const result = await originalWriteFile(file, content, options);

    if (
      !injectedEdit &&
      typeof file === "string" &&
      path.dirname(file) === path.dirname(skillPath) &&
      path.basename(file).startsWith(".SKILL.md.blueprint-")
    ) {
      injectedEdit = true;
      await originalWriteFile(skillPath, "External edit after update staging\n");
    }

    return result;
  };

  try {
    await assert.rejects(
      applyPreparedUpdate(prepared),
      /Managed path changed after the update plan was created/
    );
  } finally {
    fs.writeFile = originalWriteFile;
  }

  assert.equal(injectedEdit, true);
  assert.equal(await fs.readFile(skillPath, "utf8"), "External edit after update staging\n");
});

test("update preserves a concurrent external add at the final link boundary", async (t) => {
  const workspace = await createWorkspace(t);
  const oldTemplateRoot = path.join(workspace, "template-old");
  const newTemplateRoot = path.join(workspace, "template-new");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(oldTemplateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot: oldTemplateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await writeFiles(newTemplateRoot, {
    ...files,
    ".agents/skills/feature/SKILL.md": "Feature skill\n"
  });
  const prepared = await prepareUpdate({
    targetDir,
    templateRoot: newTemplateRoot,
    version: "1.1.0"
  });
  const skillPath = path.join(targetDir, ".agents/skills/feature/SKILL.md");
  const originalLink = fs.link;
  let injectedAdd = false;

  fs.link = async (existingPath, newPath) => {
    if (!injectedAdd && newPath === skillPath) {
      injectedAdd = true;
      await fs.writeFile(skillPath, "External feature skill\n");
    }

    return originalLink(existingPath, newPath);
  };

  try {
    await assert.rejects(applyPreparedUpdate(prepared), /Blueprint update failed and was rolled back/);
  } finally {
    fs.link = originalLink;
  }

  assert.equal(injectedAdd, true);
  assert.equal(await fs.readFile(skillPath, "utf8"), "External feature skill\n");
});

test("update fallback refuses an edit raced after parent validation", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Old check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await writeFiles(templateRoot, {
    ".agents/skills/check/SKILL.md": "New check skill\n"
  });
  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });
  const skillPath = path.join(targetDir, ".agents/skills/check/SKILL.md");
  const skillDir = path.dirname(skillPath);
  const originalRename = fs.rename;
  const originalRealpath = fs.realpath;
  let targetRenameAttempts = 0;
  let parentChecks = 0;
  let injectedEdit = false;

  fs.rename = async (source, destination) => {
    if (destination === skillPath && targetRenameAttempts++ === 0) {
      throw Object.assign(new Error("injected fallback error"), { code: "EPERM" });
    }

    return originalRename(source, destination);
  };
  fs.realpath = async (target) => {
    if (target === skillDir) {
      parentChecks += 1;

      if (!injectedEdit && parentChecks === 3) {
        injectedEdit = true;
        await fs.writeFile(skillPath, "External edit before fallback removal\n");
      }
    }

    return originalRealpath(target);
  };

  try {
    await assert.rejects(
      applyPreparedUpdate(prepared),
      /Managed path changed after the update plan was created/
    );
  } finally {
    fs.rename = originalRename;
    fs.realpath = originalRealpath;
  }

  assert.equal(targetRenameAttempts, 1);
  assert.equal(injectedEdit, true);
  assert.equal(await fs.readFile(skillPath, "utf8"), "External edit before fallback removal\n");
});

test("update preserves concurrent root ignore changes while restoring managed files", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const oldFiles = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Old check skill\n"
  };

  await writeFiles(templateRoot, oldFiles);
  await writeFiles(targetDir, oldFiles);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await writeFiles(templateRoot, {
    ".agents/skills/check/SKILL.md": "Updated check skill\n"
  });
  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });
  const rootGitIgnore = path.join(targetDir, ".gitignore");
  await fs.writeFile(rootGitIgnore, "external-rule\n");

  await assert.rejects(
    applyPreparedUpdate(prepared),
    /Root \.gitignore changed before the managed-skills block was written/
  );

  assert.equal(await fs.readFile(rootGitIgnore, "utf8"), "external-rule\n");
  assert.equal(
    await fs.readFile(path.join(targetDir, ".agents/skills/check/SKILL.md"), "utf8"),
    "Old check skill\n"
  );
  assert.equal((await readManifest(targetDir))?.version, "1.0.0");
});

test("sync prepares without writes and restores only missing generated skills", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n",
    ".agents/skills/feature/SKILL.md": "Feature skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, {
    ...files,
    "AGENTS.md": "Project instructions\n",
    "blueprint/build-plan.md": "Project roadmap\n"
  });
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const rootGitIgnore = path.join(targetDir, ".gitignore");
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const originalManifest = await fs.readFile(manifestPath, "utf8");
  const modifiedMarkerBlock = [
    "project-rule",
    "# BEGIN AI BLUEPRINT MANAGED SKILLS",
    "/.agents/skills/custom-generated-entry/",
    "# END AI BLUEPRINT MANAGED SKILLS",
    ""
  ].join("\n");
  await fs.writeFile(rootGitIgnore, modifiedMarkerBlock);
  await fs.rm(path.join(targetDir, ".agents/skills/feature/SKILL.md"));

  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });

  assert.deepEqual(
    prepared.plan.add.map((operation) => operation.path),
    [".agents/skills/feature/SKILL.md"]
  );
  await assert.rejects(
    fs.access(path.join(targetDir, ".agents/skills/feature/SKILL.md")),
    { code: "ENOENT" }
  );
  assert.equal(
    await fs.readFile(path.join(targetDir, "blueprint/build-plan.md"), "utf8"),
    "Project roadmap\n"
  );

  const result = await applyPreparedSync(prepared);

  assert.equal(result.added, 1);
  assert.equal(
    await fs.readFile(path.join(targetDir, ".agents/skills/feature/SKILL.md"), "utf8"),
    "Feature skill\n"
  );
  assert.equal(
    await fs.readFile(path.join(targetDir, "AGENTS.md"), "utf8"),
    "Project instructions\n"
  );
  assert.equal(
    await fs.readFile(path.join(targetDir, "blueprint/build-plan.md"), "utf8"),
    "Project roadmap\n"
  );
  assert.equal(await fs.readFile(manifestPath, "utf8"), originalManifest);
  assert.equal(await fs.readFile(rootGitIgnore, "utf8"), modifiedMarkerBlock);
  await assertNoSyncStaging(targetDir);
});

test("sync leaves matching generated skills unchanged", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const rootGitIgnore = path.join(targetDir, ".gitignore");
  const originalManifest = await fs.readFile(manifestPath, "utf8");
  const originalRootGitIgnore = await fs.readFile(rootGitIgnore, "utf8");

  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });
  const result = await applyPreparedSync(prepared);

  assert.equal(prepared.plan.add.length, 0);
  assert.equal(prepared.plan.conflicts.length, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(result.backupDir, null);
  assert.equal(await fs.readFile(manifestPath, "utf8"), originalManifest);
  assert.equal(await fs.readFile(rootGitIgnore, "utf8"), originalRootGitIgnore);
  await assertNoSyncStaging(targetDir);
});

test("sync rejects manifest changes after preparation without target writes", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n",
    ".agents/skills/feature/SKILL.md": "Feature skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  const manifest = await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const skillPath = path.join(targetDir, ".agents/skills/feature/SKILL.md");
  const rootGitIgnore = path.join(targetDir, ".gitignore");
  const originalRootGitIgnore = await fs.readFile(rootGitIgnore, "utf8");
  await fs.rm(skillPath);
  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });
  const changedManifest = `${JSON.stringify({ ...manifest, version: "1.0.1" }, null, 2)}\n`;
  await fs.writeFile(path.join(targetDir, MANIFEST_PATH), changedManifest);

  await assert.rejects(
    applyPreparedSync(prepared),
    /Blueprint manifest changed after the sync plan was created/
  );

  await assert.rejects(fs.access(skillPath), { code: "ENOENT" });
  assert.equal(await fs.readFile(rootGitIgnore, "utf8"), originalRootGitIgnore);
  assert.equal(await fs.readFile(path.join(targetDir, MANIFEST_PATH), "utf8"), changedManifest);
});

test("sync rejects manifest changes during staging before target writes", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  const manifest = await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const skillPath = path.join(targetDir, ".agents/skills/check/SKILL.md");
  const rootGitIgnore = path.join(targetDir, ".gitignore");
  const originalRootGitIgnore = await fs.readFile(rootGitIgnore, "utf8");
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const changedManifest = `${JSON.stringify({ ...manifest, version: "1.0.1" }, null, 2)}\n`;
  const templateSkillPath = path.join(templateRoot, ".agents/skills/check/SKILL.md");
  const originalCopyFile = fs.copyFile;
  let injectedChange = false;

  await fs.rm(skillPath);
  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });
  fs.copyFile = async (source, destination) => {
    const result = await originalCopyFile(source, destination);

    if (!injectedChange && source === templateSkillPath) {
      injectedChange = true;
      await fs.writeFile(manifestPath, changedManifest);
    }

    return result;
  };

  try {
    await assert.rejects(
      applyPreparedSync(prepared),
      /Blueprint sync failed and was rolled back: Blueprint manifest changed after the sync plan was created/
    );
  } finally {
    fs.copyFile = originalCopyFile;
  }

  await assert.rejects(fs.access(skillPath), { code: "ENOENT" });
  assert.equal(await fs.readFile(rootGitIgnore, "utf8"), originalRootGitIgnore);
  assert.equal(await fs.readFile(manifestPath, "utf8"), changedManifest);
  await assertNoSyncStaging(targetDir);
});

test("sync rejects target changes during staging before target writes", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n",
    ".agents/skills/feature/SKILL.md": "Feature skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const skillPath = path.join(targetDir, ".agents/skills/feature/SKILL.md");
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const rootGitIgnore = path.join(targetDir, ".gitignore");
  const originalManifest = await fs.readFile(manifestPath, "utf8");
  const originalRootGitIgnore = await fs.readFile(rootGitIgnore, "utf8");
  const templateSkillPath = path.join(templateRoot, ".agents/skills/feature/SKILL.md");
  const originalCopyFile = fs.copyFile;
  let injectedChange = false;

  await fs.rm(skillPath);
  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });
  fs.copyFile = async (source, destination) => {
    const result = await originalCopyFile(source, destination);

    if (!injectedChange && source === templateSkillPath) {
      injectedChange = true;
      await fs.writeFile(skillPath, "External feature skill\n");
    }

    return result;
  };

  try {
    await assert.rejects(
      applyPreparedSync(prepared),
      /Blueprint sync failed and was rolled back: Managed skill changed after the sync plan was created/
    );
  } finally {
    fs.copyFile = originalCopyFile;
  }

  assert.equal(await fs.readFile(skillPath, "utf8"), "External feature skill\n");
  assert.equal(await fs.readFile(manifestPath, "utf8"), originalManifest);
  assert.equal(await fs.readFile(rootGitIgnore, "utf8"), originalRootGitIgnore);
  await assertNoSyncStaging(targetDir);
});

test("sync refuses parent paths raced during staging", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const outsideDir = path.join(workspace, "outside");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n",
    ".agents/skills/feature/SKILL.md": "Feature skill\n"
  };

  for (const parentType of ["symbolic-link", "non-directory"] as const) {
    await writeFiles(templateRoot, files);
    await writeFiles(targetDir, files);
    await writeInstallManifest({
      targetDir,
      templateRoot,
      version: "1.0.0",
      adapter: "codex"
    });
    const featurePath = path.join(targetDir, ".agents/skills/feature/SKILL.md");
    const featureDir = path.dirname(featurePath);
    const manifestPath = path.join(targetDir, MANIFEST_PATH);
    const rootGitIgnore = path.join(targetDir, ".gitignore");
    const originalManifest = await fs.readFile(manifestPath, "utf8");
    const originalRootGitIgnore = await fs.readFile(rootGitIgnore, "utf8");
    const templateSkillPath = path.join(templateRoot, ".agents/skills/feature/SKILL.md");
    const originalCopyFile = fs.copyFile;
    let injectedChange = false;

    await fs.rm(featureDir, { recursive: true });
    const prepared = await prepareSync({
      targetDir,
      templateRoot,
      packageName: "@akash07k/create-ai-blueprint",
      version: "1.0.0"
    });
    fs.copyFile = async (source, destination) => {
      const result = await originalCopyFile(source, destination);

      if (!injectedChange && source === templateSkillPath) {
        injectedChange = true;

        if (parentType === "symbolic-link") {
          await fs.mkdir(outsideDir, { recursive: true });
          await fs.symlink(outsideDir, featureDir);
        } else {
          await fs.writeFile(featureDir, "not a directory\n");
        }
      }

      return result;
    };

    try {
      await assert.rejects(
        applyPreparedSync(prepared),
        parentType === "symbolic-link"
          ? /Refusing to write through symbolic-link directory/
          : /Managed path parent is not a directory/
      );
    } finally {
      fs.copyFile = originalCopyFile;
    }

    assert.equal(await fs.readFile(manifestPath, "utf8"), originalManifest);
    assert.equal(await fs.readFile(rootGitIgnore, "utf8"), originalRootGitIgnore);
    await assertNoSyncStaging(targetDir);
    await fs.rm(featureDir, { recursive: true, force: true });
  }
});

test("sync refuses a parent raced after staged content is read", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const outsideDir = path.join(workspace, "outside");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n",
    ".agents/skills/feature/SKILL.md": "Feature skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const featurePath = path.join(targetDir, ".agents/skills/feature/SKILL.md");
  const featureDir = path.dirname(featurePath);
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const rootGitIgnore = path.join(targetDir, ".gitignore");
  const originalManifest = await fs.readFile(manifestPath, "utf8");
  const originalRootGitIgnore = await fs.readFile(rootGitIgnore, "utf8");
  const originalMkdir = fs.mkdir;
  let injectedRace = false;

  await fs.rm(featureDir, { recursive: true });
  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });
  fs.mkdir = async (directory, options) => {
    const result = await originalMkdir(directory, options);

    if (!injectedRace && directory === featureDir) {
      injectedRace = true;
      await fs.rm(featureDir, { recursive: true, force: true });
      await originalMkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideDir, featureDir);
    }

    return result;
  };

  try {
    await assert.rejects(
      applyPreparedSync(prepared),
      /Refusing to write through symbolic-link directory/
    );
  } finally {
    fs.mkdir = originalMkdir;
  }

  assert.equal(injectedRace, true);
  await assert.rejects(fs.access(path.join(outsideDir, "SKILL.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(manifestPath, "utf8"), originalManifest);
  assert.equal(await fs.readFile(rootGitIgnore, "utf8"), originalRootGitIgnore);
  await assertNoSyncStaging(targetDir);
});

test("sync refuses a parent raced before target parent creation", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const outsideDir = path.join(workspace, "outside");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n",
    ".agents/skills/feature/SKILL.md": "Feature skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const featurePath = path.join(targetDir, ".agents/skills/feature/SKILL.md");
  const featureDir = path.dirname(featurePath);
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const rootGitIgnore = path.join(targetDir, ".gitignore");
  const originalManifest = await fs.readFile(manifestPath, "utf8");
  const originalRootGitIgnore = await fs.readFile(rootGitIgnore, "utf8");
  const originalLstat = fs.lstat;
  let injectedRace = false;
  let featureDirChecks = 0;

  await fs.rm(featureDir, { recursive: true });
  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });
  fs.lstat = async (file) => {
    if (file === featureDir) {
      featureDirChecks += 1;

      if (!injectedRace && featureDirChecks === 3) {
        injectedRace = true;
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.symlink(outsideDir, featureDir);
      }
    }

    return originalLstat(file);
  };

  try {
    await assert.rejects(
      applyPreparedSync(prepared),
      /Refusing to write through symbolic-link directory/
    );
  } finally {
    fs.lstat = originalLstat;
  }

  assert.equal(injectedRace, true);
  await assert.rejects(fs.access(path.join(outsideDir, "SKILL.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(manifestPath, "utf8"), originalManifest);
  assert.equal(await fs.readFile(rootGitIgnore, "utf8"), originalRootGitIgnore);
  await assertNoSyncStaging(targetDir);
});

test("sync refuses a parent raced at the final write boundary", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const outsideDir = path.join(workspace, "outside");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n",
    ".agents/skills/feature/SKILL.md": "Feature skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const featurePath = path.join(targetDir, ".agents/skills/feature/SKILL.md");
  const featureDir = path.dirname(featurePath);
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const rootGitIgnore = path.join(targetDir, ".gitignore");
  const originalManifest = await fs.readFile(manifestPath, "utf8");
  const originalRootGitIgnore = await fs.readFile(rootGitIgnore, "utf8");
  const originalRealpath = fs.realpath;
  let injectedRace = false;

  await fs.rm(featureDir, { recursive: true });
  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });
  await fs.mkdir(featureDir, { recursive: true });
  fs.realpath = async (target) => {
    if (!injectedRace && target === featureDir) {
      injectedRace = true;
      await fs.rm(featureDir, { recursive: true, force: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideDir, featureDir);
    }

    return originalRealpath(target);
  };

  try {
    await assert.rejects(
      applyPreparedSync(prepared),
      /Sync target parent escaped the Blueprint project/
    );
  } finally {
    fs.realpath = originalRealpath;
  }

  assert.equal(injectedRace, true);
  await assert.rejects(fs.access(path.join(outsideDir, "SKILL.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(manifestPath, "utf8"), originalManifest);
  assert.equal(await fs.readFile(rootGitIgnore, "utf8"), originalRootGitIgnore);
  await assertNoSyncStaging(targetDir);
});

test("sync rejects templates that change after planning before target writes", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const skillPath = path.join(targetDir, ".agents/skills/check/SKILL.md");
  await fs.rm(skillPath);
  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });
  await writeFiles(templateRoot, {
    ".agents/skills/check/SKILL.md": "Changed check skill\n"
  });

  await assert.rejects(
    applyPreparedSync(prepared),
    /Bundled Blueprint template changed after the sync plan was created/
  );
  await assert.rejects(fs.access(skillPath), { code: "ENOENT" });
  assert.equal((await readManifest(targetDir))?.version, "1.0.0");
});

test("sync preserves late external skill edits while rolling back unaffected writes", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n",
    ".agents/skills/feature/SKILL.md": "Feature skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const manifest = await readManifest(targetDir);
  const legacyManifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      version: manifest?.version,
      adapters: manifest?.adapters,
      managedFiles: manifest?.managedFiles
    },
    null,
    2
  )}\n`;
  await fs.writeFile(manifestPath, legacyManifest);
  const checkPath = path.join(targetDir, ".agents/skills/check/SKILL.md");
  const featurePath = path.join(targetDir, ".agents/skills/feature/SKILL.md");
  const rootGitIgnore = path.join(targetDir, ".gitignore");
  await fs.rm(checkPath);
  await fs.rm(featurePath);
  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });
  await fs.writeFile(rootGitIgnore, "external-root-rule\n");

  const originalRename = fs.rename;
  const originalLink = fs.link;
  let injectedEdit = false;
  fs.rename = async (source, target) => {
    if (target === manifestPath) {
      throw new Error("injected manifest failure");
    }

    return originalRename(source, target);
  };
  fs.link = async (existingPath, newPath) => {
    const result = await originalLink(existingPath, newPath);

    if (!injectedEdit && newPath === featurePath) {
      injectedEdit = true;
      await fs.writeFile(featurePath, "External feature skill\n");
    }

    return result;
  };

  try {
    await assert.rejects(
      applyPreparedSync(prepared),
      /Rollback conflicts preserved externally changed paths: \.agents\/skills\/feature\/SKILL\.md/
    );
  } finally {
    fs.rename = originalRename;
    fs.link = originalLink;
  }

  assert.equal(await fs.readFile(featurePath, "utf8"), "External feature skill\n");
  await assert.rejects(fs.access(checkPath), { code: "ENOENT" });
  assert.equal(await fs.readFile(rootGitIgnore, "utf8"), "external-root-rule\n");
  assert.equal(await fs.readFile(manifestPath, "utf8"), legacyManifest);
});

test("sync requires force to replace modified generated skills and backs them up", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await writeFiles(targetDir, {
    ".agents/skills/check/SKILL.md": "Customized skill\n"
  });

  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });

  assert.deepEqual(
    prepared.plan.conflicts.map((operation) => operation.path),
    [".agents/skills/check/SKILL.md"]
  );
  await assert.rejects(applyPreparedSync(prepared), /managed skill conflict/);

  const result = await applyPreparedSync(prepared, { replaceConflicts: true });

  assert.ok(result.backupDir);
  assert.equal(
    await fs.readFile(path.join(targetDir, ".agents/skills/check/SKILL.md"), "utf8"),
    "Check skill\n"
  );
  assert.equal(
    await fs.readFile(
      path.join(result.backupDir, "files/.agents/skills/check/SKILL.md"),
      "utf8"
    ),
    "Customized skill\n"
  );
});

test("sync force rejects a late external replacement edit before the final rename", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const skillPath = path.join(targetDir, ".agents/skills/check/SKILL.md");
  await fs.writeFile(skillPath, "Customized skill\n");
  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });
  const originalWriteFile = fs.writeFile;
  let injectedEdit = false;

  fs.writeFile = async (file, content, options) => {
    const result = await originalWriteFile(file, content, options);

    if (
      !injectedEdit &&
      typeof file === "string" &&
      path.dirname(file) === path.dirname(skillPath) &&
      path.basename(file).startsWith(".SKILL.md.blueprint-")
    ) {
      injectedEdit = true;
      await originalWriteFile(skillPath, "External edit after staging\n");
    }

    return result;
  };

  try {
    await assert.rejects(
      applyPreparedSync(prepared, { replaceConflicts: true }),
      /Managed skill changed after the sync plan was created/
    );
  } finally {
    fs.writeFile = originalWriteFile;
  }

  assert.equal(injectedEdit, true);
  assert.equal(await fs.readFile(skillPath, "utf8"), "External edit after staging\n");
});

test("sync restores a replacement backup after a failed destructive fallback", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const skillPath = path.join(targetDir, ".agents/skills/check/SKILL.md");
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const rootGitIgnore = path.join(targetDir, ".gitignore");
  const originalManifest = await fs.readFile(manifestPath, "utf8");
  const originalRootGitIgnore = await fs.readFile(rootGitIgnore, "utf8");
  await fs.writeFile(skillPath, "Customized skill\n");
  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });
  const originalRename = fs.rename;
  let targetRenameAttempts = 0;

  fs.rename = async (source, target) => {
    if (target === skillPath) {
      targetRenameAttempts += 1;

      if (targetRenameAttempts === 1) {
        throw Object.assign(new Error("injected initial fallback error"), { code: "EPERM" });
      }

      if (targetRenameAttempts === 2) {
        throw Object.assign(new Error("injected fallback rename failure"), { code: "EIO" });
      }
    }

    return originalRename(source, target);
  };

  try {
    await assert.rejects(
      applyPreparedSync(prepared, { replaceConflicts: true }),
      /Blueprint sync failed and was rolled back: injected fallback rename failure/
    );
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(targetRenameAttempts, 3);
  assert.equal(await fs.readFile(skillPath, "utf8"), "Customized skill\n");
  assert.equal(await fs.readFile(manifestPath, "utf8"), originalManifest);
  assert.equal(await fs.readFile(rootGitIgnore, "utf8"), originalRootGitIgnore);
  await assertNoSyncStaging(targetDir);
});

test("sync preserves a concurrent external add instead of replacing it", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n",
    ".agents/skills/feature/SKILL.md": "Feature skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const skillPath = path.join(targetDir, ".agents/skills/feature/SKILL.md");
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const rootGitIgnore = path.join(targetDir, ".gitignore");
  const originalManifest = await fs.readFile(manifestPath, "utf8");
  const originalRootGitIgnore = await fs.readFile(rootGitIgnore, "utf8");
  await fs.rm(skillPath);
  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });
  const originalLink = fs.link;
  let injectedAdd = false;

  fs.link = async (existingPath, newPath) => {
    if (!injectedAdd && newPath === skillPath) {
      injectedAdd = true;
      await fs.writeFile(skillPath, "External feature skill\n");
    }

    return originalLink(existingPath, newPath);
  };

  try {
    await assert.rejects(
      applyPreparedSync(prepared),
      /Blueprint sync failed and was rolled back/
    );
  } finally {
    fs.link = originalLink;
  }

  assert.equal(injectedAdd, true);
  assert.equal(await fs.readFile(skillPath, "utf8"), "External feature skill\n");
  assert.equal(await fs.readFile(manifestPath, "utf8"), originalManifest);
  assert.equal(await fs.readFile(rootGitIgnore, "utf8"), originalRootGitIgnore);
  await assertNoSyncStaging(targetDir);
});

test("sync rejects package, adapter, and template lock mismatches without writes", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n",
    ".claude/skills/check/SKILL.md": "Claude check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  const manifest = await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const originalManifest = await fs.readFile(manifestPath, "utf8");

  await assert.rejects(
    prepareSync({
      targetDir,
      templateRoot,
      packageName: "@example/not-blueprint",
      version: "1.0.0"
    }),
    /Running package identity/
  );
  await assert.rejects(
    prepareSync({
      targetDir,
      templateRoot,
      packageName: "@akash07k/create-ai-blueprint",
      version: "1.1.0"
    }),
    /does not match manifest version/
  );
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, adapters: ["claude"] }, null, 2)}\n`
  );
  await assert.rejects(
    prepareSync({
      targetDir,
      templateRoot,
      packageName: "@akash07k/create-ai-blueprint",
      version: "1.0.0"
    }),
    /Bundled Blueprint template does not match/
  );
  await fs.writeFile(manifestPath, originalManifest);
  await writeFiles(templateRoot, {
    ".agents/skills/check/SKILL.md": "Changed check skill\n"
  });
  await assert.rejects(
    prepareSync({
      targetDir,
      templateRoot,
      packageName: "@akash07k/create-ai-blueprint",
      version: "1.0.0"
    }),
    /Bundled Blueprint template does not match/
  );
  assert.equal(await fs.readFile(manifestPath, "utf8"), originalManifest);
  assert.equal(
    await fs.readFile(path.join(targetDir, ".agents/skills/check/SKILL.md"), "utf8"),
    "Check skill\n"
  );
});

test("sync migrates matching schema-1 locks and rejects mismatched legacy versions", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  const manifest = await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const manifestPath = path.join(targetDir, MANIFEST_PATH);
  const legacyManifest = `${JSON.stringify({
    schemaVersion: 1,
    version: manifest.version,
    adapters: manifest.adapters,
    managedFiles: manifest.managedFiles
  }, null, 2)}\n`;
  await fs.writeFile(manifestPath, legacyManifest);

  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });

  assert.equal(prepared.shouldMigrateManifest, true);
  await applyPreparedSync(prepared);
  assert.equal((await readManifest(targetDir))?.schemaVersion, 2);

  await fs.writeFile(manifestPath, legacyManifest);
  await assert.rejects(
    prepareSync({
      targetDir,
      templateRoot,
      packageName: "@akash07k/create-ai-blueprint",
      version: "1.1.0"
    }),
    /does not match manifest version/
  );
  assert.equal(await fs.readFile(manifestPath, "utf8"), legacyManifest);
});

test("sync refuses symbolic-link generated skill targets", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const outsideFile = path.join(workspace, "outside-skill.md");
  const files = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, files);
  await writeFiles(targetDir, files);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  const skillPath = path.join(targetDir, ".agents/skills/check/SKILL.md");
  await fs.rm(skillPath);
  await fs.writeFile(outsideFile, "Outside skill\n");
  await fs.symlink(outsideFile, skillPath);

  const prepared = await prepareSync({
    targetDir,
    templateRoot,
    packageName: "@akash07k/create-ai-blueprint",
    version: "1.0.0"
  });

  await assert.rejects(applyPreparedSync(prepared), /Refusing to sync .*symbolic link/);
  assert.equal(await fs.readFile(outsideFile, "utf8"), "Outside skill\n");
});

test("failed apply removes additions and restores the previous manifest", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const oldFiles = {
    "blueprint/README.md": "Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Check skill\n"
  };

  await writeFiles(templateRoot, oldFiles);
  await writeFiles(targetDir, oldFiles);
  await writeInstallManifest({
    targetDir,
    templateRoot,
    version: "1.0.0",
    adapter: "codex"
  });
  await writeFiles(templateRoot, {
    ".agents/skills/feature/SKILL.md": "Feature skill\n"
  });

  const prepared = await prepareUpdate({
    targetDir,
    templateRoot,
    version: "1.1.0"
  });
  const originalRename = fs.rename;
  let injectedFailure = false;

  fs.rename = async (source, target) => {
    if (!injectedFailure && target === path.join(targetDir, MANIFEST_PATH)) {
      injectedFailure = true;
      const error = Object.assign(new Error("injected manifest failure"), { code: "EIO" });
      throw error;
    }

    return originalRename(source, target);
  };

  try {
    await assert.rejects(
      applyPreparedUpdate(prepared),
      /Blueprint update failed and was rolled back/
    );
  } finally {
    fs.rename = originalRename;
  }

  await assert.rejects(
    fs.access(path.join(targetDir, ".agents/skills/feature/SKILL.md")),
    { code: "ENOENT" }
  );
  assert.equal((await readManifest(targetDir))?.version, "1.0.0");
});

test("update refuses to write through a symbolic-link directory", async (t) => {
  const workspace = await createWorkspace(t);
  const templateRoot = path.join(workspace, "template");
  const targetDir = path.join(workspace, "target");
  const outsideDir = path.join(workspace, "outside");

  await writeFiles(templateRoot, {
    "blueprint/README.md": "Current Blueprint docs\n",
    ".agents/skills/check/SKILL.md": "Current check skill\n"
  });
  await fs.mkdir(targetDir, { recursive: true });
  await writeFiles(outsideDir, {
    "skills/check/SKILL.md": "Outside skill\n"
  });
  await fs.symlink(outsideDir, path.join(targetDir, ".agents"));

  await assert.rejects(
    prepareUpdate({ targetDir, templateRoot, version: "1.1.0" }),
    /Refusing to write through symbolic-link directory/
  );
});

async function createWorkspace(t: TestContext): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ai-blueprint-update-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return workspace;
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
}

async function assertNoSyncStaging(targetDir: string): Promise<void> {
  await assert.rejects(fs.access(path.join(targetDir, CONTROL_DIR, "staging")), {
    code: "ENOENT"
  });
}

function cliRuntime(templateRoot: string): CliRuntime {
  return {
    packageName: "@akash07k/create-ai-blueprint",
    templateRoot,
    version: "1.0.0"
  };
}

async function captureConsole(action: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const output: string[] = [];
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    await action();
  } finally {
    console.log = originalLog;
  }

  return output.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
