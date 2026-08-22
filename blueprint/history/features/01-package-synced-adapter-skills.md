# Feature: Package-synced adapter skills

**From build-plan:** feature 1
**Status:** not started

## Goal

Let consuming application repositories keep generated Blueprint adapter skills out
of version control while retaining safe, offline-capable recovery through a
version-pinned `blueprint sync` command. The Blueprint package remains the
canonical source of skills; application repositories retain only the manifest
lock, user-owned workflow state, and any custom skills.

## In scope

- Evolve `blueprint/.state/manifest.json` from schema 1 to schema 2 as the sole
  package and skill lock.
- Record `packageName` as `@akash07k/create-ai-blueprint`, the exact installed
  `version`, selected `adapters`, and SHA-256 `managedFiles` hashes in that
  manifest.
- Safely migrate schema-1 manifests only during an explicit managed `update` or
  `sync` flow; leave legacy installs usable and preserve all user-managed files.
- Add an idempotent, clearly delimited `.gitignore` block containing only
  Blueprint-owned generated skill directories under `.agents/skills/` and
  `.claude/skills/`. Do not ignore either parent directory or custom skills.
- Add package and global `sync` commands that restore generated adapter skills
  only when the running package name, exact version, and bundled template hashes
  match the manifest lock.
- Keep `npx @akash07k/create-ai-blueprint@latest update` as the sole upgrade
  path. It advances the manifest version and hashes while updating all
  Blueprint-managed content under the existing conflict-safety contract.
- Reuse the existing update plan, SHA-256 hashing, safe-path and symlink checks,
  staging, atomic writes, conflict handling, `--force` backups, and `--dry-run`
  behavior for sync.
- Surface missing, modified, legacy, and package-version-mismatched generated
  skills in human status and status warnings without changing the status JSON
  schema version.
- Document installation, update, sync recovery, status behavior, and the
  generated-versus-custom skill boundary.

## Out of scope

- Changing the canonical `.agents/skills` or `.claude/skills` tracked in the AI
  Blueprint source repository.
- Committing generated consumer adapter skills.
- Managing all `.agents` or `.claude` content, custom skill directories, root
  `AGENTS.md`, root `CLAUDE.md`, plans, context, history, references, or
  prototypes.
- Adding a second lockfile, a hosted registry, network download logic, npm
  settings changes, publishing, or live-agent end-to-end tests.
- Adding a `blueprint upgrade` command or allowing global `blueprint update`.
- Changing the public status JSON schema version solely for skill diagnostics.

## Build loop

Build one step at a time, never the whole feature at once.

1. Plan mode lays out the step before any code.
2. The AI implements just that step.
3. It shows the diff, not full files; the user reads and understands it.
4. The user approves, then chooses whether to commit a checkpoint or continue.
   Checkpoints are optional; `/complete` makes the feature-level commit.

Never accept a step that has not been read. If a diff is too large to review, the
step must be split.

## Build steps

- [x] **Step 1 - Define manifest v2 and safe migration** - evolve the update
  manifest contract so schema 2 adds the fixed scoped `packageName` while
  retaining the exact `version`, adapters, and per-file SHA-256 hashes. Read
  schema-1 manifests as legacy lock records. A managed update may migrate a v1
  baseline while advancing to the running package version; sync may migrate it
  only when that version exactly matches the lock. In both flows, validate the
  applicable template and target hashes before writing, and reject malformed,
  unsupported, or identity-mismatched locks without writes. *Done when:* new
  installs and managed updates emit a valid schema-2 manifest; matching v1
  update and sync cases migrate without losing adapter or hash data; incompatible
  and invalid manifests leave project files unchanged.

- [x] **Step 2 - Manage the narrow generated-skill ignore block** - add a
  marker-based `.gitignore` writer to the install and update flow. Generate
  sorted entries only for Blueprint-owned skill directories represented by the
  manifest, preserve surrounding user rules exactly, replace an existing marker
  block atomically, and leave custom sibling skills trackable. *Done when:* a
  fresh install and managed update create one idempotent marker block; rerunning
  does not duplicate it; custom `.agents` and `.claude` content remains outside
  the block and is not ignored.

- [x] **Step 3 - Prepare and apply package-matched skill sync plans** - extract
  a skills-only plan from the existing update machinery. It may add missing
  generated skills, leaves matching skills unchanged, detects modified, legacy,
  non-regular, and symlinked paths as conflicts, and never removes or changes
  non-skill workflow files. Validate the running package name, exact version,
  adapters, and bundled-template hashes against the manifest before planning
  writes. Sync never fetches or advances package versions; it restores only from
  a matching locally installed or extracted package, or from an explicit
  version-pinned npx invocation. On mismatch, make no changes and print
  `npx @akash07k/create-ai-blueprint@<locked-version> sync`; on a matching
  package, preserve dry-run output, conflict refusal, force backups, staging,
  atomic replacement, and rollback behavior. *Done when:* matching-package sync
  restores missing generated skills, leaves unmodified files intact, refuses
  local modifications without `--force`, backs them up with `--force`, and makes
  no write when package validation fails.

- [x] **Step 4 - Route `sync` through package and global CLIs** - add `sync` to
  argument parsing, help, validation, output, and command routing for both
  `npx @akash07k/create-ai-blueprint` and the global `blueprint` executable.
  Permit only the flags needed by the existing managed-update contract, and
  extend the global command's current status-only allowlist to include sync,
  while continuing to reject global install and update and without adding a
  global upgrade command. Package `update` remains the only version-advancing
  command. *Done when:* both command surfaces parse `sync`, `--dry-run`,
  `--force`, and `--target` consistently; unsupported flag combinations fail
  before filesystem work; a package mismatch prints the exact version-pinned
  recovery command and exits without changing the target; global update and
  upgrade commands remain rejected.

- [x] **Step 5 - Report skill health from status** - inspect the manifest and
  generated skill paths read-only, then add stable human-readable warnings for
  missing, modified, legacy, and running-package-version-mismatched skills.
  Recommend `blueprint sync` when the current package matches the lock and the
  exact version-pinned npx command when it does not. Keep existing JSON field
  shapes and `schemaVersion` unchanged. *Done when:* status adds the appropriate
  warning and recovery guidance for each skill state, does not write files, and
  existing status consumers receive the same schema version and existing fields.

- [x] **Step 6 - Cover the contract and publishable package surface** - add
  focused unit tests and fixtures for CLI parsing and routing, schema-1
  migration, lock validation, ignore-block idempotence, custom-skill
  preservation, missing and modified skills, package mismatches, dry-run,
  force-backup behavior, and status warnings. Update package and repository
  documentation, then run the package build, test suite, package smoke check,
  and relevant documentation checks without live-agent E2E. *Done when:* all
  named behaviors have focused coverage; package build, tests, and
  `npm pack --dry-run` succeed; documented commands and recovery guarantees match
  the CLI.

## Files / areas

- `packages/create-ai-blueprint/lib/update.ts` - manifest v2, schema-1
  compatibility, scoped ignore-block writing, and reusable skills-only sync
  preparation and application.
- `packages/create-ai-blueprint/bin/create-ai-blueprint.ts` - package and global
  command parsing, routing, help, validation, recovery output, and sync
  presentation.
- `packages/create-ai-blueprint/lib/project-metadata.ts` and
  `packages/create-ai-blueprint/lib/status.ts` - read-only skill-health
  inspection and status warnings.
- `packages/create-ai-blueprint/scripts/prepare-template.ts` - retain canonical
  source adapter skills in the bundled package template.
- `packages/create-ai-blueprint/test/update.test.ts` and
  `packages/create-ai-blueprint/test/status.test.ts` - update, sync, migration,
  ignore, and status fixtures.
- `packages/create-ai-blueprint/README.md` and `README.md` - package command and
  recovery documentation.

## Data / contracts

- **Manifest v2 is load-bearing.** `blueprint/.state/manifest.json` is the only
  version-pinned package and generated-skill lock. It contains:
  - `schemaVersion: 2`
  - `packageName: "@akash07k/create-ai-blueprint"`
  - `version`: exact package version, not a tag or range
  - `adapters`: unique selected adapter identifiers
  - `managedFiles`: normalized Blueprint-owned relative paths mapped to lowercase
    64-character SHA-256 hashes
- A schema-1 manifest uses the existing `version`, `adapters`, and
  `managedFiles` fields. A managed update may migrate it while advancing package
  versions; sync may migrate it only at the locked version. Migration adds the
  fixed package name and schema version only after the applicable template and
  target validation, and it never invents a baseline for modified legacy files.
- The `.gitignore` block has stable begin and end markers owned by Blueprint.
  Its entries are sorted generated skill directory paths only. The writer must
  preserve all content outside the markers and reject unsafe paths.
- Sync source validation compares the manifest lock to the running package
  identity, exact version, selected adapter set, and canonical bundled-template
  hashes. Target-file differences are then handled as missing files, unchanged
  files, or conflicts; a target mismatch alone is not a package mismatch.
- Sync never fetches or advances versions. It restores only the
  manifest-pinned package version when that package is already available locally
  or is invoked explicitly through the version-pinned npx command.
- `npx @akash07k/create-ai-blueprint@latest update` is the sole upgrade path. It
  intentionally updates all Blueprint-managed content, including generated
  skills, and advances the manifest version and hashes subject to the existing
  conflict, backup, staging, and rollback safeguards.
- `sync` may write only generated skill paths, the manifest when safely migrating,
  and the Blueprint-owned `.gitignore` marker block. It must not modify other
  workflow or user-owned files.

## Testing

- Use the existing Node test runner through
  `npm test` in `packages/create-ai-blueprint`.
- Add exact parsing and routing tests for package and global `sync`, including
  allowed and rejected flag combinations.
- Add manifest fixtures for valid v2, safely migratable v1, malformed,
  unsupported, and package-version-mismatched locks.
- Test marked `.gitignore` block creation and replacement, idempotence, sorted
  entries, preservation of unrelated rules, and preservation of custom
  `.agents` and `.claude` skills.
- Test sync's missing, unchanged, modified, legacy, symlink, and version/hash
  mismatch behavior, including no-write guarantees, `--dry-run`, and
  force-backup/rollback behavior.
- Test that sync never advances the locked version, package update advances it
  while updating all managed content under normal conflict safety, and global
  `blueprint update` or `blueprint upgrade` remains rejected.
- Test read-only status warnings and recovery commands for missing, modified,
  legacy, and mismatched skills while asserting the existing status JSON schema
  version and fields.
- Run `npm run build`, `npm test`, and `npm run check:pack` in
  `packages/create-ai-blueprint`. Do not run live-agent E2E.
- Verify the repository and package README command examples against the parser.

## Notes for the AI

- This feature applies to consuming application repositories only. The Blueprint
  source repository continues to track canonical skills, and
  `prepare-template.ts` continues to bundle them.
- Preserve the existing safe-path validation, symlink defenses, staging,
  atomic-write, hash, conflict, dry-run, and force-backup behavior. Extend these
  primitives rather than creating parallel file-mutation logic.
- Keep package distribution offline-capable: matching globally installed or
  extracted package files may run sync without network access. Sync must never
  fetch or advance versions. When the local package does not match the lock, do
  not guess or fetch; print the exact pinned npx recovery command.
- Treat `npx @akash07k/create-ai-blueprint@latest update` as the only upgrade
  path. It updates all Blueprint-managed files, including generated skills, and
  advances manifest metadata only through the established safety checks. Do not
  add `blueprint upgrade`, and keep global `blueprint update` rejected.
- Migration must be explicit through managed update or sync. A status command
  only reports state and never upgrades, writes ignore rules, or restores files.
