# Validation Guide

Run the smallest relevant checks while iterating. Escalate to the broad checks
when touching shared behavior, release automation, auth, persistence, or chat.

## Always Run For PRs

```bash
npm run harness:check
```

For broad or shared changes, also run:

```bash
npm run test:coverage
npm run test:e2e
npm run build
```

## Change-Type Matrix

| Change | Minimum local validation |
| --- | --- |
| Docs only | `npm run harness:check` |
| Client component/store/API | focused `npm run test -- <pattern>`, then `npm run build` |
| User-visible browser flow | focused Vitest plus `npm run test:e2e` |
| Server controller/service/db | focused `npm run test -- tests/server/<file>` |
| Auth, profile, or credential behavior | focused server tests plus relevant e2e auth tests |
| Chat, Socket.IO, group chat | focused server tests plus relevant e2e chat tests |
| Chat session chain, Agent Bridge, compression, or Group Chat | Add one `docs/chat-chain-changes/*.md` fragment with date, PR/commit, touched feature, and behavior impact; then run `npm run harness:check` plus focused chat/bridge/group-chat tests |
| GitHub workflow | `npm run harness:check` and `actionlint` when available |
| Package manifests | `npm ci --ignore-scripts` and lockfile workflow expectations |

## CI Mapping

- Build workflow: installs dependencies, runs coverage, and builds production
  assets on pushes and pull requests.
- Playwright workflow: runs browser e2e tests.
- NPM lockfile workflow: verifies `package-lock.json` is synchronized.
- Web UI release workflow: packages release artifacts on published releases.

## Release Workflow Guardrail

Published GitHub Releases should still trigger Web UI artifact packaging, and
the Web UI release workflow must keep the published GitHub Release out of
latest.

The Electron desktop distribution under `packages/desktop` is retained for
reference in the `feature/desktop-backup` branch; desktop builds are no
longer part of this repository's active development.

## Failure Handling

When a command fails:

1. Read the first actionable error, not just the final stack trace.
2. Check whether the failure indicates missing context, missing test coverage,
   or a missing mechanical rule.
3. Fix the product bug when there is one.
4. Update docs or `scripts/harness-check.mjs` when the same class of mistake
   should be prevented next time.
