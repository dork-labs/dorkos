---
id: 261126-045353
title: One vitest config for the scripts tests, with scripts and scripts-repo projects
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.typecheck.typecheck
  - wf.scripts-test.harness
prs: []
ratchet-release: []
field-changes: []
---

DOR-4951. Two vitest configs described how the `scripts/` tests run: `scripts/vitest.config.ts` (every suite) and
`scripts/vitest.repo.config.ts` (the suites that read the whole repo, which the required `typecheck` job runs). They
merge into `scripts/vitest.config.ts`, with two named projects: `scripts` (its top-level block, which the root
`vitest.config.ts` still registers by directory) and `scripts-repo`. `REPO_WIDE_SUITES` and `HERMETIC_SUITES` keep
their names and move to `scripts/repo-wide-suites.ts`, a git rename of the old file, so open PRs that add a line to
the list still merge cleanly. `scripts/sharding/config.ts` is not a scripts config: it wraps each package's own config
for the test shards, and stays.

Every caller now names a project: `typecheck.yml` and `verify:preopen` run `--project scripts-repo`;
`scripts-test / harness` and `pnpm test:scripts` run `--project scripts`.

Behavior does not change. Before and after, resolved through Vitest with `CI` set: `scripts` selects the same 99 files
and `scripts-repo` the same 59, identical lists, with the same environment, timeout, retry and pool, and `scripts-repo`
keeps two workers. The root project list still sees one `scripts` project of 99 files. Nothing measurable should move.
Revert if either job's file count changes.
