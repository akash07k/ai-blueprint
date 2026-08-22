import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  formatHumanStatus,
  readProjectStatus,
  shouldUseColor
} from "../lib/status.js";

const execFileAsync = promisify(execFile);

test("readProjectStatus reports active work, findings, Git, and the next step", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: `# Feature: Status command

**From build-plan:** feature 2
**Status:** in progress

## Build steps

- [x] **Step 1 - Read plans** - parse project files.
- [ ] **Step 2 - Print status** - format the result.
`,
    findings: `# Findings

### F-01 [P2] open - Formatter needs a smaller helper
`,
    branch: "feature/status-command"
  });

  await fs.appendFile(path.join(projectRoot, "src.ts"), "export const dirty = true;\n");

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.schemaVersion, 1);
  assert.equal(status.health, "ok");
  assert.deepEqual(status.plans.build, {
    completed: 1,
    remaining: 1,
    total: 2,
    nextItem: { id: "2", title: "Status command" },
    splitParents: []
  });
  assert.deepEqual(status.currentWork, {
    state: "active",
    type: "feature",
    title: "Status command",
    status: "in progress",
    buildPlanItem: "2",
    completed: 1,
    remaining: 1,
    total: 2,
    nextStep: { title: "Print status" }
  });
  assert.equal(status.findings.byStatus.open, 1);
  assert.deepEqual(status.findings.active.map((finding) => finding.id), ["F-01"]);
  assert.deepEqual(status.findings.blockers, []);
  assert.equal(status.git.branch, "feature/status-command");
  assert.equal(status.git.changedFiles, 1);
  assert.deepEqual(status.nextAction, {
    command: "/implement",
    reason: "Resume with Print status."
  });
  assert.equal(status.completion.state, "blocked");
  assert.deepEqual(status.warnings, []);
});

test("readProjectStatus reports Copilot from the manifest", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "feature/copilot-status",
    adapters: ["copilot"]
  });

  const status = await readProjectStatus(projectRoot);

  assert.deepEqual(status.blueprint.adapters, ["copilot"]);
  assert.match(formatHumanStatus(status), /Adapters\s+copilot/);
});

test("readProjectStatus selects overview before new feature work", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "chore/setup"
  });
  const older = new Date("2026-01-01T00:00:00Z");
  const newer = new Date("2026-01-02T00:00:00Z");
  await fs.utimes(
    path.join(projectRoot, "blueprint", "context", "project-overview.md"),
    older,
    older
  );
  await fs.utimes(
    path.join(projectRoot, "blueprint", "build-plan.md"),
    newer,
    newer
  );

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.plans.overview.state, "stale");
  assert.equal(status.nextAction.command, "/overview");
  assert.ok(status.warnings.some((warning) => warning.code === "stale_overview"));
});

test("readProjectStatus sends fixed P1 findings back to audit", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: `# Feature: Status command

**From build-plan:** feature 2
**Status:** implemented

## Build steps

- [x] **Step 1 - Read plans** - parse project files.
- [x] **Step 2 - Print status** - format the result.
`,
    findings: `# Findings

### F-02 [P1] fixed - Repair needs review
`,
    branch: "feature/status-command"
  });

  const status = await readProjectStatus(projectRoot);

  assert.deepEqual(status.findings.blockers.map((finding) => finding.id), ["F-02"]);
  assert.equal(status.health, "warning");
  assert.equal(status.completion.state, "blocked");
  assert.deepEqual(status.nextAction, {
    command: "/audit",
    reason: "Re-review fixed finding F-02."
  });
  assert.ok(
    status.warnings.some(
      (warning) => warning.code === "completed_steps_not_completed"
    )
  );
});

test("readProjectStatus requires verification after all build steps pass", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: `# Feature: Status command

**From build-plan:** feature 2
**Status:** implemented

## Build steps

- [x] **Step 1 - Read plans** - parse project files.
- [x] **Step 2 - Print status** - format the result.
`,
    findings: emptyFindings(),
    branch: "feature/status-command"
  });

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.completion.state, "needs_verification");
  assert.deepEqual(status.nextAction, {
    command: "/check",
    reason: "All build steps are checked, but verification is not persisted."
  });
});

test("readProjectStatus selects the next build-plan feature when idle", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "chore/setup"
  });

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.plans.overview.state, "current");
  assert.deepEqual(status.nextAction, {
    command: "/feature 2",
    reason: "Spec the next build-plan item, Status command."
  });
});

test("status reports legacy generated skills with matching-package sync guidance", async (t) => {
    const projectRoot = await createProject(t, {
      currentWork: resetCurrentWork(),
      findings: emptyFindings(),
      branch: "chore/setup"
    });
    await writeSkillManifest(projectRoot, {
      schemaVersion: 1,
      version: "0.10.0",
      skills: { ".agents/skills/check/SKILL.md": "Check skill\n" }
    });

    const status = await readProjectStatus(projectRoot, { packageVersion: "0.10.0" });
    const warning = status.warnings.find((entry) => entry.code === "legacy_generated_skills");

    assert.equal(status.schemaVersion, 1);
    assert.match(
      warning?.message || "",
      /npx @akash07k\/create-ai-blueprint@0\.10\.0 sync/
    );
    assert.match(formatHumanStatus(status), /legacy manifest/);
});

test("status reports missing generated skills without writes", async (t) => {
    const projectRoot = await createProject(t, {
      currentWork: resetCurrentWork(),
      findings: emptyFindings(),
      branch: "chore/setup"
    });
    const skillPath = path.join(projectRoot, ".agents", "skills", "check", "SKILL.md");
    await writeSkillManifest(projectRoot, {
      schemaVersion: 2,
      version: "0.10.0",
      skills: { ".agents/skills/check/SKILL.md": "Check skill\n" }
    });
    const manifestPath = path.join(projectRoot, "blueprint", ".state", "manifest.json");
    const manifestBefore = await fs.readFile(manifestPath, "utf8");
    await fs.rm(skillPath);

    const status = await readProjectStatus(projectRoot, { packageVersion: "0.10.0" });
    const warning = status.warnings.find((entry) => entry.code === "missing_generated_skills");

    assert.match(warning?.message || "", /1 generated Blueprint skill file is missing/);
    assert.match(
      warning?.message || "",
      /npx @akash07k\/create-ai-blueprint@0\.10\.0 sync/
    );
    await assert.rejects(fs.access(skillPath), { code: "ENOENT" });
    assert.equal(await fs.readFile(manifestPath, "utf8"), manifestBefore);
});

test("status reports modified generated skills with force recovery guidance", async (t) => {
    const projectRoot = await createProject(t, {
      currentWork: resetCurrentWork(),
      findings: emptyFindings(),
      branch: "chore/setup"
    });
    const skillPath = path.join(projectRoot, ".agents", "skills", "check", "SKILL.md");
    await writeSkillManifest(projectRoot, {
      schemaVersion: 2,
      version: "0.10.0",
      skills: { ".agents/skills/check/SKILL.md": "Check skill\n" }
    });
    await fs.writeFile(skillPath, "Modified skill\n");

    const status = await readProjectStatus(projectRoot, { packageVersion: "0.10.0" });
    const warning = status.warnings.find((entry) => entry.code === "modified_generated_skills");

    assert.match(
      warning?.message || "",
      /npx @akash07k\/create-ai-blueprint@0\.10\.0 sync --force/
    );
    assert.equal(await fs.readFile(skillPath, "utf8"), "Modified skill\n");
});

test("status uses global sync guidance only for the global command surface", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "chore/setup"
  });
  const skillPath = path.join(projectRoot, ".agents", "skills", "check", "SKILL.md");
  await writeSkillManifest(projectRoot, {
    schemaVersion: 2,
    version: "0.10.0",
    skills: { ".agents/skills/check/SKILL.md": "Check skill\n" }
  });
  await fs.rm(skillPath);

  const packageStatus = await readProjectStatus(projectRoot, { packageVersion: "0.10.0" });
  const globalStatus = await readProjectStatus(projectRoot, {
    packageVersion: "0.10.0",
    syncSurface: "global"
  });
  const packageWarning = packageStatus.warnings.find(
    (entry) => entry.code === "missing_generated_skills"
  );
  const globalWarning = globalStatus.warnings.find(
    (entry) => entry.code === "missing_generated_skills"
  );

  assert.match(
    packageWarning?.message || "",
    /npx @akash07k\/create-ai-blueprint@0\.10\.0 sync/
  );
  assert.doesNotMatch(packageWarning?.message || "", /`blueprint sync`/);
  assert.match(globalWarning?.message || "", /`blueprint sync`/);
});

test("status reports unsafe generated skill parents without writes", async (t) => {
  for (const parentType of ["symbolic-link", "non-directory"] as const) {
    const projectRoot = await createProject(t, {
      currentWork: resetCurrentWork(),
      findings: emptyFindings(),
      branch: `chore/${parentType}`
    });
    const manifestPath = path.join(projectRoot, "blueprint", ".state", "manifest.json");
    const agentsPath = path.join(projectRoot, ".agents");
    const outsideDir = path.join(projectRoot, "outside");
    await writeSkillManifest(projectRoot, {
      schemaVersion: 2,
      version: "0.10.0",
      skills: { ".agents/skills/check/SKILL.md": "Check skill\n" }
    });
    const manifestBefore = await fs.readFile(manifestPath, "utf8");
    await fs.rm(agentsPath, { recursive: true });

    if (parentType === "symbolic-link") {
      await fs.mkdir(outsideDir);
      await fs.symlink(outsideDir, agentsPath);
    } else {
      await fs.writeFile(agentsPath, "not a directory\n");
    }

    const status = await readProjectStatus(projectRoot, { packageVersion: "0.10.0" });
    const warning = status.warnings.find(
      (entry) => entry.code === "unsafe_generated_skill_paths"
    );

    assert.match(warning?.message || "", /Manually replace/);
    assert.match(warning?.message || "", /Do not use --force/);
    assert.equal(await fs.readFile(manifestPath, "utf8"), manifestBefore);
  }
});

test("status recommends the pinned package when generated skills mismatch", async (t) => {
    const projectRoot = await createProject(t, {
      currentWork: resetCurrentWork(),
      findings: emptyFindings(),
      branch: "chore/setup"
    });
    await writeSkillManifest(projectRoot, {
      schemaVersion: 2,
      version: "0.10.0",
      skills: { ".agents/skills/check/SKILL.md": "Check skill\n" }
    });

    const status = await readProjectStatus(projectRoot, { packageVersion: "0.11.0" });
    const warning = status.warnings.find(
      (entry) => entry.code === "generated_skills_package_version_mismatch"
    );

    assert.match(
      warning?.message || "",
      /npx @akash07k\/create-ai-blueprint@0\.10\.0 sync/
    );
    assert.equal(status.schemaVersion, 1);
    assert.deepEqual(Object.keys(status).sort(), [
      "blueprint",
      "completion",
      "currentWork",
      "findings",
      "git",
      "health",
      "nextAction",
      "plans",
      "project",
      "schemaVersion",
      "warnings"
    ]);
  });

  test("readProjectStatus reports a manifest-backed Copilot adapter", async (t) => {
    const projectRoot = await createProject(t, {
      currentWork: resetCurrentWork(),
      findings: emptyFindings(),
      branch: "chore/setup"
    });

  await fs.writeFile(
    path.join(projectRoot, "blueprint", ".state", "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      version: "0.8.0",
      adapters: ["copilot"],
      managedFiles: {}
    }, null, 2)}\n`
  );

  const status = await readProjectStatus(projectRoot);

  assert.deepEqual(status.blueprint.adapters, ["copilot"]);
});

test("formatHumanStatus prints a scannable orientation", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "chore/setup"
  });

  const output = formatHumanStatus(await readProjectStatus(projectRoot));

  assert.match(output, /^Blueprint Status  status-project$/m);
  assert.match(output, /^Project$/m);
  assert.match(output, /^  Build plan    1\/2 complete$/m);
  assert.match(output, /^  Work          none$/m);
  assert.match(output, /^  Findings      none$/m);
  assert.match(output, /^Git$/m);
  assert.match(output, /^  Branch        chore\/setup$/m);
  assert.match(output, /^  Working tree  clean$/m);
  assert.match(output, /^Next action$/m);
  assert.match(output, /^  \/feature 2$/m);
});

test("formatHumanStatus adds color only when requested", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "chore/setup"
  });
  const status = await readProjectStatus(projectRoot);
  const plain = formatHumanStatus(status);
  const colored = formatHumanStatus(status, { color: true });

  assert.doesNotMatch(plain, /\u001b\[/);
  assert.match(colored, /\u001b\[/);
  assert.equal(colored.replace(/\u001b\[[0-9;]*m/g, ""), plain);
});

test("shouldUseColor requires a TTY and respects NO_COLOR", () => {
  assert.equal(shouldUseColor(true, {}), true);
  assert.equal(shouldUseColor(false, {}), false);
  assert.equal(shouldUseColor(undefined, {}), false);
  assert.equal(shouldUseColor(true, { NO_COLOR: "1" }), false);
});

interface ProjectOptions {
  adapters?: readonly ("claude" | "codex" | "copilot")[];
  currentWork: string;
  findings: string;
  branch: string;
}

async function createProject(
  t: TestContext,
  options: ProjectOptions
): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-status-"));
  const projectRoot = path.join(workspace, "status-project");
  const contextRoot = path.join(projectRoot, "blueprint", "context");
  const stateRoot = path.join(projectRoot, "blueprint", ".state");
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  await fs.mkdir(contextRoot, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "# Test project\n");
  await fs.writeFile(path.join(projectRoot, "src.ts"), "export {};\n");
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "project-plan.md"),
    "# Project Plan\n"
  );
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "build-plan.md"),
    `# Build Plan

- [x] 1. **Foundation** - establish the project
- [ ] 2. **Status command** - show project state
`
  );
  await fs.writeFile(
    path.join(contextRoot, "current-feature.md"),
    options.currentWork
  );
  await fs.writeFile(path.join(contextRoot, "findings.md"), options.findings);
  await fs.writeFile(
    path.join(stateRoot, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      packageName: "@akash07k/create-ai-blueprint",
      version: "0.8.0",
      adapters: options.adapters || ["codex", "claude"],
      managedFiles: {}
    }, null, 2)}\n`
  );

  const planTime = new Date("2026-01-01T00:00:00Z");
  const overviewTime = new Date("2026-01-02T00:00:00Z");
  await fs.utimes(
    path.join(projectRoot, "blueprint", "project-plan.md"),
    planTime,
    planTime
  );
  await fs.utimes(
    path.join(projectRoot, "blueprint", "build-plan.md"),
    planTime,
    planTime
  );
  await fs.writeFile(
    path.join(contextRoot, "project-overview.md"),
    "# Project Overview\n"
  );
  await fs.utimes(
    path.join(contextRoot, "project-overview.md"),
    overviewTime,
    overviewTime
  );

  await runGit(projectRoot, ["init", "-b", options.branch]);
  await runGit(projectRoot, ["config", "user.email", "status@example.com"]);
  await runGit(projectRoot, ["config", "user.name", "Status Test"]);
  await runGit(projectRoot, ["add", "."]);
  await runGit(projectRoot, ["commit", "-m", "chore: create fixture"]);
  return projectRoot;
}

async function runGit(projectRoot: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", ["-C", projectRoot, ...args], {
    encoding: "utf8"
  });
}

function resetCurrentWork(): string {
  return `# Current Feature

_Nothing in progress. Run /feature to start._
`;
}

function emptyFindings(): string {
  return `# Findings

_No findings recorded._
`;
}

async function writeSkillManifest(
  projectRoot: string,
  {
    schemaVersion,
    version,
    skills
  }: {
    schemaVersion: 1 | 2;
    version: string;
    skills: Record<string, string>;
  }
): Promise<void> {
  for (const [relativePath, content] of Object.entries(skills)) {
    const skillPath = path.join(projectRoot, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, content);
  }

  const managedFiles = Object.fromEntries(
    Object.entries(skills).map(([relativePath, content]) => [
      relativePath,
      crypto.createHash("sha256").update(content).digest("hex")
    ])
  );
  const manifest = {
    schemaVersion,
    version,
    adapters: ["codex"],
    managedFiles,
    ...(schemaVersion === 2 ? { packageName: "@akash07k/create-ai-blueprint" } : {})
  };

  await fs.writeFile(
    path.join(projectRoot, "blueprint", ".state", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}
