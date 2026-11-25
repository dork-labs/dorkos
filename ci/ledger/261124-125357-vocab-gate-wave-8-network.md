---
id: 261124-125357
title: The vocab gate bans "Wi-Fi" in app copy and docs prose (wave 8)
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

The switch that lets other devices open DorkOS answers on every network the
computer is on, wired and VPNs such as Tailscale included, so its copy now
says "network" (DOR-5135). Wave 8 in `scripts/vocab-gate/banned-terms.json`
bans "wi-fi" and "wifi" in render positions, and `MDX_SCANNED_WAVES` adds it
to the docs scan, so the old word can't creep back. Against the base it
reports 61 hits; the same change rewrites all of them, and one docs line that
names real Wi-Fi is a scoped, reasoned allowlist entry.

Hygiene, not an experiment: no gate timing or failure rate should move. Revert
the wave, or add a scoped allowlist entry, if it fires on a genuine Wi-Fi
reference that has to stay.
