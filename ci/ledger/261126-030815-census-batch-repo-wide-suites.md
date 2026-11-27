---
id: 261126-030815
title: Five census tests join the repo-wide scripts suites (DOR-4940)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4940 turns five rules that lived only as prose into scripts census tests: every runtime folder runs `runtimeConformance`, every server test file is reached by the server vitest `include`, research files are named `YYYYMMDD_topic-slug.md`, the `os.homedir()` carve-out table in `.claude/rules/dork-home.md` equals the ESLint exemptions, and every `UserConfigSchema` leaf has a row in `contributing/configuration.md`. Each reads files outside `scripts/`, so each joins `REPO_WIDE_SUITES` in `scripts/vitest.repo.config.ts` and runs in the required `typecheck` job, on pull requests and in the merge queue. Each scan reads a folder or a schema and takes milliseconds (14 tests ran in under a second locally), so the step's time should not move. Nothing measurable should move.

Revert a suite if it turns red on a change that broke none of the five rules.
