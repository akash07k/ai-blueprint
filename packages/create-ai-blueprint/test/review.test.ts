import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  parseIndependentReview,
  readIndependentReview
} from "../lib/review.js";

const execFileAsync = promisify(execFile);
const TARGET = "1".repeat(40);
const BASE = "2".repeat(40);
const SPEC_HASH = "3".repeat(64);

test("parseIndependentReview recognizes the reset stub", () => {
  const review = parseIndependentReview(`# Independent Review

_No independent review requested. Run /audit independent current to prepare one._
`);

  assert.equal(review.state, "none");
  assert.equal(review.freshness, "not-applicable");
  assert.deepEqual(review.warnings, []);
});

test("parseIndependentReview reads pending and completed records", () => {
  const pending = parseIndependentReview(
    reviewRecord("pending", false, { requested: "automatic" })
  );

  assert.equal(pending.state, "pending");
  assert.equal(pending.targetCommit, TARGET);
  assert.equal(pending.requestedReviewer, "claude");
  assert.equal(pending.requestedModel, "claude-opus");
  assert.equal(pending.requestedExecution, "automatic");

  const passed = parseIndependentReview(reviewRecord("passed", true));

  assert.equal(passed.state, "passed");
  assert.equal(passed.reviewerAdapter, "claude");
  assert.equal(passed.reviewerModel, "claude-opus");
  assert.equal(passed.reviewerContext, "fresh session");
  assert.equal(passed.requestedExecution, null);
  assert.equal(passed.actualExecution, null);
  assert.equal(passed.checkResult, "not-required");

  const subagent = parseIndependentReview(
    reviewRecord("passed", true, {
      requested: "automatic",
      actual: "automatic",
      context: "fresh subagent"
    })
  );
  assert.equal(subagent.state, "passed");
  assert.equal(subagent.reviewerContext, "fresh subagent");
  assert.equal(subagent.requestedExecution, "automatic");
  assert.equal(subagent.actualExecution, "automatic");
});

test("parseIndependentReview keeps legacy pending and completed reviews manual-only", () => {
  const pending = parseIndependentReview(reviewRecord("pending"));
  assert.equal(pending.state, "pending");
  assert.equal(pending.requestedExecution, null);

  const completed = parseIndependentReview(reviewRecord("passed", true));
  assert.equal(completed.state, "passed");
  assert.equal(completed.reviewerContext, "fresh session");
  assert.equal(completed.requestedExecution, null);
  assert.equal(completed.actualExecution, null);

  const actualAdded = parseIndependentReview(
    reviewRecord("passed", true).replace(
      "**Reviewer context:** fresh session",
      "**Reviewer context:** fresh session\n**Actual execution:** manual"
    )
  );
  assert.equal(actualAdded.state, "malformed");

  const pendingActualAdded = parseIndependentReview(
    reviewRecord("pending").replace(
      "**Requested at:**",
      "**Actual execution:** manual\n**Requested at:**"
    )
  );
  assert.equal(pendingActualAdded.state, "malformed");

  const subagent = parseIndependentReview(
    reviewRecord("passed", true).replace(
      "**Reviewer context:** fresh session",
      "**Reviewer context:** fresh subagent"
    )
  );
  assert.equal(subagent.state, "malformed");
});

test("parseIndependentReview accepts an explicit automatic-to-manual fallback", () => {
  const review = parseIndependentReview(
    reviewRecord("passed", true, {
      requested: "automatic",
      actual: "manual",
      context: "fresh session"
    })
  );

  assert.equal(review.state, "passed");
  assert.equal(review.requestedExecution, "automatic");
  assert.equal(review.actualExecution, "manual");
});

test("parseIndependentReview accepts an explicitly bound manual review", () => {
  const review = parseIndependentReview(
    reviewRecord("passed", true, {
      requested: "manual",
      actual: "manual",
      context: "fresh session"
    })
  );

  assert.equal(review.state, "passed");
  assert.equal(review.requestedExecution, "manual");
  assert.equal(review.actualExecution, "manual");
});

test("parseIndependentReview rejects invalid execution and context pairings", () => {
  const manualSubagent = parseIndependentReview(
    reviewRecord("passed", true, {
      requested: "manual",
      actual: "automatic",
      context: "fresh subagent"
    })
  );
  assert.equal(manualSubagent.state, "malformed");

  const mismatchedAutomatic = parseIndependentReview(
    reviewRecord("passed", true, {
      requested: "automatic",
      actual: "automatic",
      context: "fresh session"
    })
  );
  assert.equal(mismatchedAutomatic.state, "malformed");

});

test("parseIndependentReview rejects incomplete receipts", () => {
  const review = parseIndependentReview(`# Independent Review

**Status:** passed
**Target commit:** ${TARGET}
`);

  assert.equal(review.state, "malformed");
  assert.equal(review.warnings[0]?.code, "malformed_review");
});

test("parseIndependentReview rejects an unsupported reviewer context", () => {
  const review = parseIndependentReview(
    reviewRecord("passed", true).replace(
      "**Reviewer context:** fresh session",
      "**Reviewer context:** builder session"
    )
  );

  assert.equal(review.state, "malformed");
});

test("parseIndependentReview requires completed evidence and a passing required Check", () => {
  const withoutEvidence = parseIndependentReview(
    reviewRecord("passed", true).replace(/\n## Commands[\s\S]*$/, "\n")
  );
  assert.equal(withoutEvidence.state, "malformed");

  const failedRequiredCheck = parseIndependentReview(
    reviewRecord("passed", true)
      .replace("**Check required:** no", "**Check required:** yes")
      .replace("**Check result:** not-required", "**Check result:** failed")
  );
  assert.equal(failedRequiredCheck.state, "malformed");

  const passedRequiredCheck = parseIndependentReview(
    reviewRecord("passed", true)
      .replace("**Check required:** no", "**Check required:** yes")
      .replace("**Check result:** not-required", "**Check result:** passed")
  );
  assert.equal(passedRequiredCheck.state, "passed");

  const unresolvedReviewerModel = parseIndependentReview(
    reviewRecord("passed", true)
      .replace(
        "**Requested model:** claude-opus",
        "**Requested model:** runtime default (exact model not known until reviewer starts)"
      )
      .replace(
        "**Reviewer model:** claude-opus",
        "**Reviewer model:** runtime default (exact model not known until reviewer starts)"
      )
  );
  assert.equal(unresolvedReviewerModel.state, "malformed");
});

test("readIndependentReview marks product changes stale but ignores review evidence", async (t) => {
  const projectRoot = await createProject(t);
  const currentWorkPath = path.join(
    projectRoot,
    "blueprint",
    "context",
    "current-feature.md"
  );
  const currentWork = await fs.readFile(currentWorkPath, "utf8");
  const target = await runGit(projectRoot, ["rev-parse", "HEAD"]);
  const base = await runGit(projectRoot, ["rev-parse", "main"]);
  const specHash = createHash("sha256").update(currentWork).digest("hex");
  const reviewPath = path.join(projectRoot, "blueprint", "context", "review.md");
  const findingsPath = path.join(projectRoot, "blueprint", "context", "findings.md");

  await fs.writeFile(
    reviewPath,
    reviewRecord("passed", true)
      .replaceAll(TARGET, target)
      .replaceAll(BASE, base)
      .replaceAll(SPEC_HASH, specHash)
  );
  await fs.appendFile(findingsPath, "\nReview evidence.\n");

  const current = await readIndependentReview(projectRoot);
  assert.equal(current.state, "passed");
  assert.equal(current.freshness, "current");

  await fs.writeFile(
    reviewPath,
    (await fs.readFile(reviewPath, "utf8")).replace(
      "**Reviewer adapter:** claude",
      "**Reviewer adapter:** codex"
    )
  );
  const mismatched = await readIndependentReview(projectRoot);
  assert.equal(mismatched.freshness, "stale");
  await fs.writeFile(
    reviewPath,
    (await fs.readFile(reviewPath, "utf8")).replace(
      "**Reviewer adapter:** codex",
      "**Reviewer adapter:** claude"
    )
  );

  await fs.appendFile(path.join(projectRoot, "src.ts"), "export const changed = true;\n");

  const stale = await readIndependentReview(projectRoot);
  assert.equal(stale.freshness, "stale");
});

test("readIndependentReview rejects an incorrect base and reviewer model", async (t) => {
  const projectRoot = await createProject(t);
  const currentWorkPath = path.join(
    projectRoot,
    "blueprint",
    "context",
    "current-feature.md"
  );
  const currentWork = await fs.readFile(currentWorkPath, "utf8");
  const target = await runGit(projectRoot, ["rev-parse", "HEAD"]);
  const base = await runGit(projectRoot, ["rev-parse", "main"]);
  const specHash = createHash("sha256").update(currentWork).digest("hex");
  const reviewPath = path.join(projectRoot, "blueprint", "context", "review.md");
  const completed = reviewRecord("passed", true)
    .replaceAll(TARGET, target)
    .replaceAll(BASE, base)
    .replaceAll(SPEC_HASH, specHash);

  await fs.writeFile(
    reviewPath,
    completed.replace("**Base commit:** " + base, "**Base commit:** " + BASE)
  );
  assert.equal((await readIndependentReview(projectRoot)).freshness, "stale");

  await fs.writeFile(
    reviewPath,
    completed.replace("**Reviewer model:** claude-opus", "**Reviewer model:** claude-sonnet")
  );
  assert.equal((await readIndependentReview(projectRoot)).freshness, "stale");

  await fs.writeFile(
    reviewPath,
    completed.replace("**Base ref:** main", "**Base ref:** feature/review")
  );
  assert.equal((await readIndependentReview(projectRoot)).freshness, "stale");

  await fs.writeFile(
    reviewPath,
    completed.replace(
      "**Requested model:** claude-opus",
      "**Requested model:** runtime default (exact model not known until reviewer starts)"
    )
  );
  assert.equal((await readIndependentReview(projectRoot)).freshness, "current");
});

function reviewRecord(
  status: "changes-requested" | "passed" | "pending",
  completed = false,
  execution?: {
    requested: "automatic" | "manual";
    actual?: "automatic" | "manual";
    context?: "fresh session" | "fresh subagent";
  }
): string {
  return `# Independent Review

**Status:** ${status}
**Target commit:** ${TARGET}
**Base commit:** ${BASE}
**Base ref:** main
**Spec hash:** ${SPEC_HASH}
**Prepared by:** codex
**Builder model:** gpt-builder
**Requested reviewer:** claude
**Requested model:** claude-opus
${execution ? `**Requested execution:** ${execution.requested}\n` : ""}**Requested at:** 2026-08-31T11:00:00Z
**Workflow:** regular
**Check required:** no
${completed ? `**Reviewer adapter:** claude
**Reviewer model:** claude-opus
**Reviewer context:** ${execution?.context || "fresh session"}
${execution?.actual ? `**Actual execution:** ${execution.actual}\n` : ""}**Reviewed at:** 2026-08-31T12:00:00Z
**Scope:** current
**Lenses:** quality, security, performance, tests
**Verdict:** ${status}
**Check result:** not-required

## Commands

- \`npm test\`: passed

## Evidence

- Unit test output reviewed.

## Findings

- None

## Remaining risk

- None identified
` : ""}`;
}

async function createProject(t: TestContext): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-review-"));
  const contextRoot = path.join(projectRoot, "blueprint", "context");
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));

  await fs.mkdir(contextRoot, { recursive: true });
  await fs.writeFile(
    path.join(contextRoot, "current-feature.md"),
    "# Feature: Review receipt\n\n**Status:** in progress\n"
  );
  await fs.writeFile(path.join(contextRoot, "findings.md"), "# Findings\n");
  await fs.writeFile(
    path.join(contextRoot, "review.md"),
    "# Independent Review\n\n_No independent review requested.\n"
  );
  await fs.writeFile(path.join(projectRoot, "src.ts"), "export {};\n");
  await runGit(projectRoot, ["init", "-b", "main"]);
  await runGit(projectRoot, ["config", "user.email", "review@example.com"]);
  await runGit(projectRoot, ["config", "user.name", "Review Test"]);
  await runGit(projectRoot, ["add", "."]);
  await runGit(projectRoot, ["commit", "-m", "chore: create review fixture"]);
  await runGit(projectRoot, ["switch", "-c", "feature/review"]);
  await fs.appendFile(path.join(projectRoot, "src.ts"), "export const feature = true;\n");
  await runGit(projectRoot, ["add", "src.ts"]);
  await runGit(projectRoot, ["commit", "-m", "feat: add review target"]);
  return projectRoot;
}

async function runGit(projectRoot: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", projectRoot, ...args], {
    encoding: "utf8"
  });
  return result.stdout.trim();
}
