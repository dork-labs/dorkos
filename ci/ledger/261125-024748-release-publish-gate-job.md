---
id: 261125-024748
title: Release Publish runs release-gate.sh in a gate job before npm
kind: hygiene
status: proposed
actor: agent
gates: [wf.release-publish.gate]
prs: []
ratchet-release: []
field-changes: []
---

DOR-5123, design §5 row 6. This wires `scripts/release-gate.sh` (ledger `261124-020524`) into
`release-publish.yml` as the `gate` job: after `prove` and `prepare`, it reads main's copy of the
script only and fails unless the decision for P is exactly `SHIP`. `publish` needs it. P is
`prove`'s new output, set only after `proof.ts` has shown P is the branch's merge-base with main.
Only routine mode is gated (hotfix stays refused). The approval click stays on.

What it should do is measured under `261124-020524` (no green P refused, no bad P shipped, over
the first three daily releases). Revert if the gate job itself fails for a reason other than a
REFUSE (a permission or checkout error) on a release that should ship.
