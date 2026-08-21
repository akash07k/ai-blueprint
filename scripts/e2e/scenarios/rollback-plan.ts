const FEATURE_ARCHIVE = `# Feature 1: Greeting punctuation

**Type:** Feature
**Status:** Complete

## Goal

Change the default output from \`Hello world\` to \`Hello, world!\`.

## Build steps

- [x] 1. Update \`src/greeting.js\`.

## Verification

\`node src/greeting.js\` printed \`Hello, world!\`.
`;
const MERGE_FEATURE_ARCHIVE = `# Feature 2: Merge target

**Type:** Feature
**Status:** Complete

## Goal

Add a greeting helper through a merge commit.

## Build steps

- [x] 1. Add \`src/merge-greeting.js\`.

## Verification

\`node src/merge-greeting.js\` printed \`Hello from the merge target\`.
`;

import type { Runner } from "../harness.js";

async function run(t: Runner) {
  t.phase("setup");
  t.installBlueprint();
  t.write("blueprint/build-plan.md", "# Build Plan\n\n- [ ] 1. Greeting punctuation\n");
  t.write("src/greeting.js", 'console.log("Hello world");\n');
  t.gitInit();
  t.git("add", "-A");
  t.git("commit", "-m", "chore: create rollback baseline");

  t.write("blueprint/build-plan.md", "# Build Plan\n\n- [x] 1. Greeting punctuation\n");
  t.write("blueprint/history/features/01-greeting-punctuation.md", FEATURE_ARCHIVE);
  t.write("src/greeting.js", 'console.log("Hello, world!");\n');
  t.git("add", "-A");
  t.git("commit", "-m", "feat: add greeting punctuation");
  const featureCommit = t.git("rev-parse", "HEAD");
  const featureParent = t.git("rev-parse", `${featureCommit}^`);

  t.write("src/unrelated.js", 'module.exports = "later work";\n');
  t.git("add", "-A");
  t.git("commit", "-m", "feat: add unrelated utility");
  const headBefore = t.git("rev-parse", "HEAD");
  const archiveBefore = t.read("blueprint/history/features/01-greeting-punctuation.md");

  t.phase("rollback plans the reversal without applying it");
  const result = t.agent(
    "Run /rollback 1 because the punctuation breaks a strict downstream consumer. Plan it and stop for review."
  );
  const rollbackSpec = t.read("blueprint/context/current-feature.md") || "";
  const targetCommit = rollbackSpec.match(
    /^\*\*Target commit:\*\*\s*`?([0-9a-f]{40})`?\s*$/im
  )?.[1];
  const targetParent = rollbackSpec.match(
    /^\*\*Target parent:\*\*\s*`?([0-9a-f]{40})`?\s*$/im
  )?.[1];
  const changedPaths = t
    .git("status", "--porcelain")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^[ MADRCU?!]{1,2}\s+/, ""));

  t.check("agent invocation succeeded", result.status === 0);
  t.check("the repository stayed on main", t.git("branch", "--show-current") === "main");
  t.check("no commit was created", t.git("rev-parse", "HEAD") === headBefore);
  t.check("product code was not reversed", (t.read("src/greeting.js") ?? "").includes("Hello, world!"));
  t.check(
    "the completed feature archive was preserved",
    t.read("blueprint/history/features/01-greeting-punctuation.md") === archiveBefore
  );
  t.check("a rollback spec was written", /^\*\*Type:\*\*\s*Rollback\s*$/im.test(rollbackSpec));
  t.check(
    "the spec records the exact 40-character feature commit",
    targetCommit === featureCommit
  );
  t.check(
    "the spec records the exact 40-character feature parent",
    targetParent === featureParent
  );
  t.check("the spec records the user's reason", /downstream consumer/i.test(rollbackSpec));
  t.check(
    "only the current feature spec changed",
    changedPaths.length === 1 && changedPaths[0] === "blueprint/context/current-feature.md"
  );

  t.phase("rollback plans a merge target for implementation review");
  t.git("restore", "blueprint/context/current-feature.md");
  t.write(
    "blueprint/build-plan.md",
    "# Build Plan\n\n- [x] 1. Greeting punctuation\n- [ ] 2. Merge target\n"
  );
  t.git("add", "-A");
  t.git("commit", "-m", "chore: prepare merge rollback target");
  t.git("checkout", "-b", "feature/merge-target");
  t.write("src/merge-greeting.js", 'console.log("Hello from the merge target");\n');
  t.git("add", "-A");
  t.git("commit", "-m", "feat: stage merge target product");
  t.git("checkout", "main");
  t.git("merge", "--no-ff", "--no-commit", "feature/merge-target");
  t.write(
    "blueprint/build-plan.md",
    "# Build Plan\n\n- [x] 1. Greeting punctuation\n- [x] 2. Merge target\n"
  );
  t.write("blueprint/history/features/02-merge-target.md", MERGE_FEATURE_ARCHIVE);
  t.git("add", "-A");
  t.git("commit", "-m", "feat: add merge target");
  const mergeTarget = t.git("rev-parse", "HEAD");
  const mergeHeadBefore = t.git("rev-parse", "HEAD");
  const mergeParents = t.git("show", "-s", "--format=%P", mergeTarget).split(" ").filter(Boolean);
  const plannedMerge = t.agent(
    "Run /rollback 2 because the merge target breaks a downstream consumer. Plan it and stop for review."
  );
  const mergeSpec = t.read("blueprint/context/current-feature.md") || "";

  t.check("merge target fixture has two parents", mergeParents.length === 2);
  t.check("merge target planning invocation succeeded", plannedMerge.status === 0);
  t.check("merge target planning creates no rollback commit", t.git("rev-parse", "HEAD") === mergeHeadBefore);
  t.check(
    "merge target planning writes a rollback spec",
    /^\*\*Type:\*\*\s*Rollback\s*$/im.test(mergeSpec)
  );
  t.check(
    "merge target spec records the exact commit",
    mergeSpec.includes(mergeTarget)
  );

  t.phase("implementation stops before reversing a merge target");
  const implementation = t.agent(
    "Run /implement for the current rollback spec. Stop if any rollback safeguard blocks the reverse patch; do not work around it."
  );

  t.check("merge target implementation invocation succeeded", implementation.status === 0);
  t.check("merge target implementation creates no rollback commit", t.git("rev-parse", "HEAD") === mergeHeadBefore);
  t.check(
    "merge target implementation leaves the product code unchanged",
    (t.read("src/merge-greeting.js") ?? "").includes("Hello from the merge target")
  );
  t.check(
    "merge target implementation stages no reverse patch",
    t.git("diff", "--cached", "--name-only").trim() === ""
  );
  t.check(
    "implementation names the merge-parent blocker",
    /merge target|merge commit|exactly one parent|single parent/i.test(implementation.resultText)
  );
}

export default {
  name: "rollback-plan",
  description: "Rollback preserves history and product code while preparing a guarded spec",
  run
};
