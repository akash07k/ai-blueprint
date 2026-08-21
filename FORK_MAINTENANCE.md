# Maintained Fork Playbook

This document defines a repeatable workflow for maintaining a personal fork
while regularly consuming upstream changes and contributing selected work back
upstream.

It is fork-only documentation. Do not include this file in an upstream pull
request or in an installer template.

## Goals

1. Keep private product, branding, publishing, and workflow changes.
2. Rebase private work onto current upstream releases.
3. Create upstream pull requests without fork-only commits.
4. Preserve a clear history of why each downstream change exists.
5. Make conflicts explicit, recoverable, and less repetitive.

## Branch Roles

1. `upstream/main`

   The authoritative upstream baseline. Treat it as read-only. Fetch changes
   from it, but never push directly to it.

2. `main` and `origin/main`

   The clean private integration branch and its private remote counterpart. They
   contain the current upstream baseline plus the small, ordered set of changes
   this fork keeps regardless of whether upstream accepts them. `main` never
   contains an upstream pull request that is still under review.

3. `fork/with-<topic>`

   A temporary local integration overlay. It starts at `main`, then
   replays a pending upstream pull request that private work needs before that
   pull request is resolved. It is not the pull request source branch.

4. `personal/<topic>`

   A private feature branch based on `main`, or on a documented
   `fork/with-<topic>` overlay when it needs pending upstream work.

5. `contrib/<topic>`

   An upstream contribution branch based directly on `upstream/main`. It must
   contain only commits that are appropriate to propose upstream.

Do not use `main` or `fork/with-<topic>` as the source of an upstream pull
request. Do not assume `origin/main` is an exact mirror of upstream. The
canonical upstream reference is always `upstream/main`.

## PowerShell Command Safety

Run this helper once in each PowerShell session before following the procedures
below. It stops the procedure if a regular Git command fails.

```powershell
function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)

  & git @GitArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Git command failed: git $($GitArgs -join ' ')"
  }
}
```

The contribution preflight uses `git merge-base --is-ancestor` directly because
an exit code of `1` is the expected result when no ancestry exists.

## Remote Safety

Configure the upstream remote as fetch-only:

```powershell
Invoke-Git remote set-url --push upstream DISABLED
```

Verify every configured upstream push URL:

```powershell
Invoke-Git config --get-all remote.upstream.pushurl
```

The output must contain only `DISABLED`. Reconfigure the remote before
proceeding if it lists any other value.

Enable Git's recorded resolution reuse:

```powershell
Invoke-Git config rerere.enabled true
```

`rerere` records the resolution for a conflict. When a substantially identical
conflict occurs in a later rebase, Git can reuse that resolution.

## Initial Setup for a New Fork

Use this workflow after creating a personal fork and adding the canonical
project as `upstream`.

```powershell
Invoke-Git fetch origin --prune
Invoke-Git fetch upstream --prune
Invoke-Git remote set-url --push upstream DISABLED
Invoke-Git config rerere.enabled true
Invoke-Git switch main
Invoke-Git rebase upstream/main
Invoke-Git push --force-with-lease origin main
```

In another clone, switch deliberately to the private integration branch instead
of the fork's default branch:

```powershell
Invoke-Git fetch origin --prune
Invoke-Git switch --track origin/main
```

If an upstream pull request is already open and private work needs it before it
is resolved, create a temporary overlay without changing the pull request source
branch:

```powershell
Invoke-Git tag -a fork/pending-topic-base origin/contrib/pending-topic -m "Pin pending upstream pull request source"
Invoke-Git switch -c fork/with-pending-topic main
Invoke-Git cherry-pick -x "upstream/main..origin/contrib/pending-topic"
```

The tag records the exact pull request source used to build the overlay. Do not
move it. The overlay has its own commit IDs, so rebasing or rebuilding it never
changes the pull request source branch.

The overlay is local by default. If it must be available in another clone,
publish the source tag and the overlay deliberately:

```powershell
Invoke-Git push origin fork/pending-topic-base
Invoke-Git push -u origin fork/with-pending-topic
```

## Adding a Private Change

Create a focused private branch from `main` by default:

```powershell
Invoke-Git switch main
Invoke-Git switch -c personal/scoped-package
```

When a private change needs a pending upstream pull request, start it from the
matching overlay instead:

```powershell
Invoke-Git switch fork/with-pending-topic
Invoke-Git switch -c personal/uses-pending-topic
```

Record which base a personal branch uses. A branch based on an overlay must be
migrated when that overlay is refreshed or retired.

Keep each private concern in a separate commit. For example:

```text
chore(fork): publish the scoped package
docs(fork): reference the scoped package
test(fork): exercise the scoped package
```

After review, integrate the branch into the base it began from. This example
uses `main`:

```powershell
Invoke-Git switch personal/scoped-package
Invoke-Git rebase main
Invoke-Git switch main
Invoke-Git merge --ff-only personal/scoped-package
Invoke-Git push origin main
```

Small, isolated commits make rebases easier and let an upstream-worthy commit
be promoted later without dragging along unrelated private work.

If `main` was rewritten by an upstream rebase while the personal branch
was active, use the migration procedure below instead of the ordinary rebase.

## Extracting a Pending Pull Request from an Existing Private Baseline

Use this one-time procedure only when an existing `main` was started from
a pending pull request and all private commits are descendants of that pull
request's pinned source tag. Commit or otherwise remove working-tree changes
before starting.

```powershell
Invoke-Git branch backup/main-before-pending-extraction main
Invoke-Git switch main
Invoke-Git rebase --onto upstream/main fork/pending-topic-base
Invoke-Git switch -c fork/with-pending-topic main
Invoke-Git cherry-pick -x "upstream/main..fork/pending-topic-base"
```

The rebase moves only the private descendants of the pinned pull request onto
`upstream/main`. The cherry-pick creates a separate local copy of the pending
pull request on the overlay. It does not alter the upstream pull request source
branch.

## Updating from Upstream

Before rebasing, ensure the private integration branch is clean:

```powershell
Invoke-Git status
Invoke-Git fetch upstream --prune
Invoke-Git switch main
$stamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
$backupBranch = "backup/main-before-sync-$stamp"
Invoke-Git branch $backupBranch
Invoke-Git rebase upstream/main
```

If the rebase succeeds, update the private remote branch:

```powershell
Invoke-Git push --force-with-lease origin main
```

Rebasing rewrites the private commit IDs. `--force-with-lease` protects against
overwriting a remote update that is not present locally.

Keep the dated backup branch until every active `personal/*` branch has been
migrated onto the rewritten `main`.

## Refreshing a Pending Integration Overlay

After rebasing `main`, refresh each overlay that still needs its pending
pull request. The backup branch from the prior section identifies the overlay's
old base:

```powershell
$mainBackup = "backup/main-before-sync-YYYY-MM-DD-HHMMSS"
$oldOverlayBase = Invoke-Git merge-base fork/with-pending-topic $mainBackup
$overlayBackup = "backup/fork-with-pending-topic-before-sync"
Invoke-Git branch $overlayBackup fork/with-pending-topic
Invoke-Git switch fork/with-pending-topic
Invoke-Git rebase --onto main $oldOverlayBase
Invoke-Git switch main
```

This replays only the overlay's copied pull request commits onto the rewritten
`main`. It does not alter the upstream pull request source branch. Migrate
any personal branches based on the overlay using the next procedure.

## Migrating Dependent Branches After a Base Rebase

A rewritten `main` or `fork/with-<topic>` changes commit IDs. Each active
`personal/*` branch based on that branch must be moved before it can
fast-forward back into its intended base.

For each active personal branch, use a backup branch for its former base:

```powershell
$newBase = "main"
$backupBase = "backup/main-before-sync-YYYY-MM-DD-HHMMSS"
$oldBase = Invoke-Git merge-base personal/scoped-package $backupBase
Invoke-Git switch personal/scoped-package
Invoke-Git rebase --onto $newBase $oldBase
```

For an overlay-dependent branch, set `$newBase` to
`fork/with-pending-topic` and `$backupBase` to that overlay's backup branch.
Repeat this for each active `personal/*` branch. Then use the normal
fast-forward integration procedure. If the base only advanced without a history
rewrite, `Invoke-Git rebase <base>` is sufficient.

## Resolving a Rebase Conflict

A conflict occurs only when Git cannot safely combine the upstream and private
changes. Editing the same file is not enough by itself. The changes usually
need to overlap in the same lines or behavior.

1. Read the conflict and determine the intended combined behavior.
2. Edit the file to retain the appropriate upstream and private behavior.
3. Stage the resolved file.

   ```powershell
   Invoke-Git add path\to\file
   Invoke-Git rebase --continue
   ```

4. Repeat until the rebase finishes.
5. Run the relevant project checks before pushing the rebased branch.

If the chosen result is unclear, abort without losing either side:

```powershell
Invoke-Git rebase --abort
```

Do not resolve a conflict by automatically preferring "ours" or "theirs"
without checking the behavior. A conflict is a decision point, not a failure.

## Contributing a Private Change Upstream

When a private commit becomes upstream-worthy, create a clean contribution
branch from `upstream/main` and cherry-pick only that commit:

```powershell
Invoke-Git fetch upstream --prune
Invoke-Git switch -c contrib/accessible-output-guidance upstream/main
Invoke-Git cherry-pick -x <private-commit-sha>
Invoke-Git push -u origin contrib/accessible-output-guidance
```

The `-x` records the original private commit in the new commit message. The
resulting pull request contains no fork-only publishing, branding, or policy
commits.

Never branch `contrib/<topic>` from `main`. That would make the upstream
pull request include the private patch stack.

Before opening an upstream pull request, run this preflight from the
`contrib/<topic>` branch:

```powershell
$branch = Invoke-Git branch --show-current
if ($branch -notmatch '^contrib/') {
  throw "Create upstream pull requests only from a contrib/<topic> branch."
}

$integrationBranches = @("main")
$integrationBranches += Invoke-Git for-each-ref --format="%(refname:short)" "refs/heads/fork/with-*"
$integrationBranches = $integrationBranches | Where-Object { $_ }

foreach ($integrationBranch in $integrationBranches) {
  $nonUpstreamCommits = Invoke-Git rev-list "upstream/main..$integrationBranch"
  foreach ($commit in $nonUpstreamCommits) {
    & git merge-base --is-ancestor $commit HEAD
    if ($LASTEXITCODE -eq 0) {
      throw "This contribution branch contains integration history from $integrationBranch: $commit"
    }
    if ($LASTEXITCODE -ne 1) {
      throw "Could not verify contribution ancestry for: $commit"
    }
  }
}

Invoke-Git log --oneline upstream/main..HEAD
Invoke-Git diff --name-status upstream/main...HEAD
```

Review both outputs. They must show only the commits and files intended for the
upstream pull request.

## Handling a Pending Upstream Pull Request

When private work needs a pending upstream pull request:

1. Keep the pull request source branch unchanged for review.
2. Keep the immutable `fork/pending-topic-base` tag at the exact source tip.
3. Use `fork/with-pending-topic` only as a local copy of that pull request.
4. Base only dependent private work on the overlay.
5. Continue ordinary upstream rebases on `main`.
6. Do not open an upstream pull request from the overlay.

After the pull request is merged, first confirm that `upstream/main` contains
the intended behavior. Rebase `main` normally onto `upstream/main`. Then
migrate every private branch that depends on the overlay:

```powershell
$overlayBackup = "backup/fork-with-pending-topic-before-resolution"
Invoke-Git branch $overlayBackup fork/with-pending-topic
$newBase = "main"
$oldBase = Invoke-Git merge-base personal/uses-pending-topic $overlayBackup
Invoke-Git switch personal/uses-pending-topic
Invoke-Git rebase --onto $newBase $oldBase
```

This drops the overlay's copied pull request commits and replays only the
private descendants onto the equivalent behavior now in `main`. Keep the
overlay backup until every dependent branch has been migrated and verified.

If the upstream pull request closes without merging, decide whether the work
remains valuable to the fork.

1. Keep the work: retain the overlay and refresh it after future `main`
   rebases.
2. Drop the work: migrate only private branches that no longer need its code
   onto `main`. Resolve or keep branches that still depend on it.
3. Partially merged or materially changed work: stop and decide which behavior
   remains valuable before rebasing any dependent branch.

## Patch File Policy

Use `git format-patch` files as portable backups or for one-time bootstrap
imports. Once a patch has become a normal Git commit, maintain that commit with
Git branches and rebases rather than repeatedly applying the patch file.

This gives each change a stable purpose, review history, and conflict context.

## Current Repository Application

This fork currently uses the following mapping:

1. `feat/universal-copilot-adapters` is the source branch for upstream PR #4.
2. `main` is based on `upstream/main` and retains only this fork's private
   documentation and later private commits.
3. `fork/with-pr4` is a frozen historical local overlay that replayed PR #4's
   commits on top of `main`. It is not a development base.
4. `fork/pending-pr4-base` records PR #4's source tip `7bf1f4e`.
5. The source branch for PR #4 remains unchanged.
6. `main` includes the fork-only scoped package publishing release (`24eeaa3`),
   accessible output guidance (`8c651c8`), Copilot-first default (`9e54a73`),
   complete and rollback safeguards (`9501ccc`), and CI status-test fix
   (`97b7522`). These private changes are not part of upstream PR #4.

When reusing this playbook in another project, replace the branch names and
project-specific examples, but retain the branch separation and rebase rules.
