---
id: 261125-063713
title: The macOS Codex sandbox check reports on every PR and queue build, and runs macOS only for Codex changes
kind: experiment
status: proposed
actor: agent
gates:
  - wf.codex-binary-macos.scope
  - wf.codex-binary-macos.attest
  - wf.codex-binary-macos.codex-binary-macos
  - wf.codex-binary-macos.codex-sandbox-macos
prs: []
hypothesis:
  metric: tracked.codex-macos-escapes
  baseline: 1
  baseline_source: 'DOR-4402 (Nov 15): the secret-protection probe "protects fake secrets through %s despite a loaded legacy Full setting" failed on a Mac with no CI signal; codex-binary-macos.yml (ledger 261115-151842) has run on matching PRs since, optional and never in the queue.'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4402. Codex sandboxes commands with Seatbelt on macOS, and the only
required Codex binary run (`codex-sandbox` in test.yml) is Linux. The macOS
workflow from 261115-151842 ran on PRs that matched a trigger `paths:` filter,
so it could never be required: a filtered workflow reports nothing on an
unrelated PR, and a required check that never reports blocks it.

What changes. The workflow now triggers on every pull request, merge group,
push to main and dispatch. A one-minute ubuntu `scope` job diffs the change
(a PR's test-merge commit against its first parent, a queue entry against its
first parent, a push against `before`) and asks `scripts/codex-macos-scope.sh`,
read from the base commit, whether it can reach the Codex suites. The list is
the old trigger filter plus the shared policy, native environment and git
helpers the suites import (the list a reviewed candidate for this issue,
cc51ea23, scoped merge groups with). The macOS job runs only on a yes. In the
queue, the attested exit from DOR-5130 skips the macOS run when
`codex-sandbox-macos` already passed on the entry PR's head. The fan-in
`codex-sandbox-macos` always reports and fails closed on a failed, cancelled
or unreadable dependency. A push to main runs the same graph per merged
commit, and after-merge-alert.yml now watches it. The ruleset edit that makes
`codex-sandbox-macos` required is a separate step, after the check has
reported green on PRs and queue entries.

Cost, macOS runner minutes per week. Before: 86 PR runs from Nov 18 to Nov 25
(`gh run list -w codex-binary-macos.yml`, 98 of the last 100 green, p50 5.1
min), about 440 minutes. After, estimated: PR runs grow by the wider list
(93 against 74 of the 709 merges from Nov 11 to Nov 25 match it), about 550;
pushes to main that touch Codex, about 47 a week, about 240; queue runs about
zero, since a PR cannot queue without this check green on its head. About 790
minutes a week in all, plus one ubuntu minute per run for `scope`.

Revert, or narrow the list, if the macOS job is red on main for reasons that
are not macOS regressions, if it holds macOS runners a release needs, or if a
macOS-only Codex regression still reaches main through a path the list leaves
out (widen the list and cite it).
