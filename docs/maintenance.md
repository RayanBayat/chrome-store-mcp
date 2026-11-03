# Monthly maintenance review

This project wraps two things that change without warning: **Google's Chrome Web Store API** (new methods appear, old
ones are deprecated) and the **Model Context Protocol** (new protocol versions and features). Its dependencies also age.
This page is the checklist that keeps it current. It takes about 30 minutes when nothing big changed.

## When to do it

Do the review **before any other work** when one of these is true:

- the last review (`LAST_REVIEWED` in `src/maintenance.ts`) was more than 30 days ago;
- a tool result ends with "Maintenance review overdue" (the server adds it automatically after 30 days);
- the "Monthly maintenance review" issue was opened by the scheduled workflow (`.github/workflows/maintenance.yml`).

AI agents working in this repository must check the date first (see `AGENTS.md`).

## The checklist

### 1. Run the check

```
npm ci --ignore-scripts && npm run maintenance
```

It prints a report and exits with 1 when something needs attention. It covers: days since the last review, Google API
changes, outdated packages, vulnerabilities, and Node.js LTS lines.

### 2. Google API changes

The report compares Google's live API description with `maintenance/api-surface.json`.

| Report says        | What to do                                                                                                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NEW** method     | Add a tool for it (recipe in `CONTRIBUTING.md`: allowlist entry, tool, tests, docs). If it should not be a tool, add it to `NOT_EXPOSED` in `test/api-surface.test.ts` with the reason. A new write method must ask for confirmation unless it only changes a draft. |
| **REMOVED** method | Remove the tool, its allowlist entry, its tests and its docs. Note it in `CHANGELOG.md`.                                                                                                                                                                             |
| **CHANGED** method | Read what changed. A scope change is a security change: re-check `docs/security.md`.                                                                                                                                                                                 |

Also skim Google's docs for deprecations that the description does not show yet:
https://developer.chrome.com/docs/webstore/api and https://developer.chrome.com/docs/webstore/using-api

### 3. MCP changes

- Is `@modelcontextprotocol/sdk` outdated? (The report lists it.) Update it and read its release notes:
  https://github.com/modelcontextprotocol/typescript-sdk/releases
- Read the specification changelog: https://modelcontextprotocol.io/specification. Note new features worth using
  (for example new tool result types or changes to elicitation) as issues.

### 4. Dependencies

The rule: **every package is on its latest version**, unless there is a written reason not to.

1. For each package in the report: `npm install --save-exact <package>@latest` (add `--save-dev` for dev tools).
2. Run `npm run verify`. If an update breaks something you cannot fix now, roll it back and add the package to
   `maintenance/held-back.json` with the version you judged (`latestSeen`) and the reason. The check stays quiet about
   it until an even newer version appears.
3. Read every entry already in `maintenance/held-back.json` (including `overrides`). Remove the ones whose reason is gone.
4. `npm audit` must report 0 vulnerabilities. If a fix needs an `overrides` entry in `package.json`, record it in
   `held-back.json` too.

### 5. Node.js and GitHub Actions

- The report lists the supported Node.js LTS lines. Keep `node-version` in `.github/workflows/ci.yml` equal to them.
  When the oldest line reaches its end of life, raise `engines` in `package.json` and `@types/node` to the new oldest line.
- Dependabot opens pull requests for GitHub Actions. Actions stay pinned to a full commit SHA with the version in a comment.

### 6. Finish

1. `npm run verify` passes (lint, format, typecheck, tests, build).
2. If you changed a safety guard, show that its test fails when the guard is removed (see `CONTRIBUTING.md`).
3. `npm run maintenance -- --record`: saves today as `LAST_REVIEWED`, and Google's live API description as the new
   snapshot. Run `npm test` again: it fails if a new API method still has no tool.
4. Add a line to `CHANGELOG.md`, commit as `chore: maintenance review YYYY-MM-DD`, and close the maintenance issue.

## Current holds (2026-11-03)

These live in `maintenance/held-back.json`; this table is for reading.

| What                 | Held at | Latest | Why                                                                             |
| -------------------- | ------- | ------ | ------------------------------------------------------------------------------- |
| typescript           | 6.0.3   | 7.0.2  | typescript-eslint 8.72.1 supports TypeScript < 6.1.0                            |
| @types/node          | 22.20.5 | 26.6.6 | matches the oldest supported Node.js (22)                                       |
| minimatch (override) | 11.0.4  | 11.0.4 | ESLint and typescript-eslint still depend on minimatch 10 (GHSA-g3hv-75wg-m249) |
