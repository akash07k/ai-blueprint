import assert from "node:assert/strict";
import test from "node:test";

import { parseCurrentWork } from "../lib/current-work.js";

test("parseCurrentWork recognizes the reset stub", () => {
  const currentWork = parseCurrentWork(`# Current Feature

_Nothing in progress. Run /feature to start._
`);

  assert.equal(currentWork.state, "idle");
  assert.equal(currentWork.total, 0);
  assert.deepEqual(currentWork.warnings, []);
});

test("parseCurrentWork reports feature identity and step progress", () => {
  const currentWork = parseCurrentWork(`# Feature: Status command

**From build-plan:** feature 2
**Status:** in progress

## Build steps

- [x] **Step 1 - Read plans** - parse project files.
- [ ] **Step 2 - Print status** - format the result.

## Testing
`);

  assert.equal(currentWork.state, "active");
  assert.equal(currentWork.type, "feature");
  assert.equal(currentWork.title, "Status command");
  assert.equal(currentWork.buildPlanItem, "2");
  assert.equal(currentWork.completed, 1);
  assert.equal(currentWork.remaining, 1);
  assert.equal(currentWork.nextStep?.title, "Print status");
  assert.deepEqual(currentWork.warnings, []);
});

test("parseCurrentWork accepts a numbered feature field", () => {
  const currentWork = parseCurrentWork(`# Current Feature

**Feature:** 2. Testing foundation
**Branch:** \`feature/testing-foundation\`

## Build steps

- [ ] 1. **Install and wire the runner.** Add Vitest.
`);

  assert.equal(currentWork.state, "active");
  assert.equal(currentWork.type, "feature");
  assert.equal(currentWork.title, "Testing foundation");
  assert.equal(currentWork.buildPlanItem, "2");
  assert.equal(currentWork.nextStep?.title, "Install and wire the runner.");
  assert.deepEqual(currentWork.warnings, []);
});

test("parseCurrentWork accepts the strict Current Feature compatibility line", () => {
  const markdown = `# Current Feature

**Feature 4: Accounts and login**
**Status:** in progress

## Build steps

- [ ] Add account routes.
`;
  const currentWork = parseCurrentWork(markdown);
  const letteredWork = parseCurrentWork(markdown.replace("Feature 4:", "Feature 4a:"));

  assert.equal(currentWork.state, "active");
  assert.equal(currentWork.type, "feature");
  assert.equal(currentWork.title, "Accounts and login");
  assert.equal(currentWork.buildPlanItem, "4");
  assert.deepEqual(currentWork.warnings, []);
  assert.equal(letteredWork.state, "active");
  assert.equal(letteredWork.buildPlanItem, "4a");
});

test("parseCurrentWork rejects compatibility near misses and other work types", () => {
  const documents = [
    `# Current Feature

**Feature 4 - Accounts and login**

## Build steps

- [ ] Add account routes.
`,
    `# Current Feature

**Fix 4: Accounts and login**

## Build steps

- [ ] Add account routes.
`,
    `# Current Fix

**Feature 4: Accounts and login**

## Build steps

- [ ] Add account routes.
`
  ];

  for (const markdown of documents) {
    const currentWork = parseCurrentWork(markdown);
    assert.equal(currentWork.state, "malformed");
    assert.equal(currentWork.buildPlanItem, null);
    assert.equal(currentWork.warnings[0]?.code, "malformed_current_work");
  }

  const canonicalFix = parseCurrentWork(`# Current Feature

**Feature 4: Accounts and login**
**Type:** Fix

## Build steps

- [ ] Add account routes.
`);
  assert.equal(canonicalFix.state, "active");
  assert.equal(canonicalFix.type, "fix");
  assert.equal(canonicalFix.title, "Current Feature");
  assert.equal(canonicalFix.buildPlanItem, null);
});

test("parseCurrentWork reports an incomplete active-work contract", () => {
  const currentWork = parseCurrentWork(`# Feature: Missing identity

## Goal

No build steps yet.
`);

  assert.equal(currentWork.state, "malformed");
  assert.equal(currentWork.warnings[0]?.code, "malformed_current_work");
});

test("parseCurrentWork ignores nested acceptance checkboxes", () => {
  const currentWork = parseCurrentWork(`# Fix: Nested checklist

**Type:** Fix

## Build steps

- [ ] Repair the status parser.
  - [x] Unit test
  - [ ] Package smoke test
- [ ] Verify the command.
`);

  assert.equal(currentWork.total, 2);
  assert.equal(currentWork.completed, 0);
  assert.equal(currentWork.nextStep?.title, "Repair the status parser.");
});
