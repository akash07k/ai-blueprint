# @akash07k/create-ai-blueprint

Install AI Blueprint into an already scaffolded app.

[![npm version](https://img.shields.io/npm/v/%40akash07k%2Fcreate-ai-blueprint?style=flat-square&color=155eef)](https://www.npmjs.com/package/%40akash07k%2Fcreate-ai-blueprint)
[![Validate Blueprint](https://github.com/akash07k/ai-blueprint/actions/workflows/validate.yml/badge.svg)](https://github.com/akash07k/ai-blueprint/actions/workflows/validate.yml)
[![MIT license](https://img.shields.io/npm/l/%40akash07k%2Fcreate-ai-blueprint?style=flat-square&color=155eef)](LICENSE)

[Repository](https://github.com/akash07k/ai-blueprint) |
[Documentation](https://github.com/akash07k/ai-blueprint#readme) |
[Changelog](https://github.com/akash07k/ai-blueprint/blob/main/CHANGELOG.md)

Requires Node.js 22 or newer. Run the installer from an application that has
already been scaffolded and initialized as a Git repository.

```bash
npx @akash07k/create-ai-blueprint@latest
```

You can also use npm's initializer form:

```bash
npm create @akash07k/ai-blueprint@latest
```

GitHub Copilot CLI is the default installer and workflow adapter. Omitted,
`--yes`, and non-interactive installs copy these files into the current directory:

- `AGENTS.md`
- `blueprint/.state/manifest.json`
- `.agents/`
- `blueprint/`

It keeps the app's root `README.md` alone and installs the Blueprint workflow
docs at `blueprint/README.md`. It does not create or manage
`.github/copilot-instructions.md`.

The installed workflow includes optional Render and Vercel deployment readiness
through `/release` or `$release`; it prepares local config and checks, but does
not deploy without explicit approval.

The optional `/ci` or `$ci` skill sets up automatic GitHub checks separately
from onboarding and adoption. It detects the real project commands, defines one
Verify command from checks that already exist, and adds a matching pull request
workflow without replacing existing CI. It does not invent tests or add git
hooks, coverage, browser tests, security scans, or version matrices by default.

It also includes `/rollback` or `$rollback` for planning a reviewed reversal of
a completed feature from its archived spec and exact git commit. Rollbacks keep
the original feature archive and use the normal implement, check, and complete
gates.

If you install `--claude` or `--all` while Claude Code is already open in the
project, restart Claude Code in that folder so the newly added project skills
appear.

## Tool support

| Tool | Installed adapter | Invocation |
| --- | --- | --- |
| GitHub Copilot CLI | `AGENTS.md` and `.agents/skills/` | Ask naturally, for example "run the feature skill" |
| Codex | `.agents/skills/` | `$feature`, `$implement`, or plain language |
| Claude Code | `.claude/skills/` | `/feature`, `/implement`, and other slash commands |
| Other tools | `AGENTS.md` plus readable skill files | Ask the agent to follow the matching `SKILL.md` |

## Options

```bash
npx @akash07k/create-ai-blueprint@latest -- --copilot
npx @akash07k/create-ai-blueprint@latest -- --codex
npx @akash07k/create-ai-blueprint@latest -- --claude
npx @akash07k/create-ai-blueprint@latest -- --all
npx @akash07k/create-ai-blueprint@latest -- --both
npx @akash07k/create-ai-blueprint@latest -- --force
npx @akash07k/create-ai-blueprint@latest -- --target ./my-app
```

The same flags work with `npm create @akash07k/ai-blueprint@latest -- ...`.
`--all` installs every adapter. `--both` is a warning-emitting deprecated alias
for `--all`.

The installer defaults to GitHub Copilot. `--both` remains as a deprecated alias
for `--all` and prints a warning. GitHub Copilot uses `AGENTS.md` and the shared
`.agents/skills/` files; the installer does not manage
`.github/copilot-instructions.md`.

Use `--force` to overwrite existing Blueprint files. Without `--force`, the
installer asks before overwriting in an interactive terminal and exits in
non-interactive runs.

## Updating an existing installation

Preview the update plan:

```bash
npx @akash07k/create-ai-blueprint@latest update --dry-run
```

Apply the update:

```bash
npx @akash07k/create-ai-blueprint@latest update
```

The updater reads the installed manifest as the authoritative adapter record.
Manifest-backed Codex and Claude Code installs retain exactly those adapters.
Manifest-less `.agents/skills/` installations use legacy Codex inference. The
updater manages only these paths:

- `.agents/skills/`
- `.claude/skills/`
- `blueprint/README.md`

It preserves `AGENTS.md`, `CLAUDE.md`, project and build plans, context, history,
references, and prototypes. The `blueprint/.state/manifest.json` file records the
installed version and hashes of managed files.

Locally modified managed files are reported as conflicts. Interactive updates
ask before replacing them. Non-interactive updates exit unless you pass
`--force`, which backs up the conflicting files before replacement. Backups are
stored under `blueprint/.state/backups/` and ignored by git.

The first update of a legacy install creates the manifest. Files that already
match the current package are adopted automatically. Differing files remain
conflicts so local changes are not lost.

## Restoring generated adapter skills

New installs and managed updates write `blueprint/.state/manifest.json` as the
single Blueprint lock. Schema 2 records the scoped package name, exact package
version, selected adapters, and SHA-256 hashes for Blueprint-owned files.

Generated adapter skills under `.agents/skills/` and `.claude/skills/` are
recovered from the bundled package template, not committed by consuming
applications. Blueprint adds a marked root `.gitignore` block that ignores only
its generated skill directories. It does not ignore `.agents`, `.claude`, or
custom sibling skills, so custom skills remain trackable.

The marker block ignores newly generated skills, but it cannot untrack paths
already committed to Git. Review its managed entries, then remove only those
individual generated paths from Git's index while leaving the files and custom
sibling skills intact:

```bash
git rm -r --cached -- .agents/skills/<generated-skill>
```

Preview a skills-only recovery without writing:

```bash
npx @akash07k/create-ai-blueprint@<locked-version> sync --dry-run
```

Run `sync` with the exact version in `blueprint/.state/manifest.json`:

```bash
npx @akash07k/create-ai-blueprint@<locked-version> sync
```

It restores missing generated skills, leaves matching files untouched, and
refuses locally modified generated skills unless you pass `--force`. Force backs
up conflicting skills before replacement. Sync never fetches or advances a
package version, and it never changes non-skill workflow files.

Sync checks generated-skill paths for symbolic links, non-directory parents, and
target changes at validation and write checkpoints. Node 22 does not provide
directory-handle-relative no-follow mutations, so sync assumes no untrusted
concurrent process replaces a file or directory after its final safety check.

If the running package version differs from the manifest, sync writes nothing
and prints the exact version-pinned recovery command. Run the printed command,
for example:

```bash
npx @akash07k/create-ai-blueprint@0.10.0 sync
```

Use `npx @akash07k/create-ai-blueprint@latest update` as the only upgrade path.
It intentionally updates all Blueprint-managed content, including generated
skills, and advances the lock after its normal conflict checks.

## Checking project status

Run the read-only status command from a Blueprint project or any directory
inside it:

```bash
npx @akash07k/create-ai-blueprint@latest status
```

It reports build-plan progress, active work, findings, Git state, drift
warnings, generated-skill health, completion blockers, and one suggested next
action. It warns about missing, modified, legacy, or version-mismatched generated
skills with the appropriate sync recovery command. For scripts and integrations,
request the versioned JSON object:

```bash
npx @akash07k/create-ai-blueprint@latest status --json
```

After an interactive Blueprint install, the installer offers to run the
following optional global installation command:

```bash
npm install --global @akash07k/create-ai-blueprint@latest
```

The prompt defaults to no and is skipped for non-interactive and `--yes` runs.
Global installation exposes the shorter forms `blueprint status`,
`blueprint status --json`, and `blueprint sync`. Use `--target ./my-app` to
inspect or recover an explicit project directory. Status never edits project or
Git state.

The optional global `blueprint` command supports only status and sync. It rejects
install, update, and upgrade commands. Continue to use
`npx @akash07k/create-ai-blueprint@latest` for installation and
`npx @akash07k/create-ai-blueprint@latest update` for the only managed upgrade
path.

## Help and contributing

- Read the [full documentation](https://github.com/akash07k/ai-blueprint#readme).
- Report reproducible problems through the repository's
  [issue forms](https://github.com/akash07k/ai-blueprint/issues/new/choose).
- Follow the repository's
  [security policy](https://github.com/akash07k/ai-blueprint/security/policy)
  for private vulnerability reports.
- Read the
  [contribution guide](https://github.com/akash07k/ai-blueprint/blob/main/CONTRIBUTING.md)
  before opening a pull request.

## License

MIT
