---
id: 261124-114633
title: Open the PR when the work is done and let CI judge; the local preopen check is optional
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Dorian, Nov 24: heavy local checks are no longer a step before opening a PR. The shared local
load gate (/tmp/dorkos-load-gate-501, one heavy slot) had 37 jobs queued and agents waited hours
for `pnpm verify:preopen`. Nothing enforced it (scripts/open-pr.sh never reads a proof); the PR's
cloud CI runs the same typecheck, lint and tests in parallel, and auto-merge waits for every
required check, so a red PR never merges.

Guidance only (AGENTS.md, the creating-pull-requests skill, contributing/ci.md, CONTRIBUTING.md,
.claude/rules/testing.md, .claude/README.md, lefthook.yml comment, the dev-setup doc, the PR
template): when the work is done, open the PR with open-pr.sh and let CI judge. Locally only the
pre-commit and pre-push hooks run; `pnpm verify:preopen` and `pnpm verify` are optional, for
debugging. A PR touching `.github/` needs no local full verify either. No gate or script changes.

Expect: the heavy-slot queue drains and time from "work done" to PR open drops from hours to
minutes. Evaluate: Dec 1.

Revert if the PR-run failure rate of required checks rises enough that CI minutes or queue
ejections cost more than the local runs saved.
