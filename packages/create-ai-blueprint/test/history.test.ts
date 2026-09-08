import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { parseHistoryItem, readHistory } from "../lib/history.js";

test("parseHistoryItem reads completed Blueprint work", () => {
  assert.deepEqual(
    parseHistoryItem(
      `# Feature: Live dashboard

**From build-plan:** feature 12a
**Status:** complete
`,
      "feature",
      "features/12a-live-dashboard.md"
    ),
    {
      type: "feature",
      title: "Live dashboard",
      buildPlanItem: "12a",
      status: "complete",
      file: "features/12a-live-dashboard.md"
    }
  );
});

test("parseHistoryItem accepts a numbered feature field", () => {
  assert.deepEqual(
    parseHistoryItem(
      `# Current Feature

**Feature:** 1. App shell and dashboard UI
**Status:** verified
`,
      "feature",
      "features/01-app-shell-and-dashboard-ui.md"
    ),
    {
      type: "feature",
      title: "App shell and dashboard UI",
      buildPlanItem: "1",
      status: "verified",
      file: "features/01-app-shell-and-dashboard-ui.md"
    }
  );
});

test("parseHistoryItem accepts the strict Current Feature compatibility line", () => {
  assert.deepEqual(
    parseHistoryItem(
      `# Current Feature

**Feature 4: Accounts and login**
**Status:** verified
`,
      "feature",
      "features/04-accounts-and-login.md"
    ),
    {
      type: "feature",
      title: "Accounts and login",
      buildPlanItem: "4",
      status: "verified",
      file: "features/04-accounts-and-login.md"
    }
  );
});

test("parseHistoryItem does not apply feature compatibility to near misses or other groups", () => {
  const nearMiss = parseHistoryItem(
    `# Current Feature

**Feature 4 - Accounts and login**
`,
    "feature",
    "features/04-accounts-and-login.md"
  );
  const fix = parseHistoryItem(
    `# Current Feature

**Feature 4: Accounts and login**
`,
    "fix",
    "fixes/accounts-and-login.md"
  );
  const rollback = parseHistoryItem(
    `# Current Feature

**Feature 4: Accounts and login**
`,
    "rollback",
    "rollbacks/accounts-and-login.md"
  );
  const canonicalFix = parseHistoryItem(
    `# Current Feature

**Feature 4: Accounts and login**
**Fix:** Repair account login
`,
    "feature",
    "features/04-accounts-and-login.md"
  );

  assert.equal(nearMiss.title, "Current Feature");
  assert.equal(nearMiss.buildPlanItem, null);
  assert.deepEqual(
    [fix.type, fix.title, fix.buildPlanItem],
    ["fix", "Current Feature", null]
  );
  assert.deepEqual(
    [rollback.type, rollback.title, rollback.buildPlanItem],
    ["rollback", "Current Feature", null]
  );
  assert.deepEqual(
    [canonicalFix.type, canonicalFix.title, canonicalFix.buildPlanItem],
    ["fix", "Repair account login", null]
  );
});

test("readHistory reads feature, fix, and rollback archives", async (t) => {
  const projectRoot = await createProject(t);

  const history = await readHistory(projectRoot);

  assert.equal(history.total, 3);
  assert.deepEqual(
    history.items.map((item) => ({ type: item.type, title: item.title })),
    [
      { type: "feature", title: "Second feature" },
      { type: "feature", title: "First feature" },
      { type: "fix", title: "Repair navigation" }
    ]
  );
});

test("readHistory retains a Build 2 title and renamed rebuild under the same lettered feature ID", async (t) => {
  const projectRoot = await createProject(t);
  const builds = [
    { file: "12a-export-build-2.md", title: "Export Build 2", attempt: "" },
    { file: "12a-export--build-2.md", title: "Export", attempt: "**Build attempt:** 2\n" }
  ];
  for (const build of builds) {
    await fs.writeFile(
      path.join(projectRoot, "blueprint", "history", "features", build.file),
      `# Feature: ${build.title}\n\n**From build-plan:** feature 12a\n${build.attempt}**Status:** verified\n`
    );
  }

  const history = await readHistory(projectRoot);
  const rebuiltFeature = history.items.filter((item) => item.buildPlanItem === "12a");

  assert.equal(history.total, 5);
  assert.deepEqual(
    rebuiltFeature.map(({ file, title, type, status }) => ({ file, title, type, status }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    builds.map(({ file, title }) => ({ file: `features/${file}`, title, type: "feature", status: "verified" }))
      .sort((a, b) => a.file.localeCompare(b.file))
  );
});

test("readHistory does not follow a symbolic-link history directory", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-history-project-"));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-history-outside-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  t.after(() => fs.rm(outsideRoot, { recursive: true, force: true }));

  await fs.mkdir(path.join(outsideRoot, "features"), { recursive: true });
  await fs.writeFile(
    path.join(outsideRoot, "features", "secret.md"),
    "# Feature: Outside work\n"
  );
  await fs.mkdir(path.join(projectRoot, "blueprint"), { recursive: true });
  await fs.symlink(outsideRoot, path.join(projectRoot, "blueprint", "history"));

  assert.deepEqual(await readHistory(projectRoot), { items: [], total: 0 });
});

async function createProject(t: TestContext): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-history-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));

  for (const directory of ["features", "fixes", "rollbacks"]) {
    await fs.mkdir(path.join(projectRoot, "blueprint", "history", directory), {
      recursive: true
    });
    await fs.writeFile(
      path.join(projectRoot, "blueprint", "history", directory, "README.md"),
      `# ${directory}\n`
    );
  }

  await fs.writeFile(
    path.join(projectRoot, "blueprint", "history", "features", "01-first-feature.md"),
    "# Feature: First feature\n\n**From build-plan:** feature 1\n**Status:** complete\n"
  );
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "history", "features", "02-second-feature.md"),
    "# Feature: Second feature\n\n**From build-plan:** feature 2\n**Status:** complete\n"
  );
  await fs.writeFile(
    path.join(projectRoot, "blueprint", "history", "fixes", "repair-navigation.md"),
    "# Fix: Repair navigation\n\n**Status:** complete\n"
  );

  return projectRoot;
}
