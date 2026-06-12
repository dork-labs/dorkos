---
number: 41
title: Use Lefthook Pre-Commit Hook for Migration Enforcement
status: accepted
created: 2026-02-25
spec: db-drizzle-consolidation
superseded-by: null
---

# 41. Use Lefthook Pre-Commit Hook for Migration Enforcement

## Status

Accepted

## Context

Drizzle does not have a native `--check` or `--dry-run` mode (open issue #5059 as of Feb 2026). Without enforcement, a developer can change a TypeScript schema file and commit without running `drizzle-kit generate` — leaving the migration SQL file stale. At server startup the next day, `migrate()` applies nothing (since the migration file hasn't changed) and the schema is silently out of sync with the running database. This is a known reliability hazard in ORM-based projects.

## Decision

Install Lefthook as a dev dependency and configure a `pre-commit` hook that runs automatically when any file in `packages/db/src/schema/` is staged. The hook runs `drizzle-kit generate` and immediately stages the output (`git add packages/db/drizzle/`), so schema change and migration file are always committed together. `lefthook.yml` is committed to the repository. The root `package.json` includes a `prepare` script (`lefthook install`) so the hook is installed automatically for any developer running `npm install` or `pnpm install`.

## Consequences

### Positive

- Schema changes and migration files are always committed atomically — no stale migration risk
- Zero manual steps for developers — the hook generates and stages migrations automatically
- `lefthook.yml` in git means all team members get the hook on `pnpm install`, identical to Husky's distribution model
- No new CI step needed — enforcement happens at commit time before code reaches CI

### Negative

- Developers committing from an environment without Node.js/npx available (e.g., certain CI systems that commit directly) will need to skip the hook or install Node.js
- `drizzle-kit generate` takes a few seconds — adds latency to schema-change commits
- First-time setup requires `pnpm install` after the `prepare` script is added (existing checkouts need a one-time re-install)
