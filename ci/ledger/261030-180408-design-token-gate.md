---
id: 261030-180408
title: Add the design-token gate
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The UI overhaul's Phase 1 moves motion onto tokens, and Phase 2 sweeps the old call sites. This adds `scripts/check-design-tokens.ts` to the `typecheck` job so new call sites don't appear behind the sweep. It bans overshoot curves in `index.css` and ratchets spring numbers outside `shared/lib/motion.ts`. Colour and type rows land with their own PRs.

`kind: hygiene` because no pipeline metric should move: the check reads text from git-listed files and takes under a second. Revert it if it reds PRs that did not touch a token.
