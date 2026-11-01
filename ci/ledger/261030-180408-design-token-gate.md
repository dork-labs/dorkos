---
id: 261030-180408
title: Ban overshoot curves in the design-token gate, and base it on the queue
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The UI overhaul's Phase 1 moves motion onto tokens, and Phase 2 sweeps the old call sites. Main's `scripts/check-design-tokens.ts` already guards colour. This adds one `hard` rule to it: no overshooting `cubic-bezier` in `apps/client/src/index.css`, which `reaction-pop` alone is exempt from. A rule can now read `.css` files and count with a function, and no colour rule reads CSS.

It also makes the gate's `--base` use `merge_group.base_sha` on the queue, the same `QUEUE_BASE` block as the file-size ratchet, because there `HEAD^1` is the previous queue entry. A spring-literal ratchet follows in its own PR.

`kind: hygiene` because no pipeline metric should move: the check reads text from git-listed files and takes under a second. Revert it if it reds PRs that did not touch a token.
