import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(repoRoot, "packages", "create-ai-blueprint");

test("link:local can replace its existing global link", { timeout: 300_000 }, async () => {
  const prefix = await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-local-link-"));

  try {
    const first = runNpm(prefix, ["run", "link:local"]);
    assert.equal(first.status, 0, formatFailure(first));

    const second = runNpm(prefix, ["run", "link:local"]);
    assert.equal(second.status, 0, formatFailure(second));

    const npmRoot = runNpm(prefix, ["root", "--global"]);
    assert.equal(npmRoot.status, 0, formatFailure(npmRoot));
    assert.equal(
      await canonicalPath(path.join(npmRoot.stdout.trim(), "create-ai-blueprint")),
      await canonicalPath(packageRoot)
    );

    const binRoot = process.platform === "win32" ? prefix : path.join(prefix, "bin");
    const suffix = process.platform === "win32" ? ".cmd" : "";
    await Promise.all(
      ["create-ai-blueprint", "blueprint"].map((name) =>
        fs.access(path.join(binRoot, `${name}${suffix}`))
      )
    );
  } finally {
    await fs.rm(prefix, { recursive: true, force: true });
  }
});

function runNpm(prefix: string, args: string[]) {
  const npmExecPath = process.env.npm_execpath;
  assert.ok(npmExecPath, "npm_execpath is required to run the local-link integration test.");

  return spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_prefix: prefix,
      npm_config_update_notifier: "false"
    },
    maxBuffer: 64 * 1024 * 1024
  });
}

async function canonicalPath(target: string): Promise<string> {
  const resolved = await fs.realpath(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function formatFailure(result: ReturnType<typeof runNpm>): string {
  return [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
}
