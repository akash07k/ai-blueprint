import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseBuildPlan } from "../lib/build-plan.js";

const templatePath = fileURLToPath(new URL("../../../blueprint/build-plan.md", import.meta.url));

test("parseBuildPlan counts leaf items and selects the first unchecked item", () => {
  const summary = parseBuildPlan(`# Build Plan

- [x] 1. **Foundation** - establish the project
- [ ] 2. **Authentication** - add sign-in
- [ ] 3. **Dashboard** - show project state
`);

  assert.equal(summary.total, 3);
  assert.equal(summary.completed, 1);
  assert.equal(summary.remaining, 2);
  assert.equal(summary.nextItem?.id, "2");
  assert.equal(summary.nextItem?.title, "Authentication");
  assert.deepEqual(summary.warnings, []);
});

test("parseBuildPlan counts split sub-items as leaves instead of their parent", () => {
  const summary = parseBuildPlan(`- [ ] 4. **Authentication** - split parent
  - [x] 4a. **Registration** - create accounts
  - [ ] 4b. **Login** - start sessions
  - [ ] 4c. **Route protection** - protect pages
- [ ] 5. **Billing** - accept payment
`);

  assert.equal(summary.total, 4);
  assert.equal(summary.completed, 1);
  assert.equal(summary.remaining, 3);
  assert.deepEqual(summary.leafItems.map((item) => item.id), ["4a", "4b", "4c", "5"]);
  assert.deepEqual(summary.splitParents.map((item) => item.id), ["4"]);
  assert.equal(summary.nextItem?.id, "4b");
});

test("parseBuildPlan accepts uppercase checked markers and plain titles", () => {
  const summary = parseBuildPlan(`- [X] 1. Foundation - complete
- [ ] Follow-up work
`);

  assert.equal(summary.completed, 1);
  assert.equal(summary.nextItem?.id, null);
  assert.equal(summary.nextItem?.title, "Follow-up work");
});

test("parseBuildPlan preserves legacy placeholder detection with checklist examples", () => {
  const summary = parseBuildPlan(`Good:

- [ ] 1. **Skill submission** - example
- [ ] 2. **Validation result** - example

- [ ] 1. **Feature one** - description
- [ ] 2. **Feature two** - description
`);

  assert.equal(summary.total, 0);
  assert.equal(summary.nextItem, null);
  assert.equal(summary.items.length, 4);
  assert.deepEqual(summary.warnings, [
    {
      code: "placeholder_build_plan",
      message: "Build plan still contains the starter feature placeholders."
    }
  ]);
});

test("the shipped starter has two editable placeholders and no actionable progress", async () => {
  const summary = parseBuildPlan(await fs.readFile(templatePath, "utf8"));

  assert.deepEqual(summary.items.map(({ id, title }) => ({ id, title })), [
    { id: "1", title: "Feature one" },
    { id: "2", title: "Feature two" }
  ]);
  assert.deepEqual(summary.leafItems, []);
  assert.equal(summary.total, 0);
  assert.equal(summary.completed, 0);
  assert.equal(summary.remaining, 0);
  assert.equal(summary.nextItem, null);
  assert.deepEqual(summary.warnings, [{
    code: "placeholder_build_plan",
    message: "Build plan still contains the starter feature placeholders."
  }]);
});

test("replacing the shipped examples yields only the user's two features", async () => {
  const template = await fs.readFile(templatePath, "utf8");
  const summary = parseBuildPlan(template.replace("Feature one", "Login").replace("Feature two", "Reports"));

  assert.deepEqual(summary.items.map(({ id, title }) => ({ id, title })), [
    { id: "1", title: "Login" },
    { id: "2", title: "Reports" }
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.completed, 0);
  assert.equal(summary.remaining, 2);
  assert.equal(summary.nextItem?.title, "Login");
  assert.deepEqual(summary.warnings, []);
});

test("parseBuildPlan reports empty and non-checklist plans", () => {
  assert.equal(parseBuildPlan("\n").warnings[0]?.code, "empty_build_plan");
  assert.equal(
    parseBuildPlan("# Build Plan\n\n- Authentication\n").warnings[0]?.code,
    "no_checklist_items"
  );
});
