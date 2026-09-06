import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  createOverviewSourceHash,
  formatHumanStatus,
  readProjectStatus,
  shouldUseColor
} from "../lib/status.js";

const execFileAsync = promisify(execFile);

test("overview source hashes ignore build-plan completion markers", () => {
  const projectPlan = "# Project Plan\n";
  const uncheckedBuildPlan = `# Build Plan

- [ ] 1. **Foundation** - establish the project
  - [ ] 1a. **Shell** - add the shell
`;
  const completedBuildPlan = uncheckedBuildPlan
    .replace("- [ ] 1.", "- [x] 1.")
    .replace("- [ ] 1a.", "- [X] 1a.");

  assert.equal(
    createOverviewSourceHash(projectPlan, uncheckedBuildPlan),
    createOverviewSourceHash(projectPlan, completedBuildPlan)
  );
  assert.notEqual(
    createOverviewSourceHash(projectPlan, uncheckedBuildPlan),
    createOverviewSourceHash(
      projectPlan,
      uncheckedBuildPlan.replace("establish the project", "change the project")
    )
  );
});

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
  assert.equal(status.configuration.state, "defaults");
  assert.deepEqual(status.configuration.values.qualityGates, {
    regular: {
      audit: "manual",
      independentReview: "when-sensitive",
      check: "manual",
      tryGuide: "manual"
    },
    continuous: {
      audit: "manual",
      independentReview: "when-sensitive",
      check: "manual",
      tryGuide: "manual"
    }
  });
  assert.equal(status.configuration.values.review.independentExecution, "automatic");
  assert.equal(status.activity.state, "idle");
  assert.deepEqual(status.plans.build, {
    completed: 1,
    remaining: 1,
    total: 2,
    nextItem: { id: "2", title: "Status command" },
    splitParents: [],
    items: [
      { id: "1", title: "Foundation", checked: true },
      { id: "2", title: "Status command", checked: false }
    ]
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
    nextStep: { title: "Print status" },
    steps: [
      { checked: true, title: "Read plans" },
      { checked: false, title: "Print status" }
    ]
  });
  assert.deepEqual(status.history, { total: 0, items: [] });
  assert.equal(status.findings.byStatus.open, 1);
  assert.deepEqual(status.findings.active.map((finding) => finding.id), ["F-01"]);
  assert.deepEqual(status.findings.blockers, []);
  assert.equal(status.review.state, "none");
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

test("readProjectStatus reports OpenCode from the manifest", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "feature/opencode-status",
    adapters: ["opencode"]
  });

  const status = await readProjectStatus(projectRoot);

  assert.deepEqual(status.blueprint.adapters, ["opencode"]);
  assert.match(formatHumanStatus(status), /Adapters\s+opencode/);
});

test("readProjectStatus exposes valid project config", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "chore/setup"
  });
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      qualityGates: {
        continuous: { audit: "always" }
      },
      review: { independentExecution: "automatic" },
      continuous: { maxFeatures: 3 }
    }, null, 2)}\n`
  );

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.configuration.state, "project");
  assert.equal(
    status.configuration.values.qualityGates.continuous.audit,
    "always"
  );
  assert.equal(status.configuration.values.continuous.maxFeatures, 3);
  assert.equal(status.configuration.values.review.independentExecution, "automatic");
  assert.match(formatHumanStatus(status), /Review exec\.\s+automatic/);
  assert.doesNotMatch(formatHumanStatus(status), /invalid, using defaults/);
});

test("readProjectStatus uses configured branch prefixes", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: `# Feature: Status command

**From build-plan:** feature 2
**Status:** in progress

## Build steps

- [ ] **Step 1 - Print status** - format the result.
`,
    findings: emptyFindings(),
    branch: "feat/status-command"
  });
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      git: { featureBranchPrefix: "feat/" }
    }, null, 2)}\n`
  );

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.configuration.values.git.featureBranchPrefix, "feat/");
  assert.ok(
    status.warnings.every((warning) => warning.code !== "work_branch_mismatch")
  );
  assert.ok(
    status.completion.blockers.every(
      (blocker) => blocker !== "branch does not match feature work"
    )
  );
});

test("readProjectStatus warns when project config is invalid", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "chore/setup"
  });
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "config.json"),
    "not json\n"
  );

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.health, "warning");
  assert.equal(status.configuration.state, "invalid");
  assert.equal(status.configuration.values.qualityGates.regular.audit, "manual");
  assert.deepEqual(status.nextAction, {
    command: "/doctor",
    reason: "Repair blueprint/config.json before running a mutating workflow."
  });
  assert.deepEqual(status.completion, { state: "idle", blockers: [] });
  assert.ok(status.warnings.some((warning) => warning.code === "invalid_config"));
  assert.match(formatHumanStatus(status), /Config\s+invalid, using defaults/);
});

test("readProjectStatus blocks malformed current work", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: `# Current Feature

## Build steps

- [ ] Repair the current work contract.
`,
    findings: emptyFindings(),
    branch: "feature/status-command"
  });

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.currentWork.state, "malformed");
  assert.deepEqual(status.completion, {
    state: "blocked",
    blockers: ["current work contract is malformed"]
  });
});

test("readProjectStatus selects overview before new feature work", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "chore/setup"
  });
  await fs.appendFile(
    path.join(projectRoot, "blueprint", "build-plan.md"),
    "- [ ] 3. **Export status** - save a report\n"
  );

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.plans.overview.state, "stale");
  assert.equal(status.nextAction.command, "/overview");
  assert.ok(status.warnings.some((warning) => warning.code === "stale_overview"));
});

test("readProjectStatus keeps the overview current after a feature is checked off", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "main"
  });
  const projectPlan = await fs.readFile(
    path.join(projectRoot, "blueprint", "project-plan.md"),
    "utf8"
  );
  const completedBuildPlan = await fs.readFile(
    path.join(projectRoot, "blueprint", "build-plan.md"),
    "utf8"
  );
  const uncheckedBuildPlan = completedBuildPlan.replace("- [x] 1.", "- [ ] 1.");
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "context", "project-overview.md"),
    `# Project Overview

<!-- blueprint:source-hash ${createOverviewSourceHash(projectPlan, uncheckedBuildPlan)} -->
`
  );

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.plans.overview.state, "current");
  assert.deepEqual(status.completion, { state: "idle", blockers: [] });
  assert.deepEqual(status.nextAction, {
    command: "/feature 2",
    reason: "Spec the next build-plan item, Status command."
  });
  assert.match(formatHumanStatus(status), /Completion\s+idle/);
  assert.ok(
    status.warnings.every((warning) => warning.code !== "stale_overview")
  );
});

test("readProjectStatus accepts a current legacy exact-byte fingerprint", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "main"
  });
  const projectPlan = await fs.readFile(
    path.join(projectRoot, "blueprint", "project-plan.md"),
    "utf8"
  );
  const buildPlan = await fs.readFile(
    path.join(projectRoot, "blueprint", "build-plan.md"),
    "utf8"
  );
  const legacyHash = createHash("sha256")
    .update(projectPlan, "utf8")
    .update(Buffer.from([0]))
    .update(buildPlan, "utf8")
    .digest("hex");
  assert.notEqual(legacyHash, createOverviewSourceHash(projectPlan, buildPlan));
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "context", "project-overview.md"),
    `# Project Overview

<!-- blueprint:source-hash ${legacyHash} -->
`
  );

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.plans.overview.state, "current");
  assert.ok(
    status.warnings.every((warning) => warning.code !== "stale_overview")
  );
});

test("readProjectStatus requires a one-time fingerprint for legacy overviews", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "chore/setup"
  });
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "context", "project-overview.md"),
    "# Legacy Project Overview\n"
  );

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.plans.overview.state, "unknown");
  assert.equal(status.nextAction.command, "/overview");
  assert.ok(
    status.warnings.some((warning) => warning.code === "unfingerprinted_overview")
  );
});

test("readProjectStatus selects onboarding before overview for a fresh install", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "main",
    agents: `# Project instructions

## Commands

<!-- blueprint:onboarding-required -->
For a standard Next.js project. Change or remove if you're using something else.
`
  });

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.onboarding.state, "needed");
  assert.deepEqual(status.nextAction, {
    command: "/onboard",
    reason: "Tune Blueprint for this project before generating project context."
  });
  assert.ok(
    status.warnings.some((warning) => warning.code === "onboarding_incomplete")
  );
});

test("readProjectStatus recognizes the legacy onboarding marker", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "main",
    agents: `# Project instructions

## Commands

For a standard Next.js project. Change or remove if you're using something else.
`
  });

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.onboarding.state, "needed");
  assert.equal(status.nextAction.command, "/onboard");
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

test("readProjectStatus marks verified work ready for completion", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: `# Feature: Status command

**From build-plan:** feature 2
**Status:** verified

## Build steps

- [x] **Step 1 - Read plans** - parse project files.
- [x] **Step 2 - Print status** - format the result.
`,
    findings: emptyFindings(),
    branch: "feature/status-command"
  });

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.completion.state, "ready");
  assert.deepEqual(status.nextAction, {
    command: "/complete",
    reason: "The current work is verified and ready for its final safety pass."
  });
});

test("readProjectStatus blocks completion when independent review is required", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: `# Feature: Status command

**From build-plan:** feature 2
**Status:** verified

## Build steps

- [x] **Step 1 - Print status** - format the result.
`,
    findings: emptyFindings(),
    branch: "feature/status-command"
  });
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      qualityGates: { regular: { independentReview: "always" } }
    }, null, 2)}\n`
  );

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.health, "warning");
  assert.ok(status.completion.blockers.includes("independent review is required"));
  assert.deepEqual(status.nextAction, {
    command: "/audit independent current",
    reason: "Prepare or refresh the required independent review."
  });
});

test("readProjectStatus verifies work before preparing required independent review", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: `# Feature: Status command

**From build-plan:** feature 2
**Status:** in progress

## Build steps

- [x] **Step 1 - Print status** - format the result.
`,
    findings: emptyFindings(),
    branch: "feature/status-command"
  });
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      qualityGates: { regular: { independentReview: "always" } }
    }, null, 2)}\n`
  );

  const status = await readProjectStatus(projectRoot);

  assert.deepEqual(status.nextAction, {
    command: "/check",
    reason: "All build steps are checked, but verification is not persisted."
  });
});

test("readProjectStatus describes an automatic pending review as a fresh context", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: `# Feature: Status command

**From build-plan:** feature 2
**Status:** verified

## Build steps

- [x] **Step 1 - Print status** - format the result.
`,
    findings: emptyFindings(),
    branch: "feature/status-command"
  });
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "context", "review.md"),
    `# Independent Review

**Status:** pending
**Target commit:** ${"1".repeat(40)}
**Base commit:** ${"2".repeat(40)}
**Base ref:** main
**Spec hash:** ${"3".repeat(64)}
**Prepared by:** codex
**Builder model:** gpt-builder
**Requested reviewer:** codex
**Requested model:** gpt-reviewer
**Requested execution:** automatic
**Requested at:** 2026-09-06T12:00:00Z
**Workflow:** regular
**Check required:** no
`
  );

  const status = await readProjectStatus(projectRoot);
  const output = formatHumanStatus(status);

  assert.equal(status.review.requestedExecution, "automatic");
  assert.deepEqual(status.nextAction, {
    command: "/audit independent current",
    reason: "Complete the pending review from the selected fresh reviewer context."
  });
  assert.match(output, /Review\s+pending, stale, codex\/gpt-reviewer, automatic/);
  assert.doesNotMatch(output, /fresh reviewer session/);
});

test("readProjectStatus uses the Continuous independent review policy", async (t) => {
  const now = new Date().toISOString();
  const projectRoot = await createProject(t, {
    currentWork: `# Feature: Status command

**From build-plan:** feature 2
**Status:** verified

## Build steps

- [x] **Step 1 - Print status** - format the result.
`,
    findings: emptyFindings(),
    branch: "feature/status-command",
    runState: {
      schemaVersion: 1,
      command: "continuous",
      status: "ready",
      summary: "Waiting for the configured review gate",
      boundary: "local-only",
      startedAt: now,
      updatedAt: now
    }
  });
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      qualityGates: {
        regular: { independentReview: "manual" },
        continuous: { independentReview: "always" }
      }
    }, null, 2)}\n`
  );

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.health, "warning");
  assert.ok(status.completion.blockers.includes("independent review is required"));
  assert.deepEqual(status.nextAction, {
    command: "/audit independent current",
    reason: "Prepare or refresh the required independent review."
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

test("readProjectStatus exposes recorded dashboard activity", async (t) => {
  const now = new Date();
  const startedAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const updatedAt = new Date(now.getTime() - 60 * 1000).toISOString();
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "main",
    runState: {
      schemaVersion: 1,
      command: "continuous",
      status: "running",
      summary: "Completing the remaining build plan",
      boundary: "local-only",
      startedAt,
      updatedAt,
      resumeCommand: "/continuous resume",
      progress: { current: 2, total: 5, label: "features" }
    }
  });

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.activity.state, "recorded");
  assert.equal(status.activity.mode, "continuous");
  assert.equal(status.activity.command, "continuous");
  assert.equal(status.activity.freshness, "current");
  assert.deepEqual(status.activity.progress, {
    current: 2,
    total: 5,
    label: "features"
  });
  assert.match(formatHumanStatus(status), /Activity\s+\/continuous running, 2\/5 features/);
  assert.deepEqual(status.nextAction, {
    command: null,
    reason: "/continuous is currently running."
  });
});

test("readProjectStatus offers the recovery command for interrupted activity", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "main",
    runState: {
      schemaVersion: 1,
      command: "continuous",
      status: "running",
      summary: "Completing the remaining build plan",
      startedAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:05:00.000Z",
      resumeCommand: "/continuous resume"
    }
  });

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.activity.freshness, "stale");
  assert.deepEqual(status.nextAction, {
    command: "/continuous resume",
    reason: "Recorded /continuous activity appears interrupted. Confirm the project state before resuming."
  });
  assert.ok(status.warnings.some((warning) => warning.code === "stale_run_state"));
});

test("readProjectStatus sends malformed dashboard state to Doctor", async (t) => {
  const projectRoot = await createProject(t, {
    currentWork: resetCurrentWork(),
    findings: emptyFindings(),
    branch: "main",
    runState: {
      schemaVersion: 1,
      command: "feature"
    }
  });

  const status = await readProjectStatus(projectRoot);

  assert.equal(status.activity.state, "malformed");
  assert.deepEqual(status.nextAction, {
    command: "/doctor",
    reason: "Inspect and reset malformed dashboard state in blueprint/.state/run.json."
  });
  assert.ok(status.warnings.some((warning) =>
    warning.code === "malformed_run_state" &&
    warning.message.includes("Run /doctor")
  ));
  assert.match(formatHumanStatus(status), /Next action\n  \/doctor/);
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
  assert.match(output, /^  Config        built-in defaults$/m);
  assert.match(output, /^  Review exec\.  automatic$/m);
  assert.match(
    output,
    /^  Regular gates audit manual, independent review when-sensitive, check manual, try guide manual$/m
  );
  assert.match(
    output,
    /^  Cont\. gates   audit manual, independent review when-sensitive, check manual, try guide manual$/m
  );
  assert.match(output, /^  Findings      none$/m);
  assert.match(output, /^  Review        none$/m);
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
  adapters?: readonly ("claude" | "codex" | "copilot" | "opencode")[];
  agents?: string;
  currentWork: string;
  findings: string;
  branch: string;
  runState?: Record<string, unknown>;
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
  await fs.writeFile(
    path.join(projectRoot, "AGENTS.md"),
    options.agents || "# Test project\n"
  );
  await fs.writeFile(path.join(projectRoot, "src.ts"), "export {};\n");
  const projectPlan = "# Project Plan\n";
  const buildPlan = `# Build Plan

- [x] 1. **Foundation** - establish the project
- [ ] 2. **Status command** - show project state
`;
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "project-plan.md"),
    projectPlan
  );
  if (options.runState) {
    await fs.writeFile(
      path.join(stateRoot, "run.json"),
      `${JSON.stringify(options.runState, null, 2)}\n`
    );
  }
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "build-plan.md"),
    buildPlan
  );
  await fs.writeFile(
    path.join(contextRoot, "current-feature.md"),
    options.currentWork
  );
  await fs.writeFile(path.join(contextRoot, "findings.md"), options.findings);
  await fs.writeFile(
    path.join(stateRoot, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
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
    `# Project Overview

<!-- blueprint:source-hash ${createOverviewSourceHash(projectPlan, buildPlan)} -->
`
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
