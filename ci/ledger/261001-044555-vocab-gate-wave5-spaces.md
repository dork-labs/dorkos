---
id: 261001-044555
title: check-vocab-gate.ts scans docs prose for wave 5 (community → space)
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: [2436]
ratchet-release: []
field-changes: []
---

DOR-2631 renamed what people read from "community" to "space" (spec
dorkos-account-by-default, decision D6). Wave 5 in `banned-terms.json` bans
"community"/"communities" in copy positions, which is data the gate already
reads. The one code change is adding `wave-5` to `MDX_SCANNED_WAVES`, so docs
prose is held to the rename too: the docs are where a person learns the word.
Inline code is still blanked, so a literal `dorkos community deploy` or a
route is never flagged; every surviving legitimate use is a scoped, reasoned
allowlist entry.

No timing, retry, shard or required-status change: the scan is the same
in-process pass over the same files. Revert if docs prose needs the old word
in so many places that the allowlist stops being an audit trail.
