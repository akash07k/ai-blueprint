# Project Plan

## 1. Problem - What problem are we solving?

AI Blueprint gives developers a durable, file-backed workflow for planning and
shipping changes with Codex, Claude Code, and GitHub Copilot. It packages the
workflow documents, adapter skills, and lifecycle commands so project setup and
updates are consistent without requiring a hosted service.

## 2. Users - Who is this for?

Developers and teams who use Codex, Claude Code, or GitHub Copilot to build
software and want their workflow state, instructions, and agent adapters to
live in the repository.

## 3. Features - What does the project need?

- File-backed Markdown workflow for project planning, feature work, fixes,
  review, and completion.
- Bundled adapter skills for Codex, Claude Code, and GitHub Copilot.
- Installer, update, and status commands for creating and maintaining Blueprint
  projects.
- Package-synced generated adapter skills that are restored safely from a
  version-pinned bootstrap and lock contract instead of being committed.

## 4. Data - What are we storing?

- Markdown workflow state in `blueprint/`, including project plans, current work,
  generated overview, and completed-work history.
- Install metadata recording the installed Blueprint package version and adapter
  setup.
- Skill-lock metadata recording the version-pinned bootstrap and generated
  adapter-skill content needed for safe restoration.

## 5. Tech - What stack are we using?

- Node.js 22 or later.
- TypeScript.
- npm package tooling.
- GitHub Actions trusted publishing.

## 6. Monetize - How will this make money?

Monetization is out of scope.

## 7. UI/UX - How should this look and feel?

The interface is CLI commands plus repository Markdown. Commands should be
clear, safe, and concise; workflow state must remain readable and reviewable in
version control.

## 8. Deployment - Where and how will this ship?

Distribute the public scoped npm package
`@akash07k/create-ai-blueprint`. Publish releases through GitHub Actions trusted
publishing. No hosted application, database, worker, cron job, or web UI is
planned.
