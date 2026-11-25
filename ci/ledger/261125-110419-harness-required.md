---
id: 261125-110419
title: harness runs in the merge queue (scoped, with the attested exit) so it can become a required check
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.scripts-test.harness
  - wf.scripts-test.attest
prs: []
ratchet-release: []
field-changes: []
---

`harness` (scripts-test.yml: the repo-wide vitest suites, the TypeScript under scripts/ and the
shell suites that need node_modules) was advisory and never ran in the queue (ledger
260923-094812), so a PR red on it could merge and break main; #4396 nearly did. ci-steward decided
to require it. This change makes it safe to require: in a merge group the existing `attest` job
now also decides `harness`, from main's copy of scripts/scripts-test-scope.sh against the entry's
own change, and answers false when `harness` already succeeded on the entry PR's head (DOR-5130's
attested exit). Any doubt runs it, and a failed attest fails it closed. It still reports on every
pull request and queue entry: a scope skip reports `skipped`. ci-steward adds it to the ruleset and
ci/required-checks.json once it has reported green on PRs and queue entries.

Baseline: 0 queue runner-minutes on `harness`; harness reds can merge (#4396).
Target: no PR merged red on `harness`; under 300 queue runner-minutes a week on it (it runs only
for in-scope entries whose PR head did not already pass).
Evaluate: Dec 9.

Revert the requirement if `harness` ejects more than two queue builds a week on flakes.
