---
id: 261124-025336
title: The daily release commit tool and its repo-wide suites
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Row 4 of the daily-release design (DOR-5123): `scripts/release/release-commit.ts` builds the
release commit from P's fragments with no person, as a dry run only. No workflow runs it yet;
ci-steward's `daily-release.yml` will, and `commitViaGitData` stays unwired until go-live.

Its three suites import `packages/cli/scripts/release-branch/rules.ts`, the rule behind
`release-branch-contents`, so they go on `REPO_WIDE_SUITES` in `scripts/vitest.repo.config.ts`
(a change to the rule can turn them red from outside `scripts/`). `scripts/tsconfig.json` now
typechecks `scripts/release`, which pulls in `rules.ts` under `noUncheckedIndexedAccess`, so
`rules.ts` gains one `source !== undefined` guard that cannot change a verdict (a single pick
is always a string). No gate's retries, shards,
timeout or required status changes, and no metric should move, so this is hygiene. Revert the
list entries if they make `typecheck` slow or flaky; each suite runs in about a second.
