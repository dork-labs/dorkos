---
id: 261101-063000
title: 'The design-token gate refuses a removed or changed rule, unless a fresh guard-rule-change label covers it'
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

DOR-3557. Until now `--base` held the baseline to its base but not the rules themselves, so a PR could loosen a pattern, widen an `except` or delete a rule and the counts would agree with it. Now `--base` imports the base's copy of `scripts/check-design-tokens.ts` from a scratch directory and compares every base rule's `id`, `kind`, `pattern`, `only`, `except`, `files` and `count` (with the helpers a `count` calls, and what every rule reads) against this tree. A removed rule, or any change to those fields, fails. Any change counts, because telling a tighter regex from a looser one is not decidable here. A base that can't be read or parsed fails closed (exit 2). Added rules still go through the seeding check from #3374.

The override is a `guard-rule-change` label. It counts only when a person added it after the head's activity-feed push, any force push, its committer date and its first check suite. That is the security gate's head-time rule, `labelNewerThanHead` in `.github/scripts/security-label-at-head.mjs`, not a copy: `labelAtHead` now calls it, unchanged in behaviour. In `merge_group` a group has no labels, so each queued PR whose diff touches the script is read through the API the way `checkMergeGroup` reads them, and any failed read refuses. The canary and a dispatch skip the rule check, since neither merges anything.

**What the label does not prove.** "Only Security adds `guard-rule-change`" is a team rule, NOT enforced: agents can label as Dorian (posture item 22), so the label proves when, not who. Once agents have their own GitHub identities, the check should also require that Security added it. The gate also runs from the PR's own tree, so a PR that edits the guard can edit the check; the review of that diff is still the control.

The `typecheck` job gains `pull-requests: read` and `checks: read`, both read-only, and the token is used only when a PR changes a rule. `overshoot-bezier` now skips only the exact `animation: reaction-pop <time> cubic-bezier(…);` line, not any line that mentions `reaction-pop`.

`kind: hygiene`: no pipeline metric should move. Revert or rework if the rule check refuses a PR that didn't touch `scripts/check-design-tokens.ts`.
