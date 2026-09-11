import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  findProjectRoot,
  isBlueprintProjectRoot
} from "../lib/project-root.js";

test("findProjectRoot resolves a legacy Blueprint project", async (t) => {
  const workspace = await createWorkspace(t);
  const projectRoot = path.join(workspace, "app");
  const nestedDir = path.join(projectRoot, "src", "features");

  await fs.mkdir(path.join(projectRoot, "blueprint"), { recursive: true });
  await fs.mkdir(nestedDir, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "# Project\n");

  assert.equal(await findProjectRoot(nestedDir), await fs.realpath(projectRoot));
  assert.equal(await isBlueprintProjectRoot(projectRoot), true);
});

test("findProjectRoot resolves a manifest-backed project with missing AGENTS.md", async (t) => {
  const workspace = await createWorkspace(t);
  const projectRoot = path.join(workspace, "app");
  const manifestPath = path.join(
    projectRoot,
    "blueprint",
    ".state",
    "manifest.json"
  );

  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, "{}\n");

  assert.equal(await findProjectRoot(projectRoot), await fs.realpath(projectRoot));
});

test("findProjectRoot accepts a file inside a Blueprint project", async (t) => {
  const workspace = await createWorkspace(t);
  const projectRoot = path.join(workspace, "app");
  const sourceFile = path.join(projectRoot, "src", "index.js");

  await fs.mkdir(path.join(projectRoot, "blueprint"), { recursive: true });
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "# Project\n");
  await fs.writeFile(sourceFile, "export {};\n");

  assert.equal(await findProjectRoot(sourceFile), await fs.realpath(projectRoot));
});

test("findProjectRoot returns null outside a Blueprint project", async (t) => {
  const workspace = await createWorkspace(t);

  assert.equal(await findProjectRoot(workspace), null);
  assert.equal(await isBlueprintProjectRoot(workspace), false);
});

test(
  "findProjectRoot rejects a symlinked Blueprint directory",
  { skip: process.platform === "win32" },
  async (t) => {
    const workspace = await createWorkspace(t);
    const projectRoot = path.join(workspace, "app");
    const externalBlueprint = path.join(workspace, "external-blueprint");

    await fs.mkdir(projectRoot);
    await fs.mkdir(externalBlueprint);
    await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "# Project\n");
    await fs.symlink(externalBlueprint, path.join(projectRoot, "blueprint"));

    assert.equal(await findProjectRoot(projectRoot), null);
  }
);

async function createWorkspace(t: TestContext): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-root-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return workspace;
}
