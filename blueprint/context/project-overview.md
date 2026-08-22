# AI Blueprint - Project Overview

> A file-backed AI-assisted development workflow distributed as an npm package.

## Problem

AI Blueprint gives developers using Codex, Claude Code, and GitHub Copilot a
consistent workflow that remains visible in their repositories. It bundles the
Markdown workflow, adapter skills, and lifecycle commands without requiring a
hosted service.

## Users

- Developers using Codex, Claude Code, or GitHub Copilot who want a repeatable,
  repository-owned workflow.
- Teams that need agent instructions and workflow state to be readable and
  reviewable in version control.

## Features

1. **Package-synced adapter skills** - applications use a version-pinned
   bootstrap and lock contract so `blueprint sync` can safely restore generated
   `.agents/skills` and `.claude/skills` rather than committing them.

## Data model

### Workflow state

- Markdown files in `blueprint/` for project plans, active work, generated
  project overview, and completed-work history.
- This state is the source of truth for the repository workflow.

### Install metadata

- `packageVersion` (string) - installed Blueprint package version.
- `adapters` (string array) - configured agent adapters.

### Skill lock metadata

- `bootstrapVersion` (string) - pinned Blueprint release used to restore skills.
- `adapters` (string array) - adapter skill directories covered by the lock.
- `fileHashes` (map of string to string) - expected generated skill content for
  safe restoration.
- Relates to install metadata through the installed package version.

## Tech stack

- **Node.js 22+** - runtime for the CLI.
- **TypeScript** - implementation language.
- **npm** - public package distribution.
- **GitHub Actions trusted publishing** - release publishing.

## Monetization

Out of scope.

## UI/UX

The interface is CLI commands plus repository Markdown. Commands must be clear,
safe, and concise; workflow state must remain readable and reviewable in version
control.

## Deployment

Distribute the public scoped npm package `@akash07k/create-ai-blueprint`.
Publish releases through GitHub Actions trusted publishing. No hosted
application, database, worker, cron job, or web UI is planned.
