---
id: 261123-224453
title: Agent PR guidance matches the retired-arming flow (DOR-5124)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Text only; no gate decides differently. DOR-5124 (#4200) retired `arm.sh`, `arm-door.yml` and
merge-tail's arming and rewrote `contributing/ci.md`: `scripts/open-pr.sh` turns on auto-merge at
open, `gh pr merge --auto <n>` stays only to re-queue once after an ejection or for a PR opened
before Nov 24, `review-redispatch.yml` re-requests lost reviews, and Security's sign-off (a
passing `security-verdict` or `security-reviewed`) is the required `pr-gates` check. The guidance
agents read around it still described arming: the `creating-pull-requests` skill,
`watch-prs.sh`'s remedies (pinned by `test-watch-prs.sh`), `scripts/open-pr.sh`'s advice text
(pinned by `scripts/test-open-pr.sh`), and a few skills, commands and guides. They now match
`ci.md`. `ci.md` and `merge-guard.mjs` are untouched.

Revert if a fixture suite named above goes red on main because of this change.
