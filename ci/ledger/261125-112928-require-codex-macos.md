---
id: 261125-112928
title: codex-sandbox-macos is a required check
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.codex-binary-macos.codex-sandbox-macos
prs: []
ratchet-release: []
field-changes: []
---

DOR-4402. #4380 made `codex-binary-macos.yml` always report one fan-in check, `codex-sandbox-macos`: green when
the change cannot reach the Codex suites, when the macOS sandbox run passed, or when a queue entry was attested
(the PR head already passed it). Before requiring it, it reported green on 12 pull-request runs, 10 merge-queue
builds and 8 pushes to main (Nov 25). This adds it to `ci/required-checks.json`; ruleset 19893973 follows.

The measurement lives in ledger `261125-063713-codex-macos-required`. Revert if the fan-in ever blocks a pull request
that cannot reach the Codex suites, or a queue entry waits on a macOS runner it should have attested past.
