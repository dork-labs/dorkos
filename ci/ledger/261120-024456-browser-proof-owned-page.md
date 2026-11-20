---
id: 261120-024456
title: Use the broker-created page in the Chrome proof
kind: hygiene
status: active
actor: agent
gates: [wf.desktop-smoke.packaged-runtime]
prs: [4041]
ratchet-release: []
field-changes: []
---

The Chrome proof used the first physical tab, which became unowned when page leases
started creating a separate page per chat. It navigated that tab while the chat's
blank page remained in front, so the native screenshot could not show the proof.

Read the exact registered Page through the named chat's scoped host handle on
each iteration, including after Chrome reopens. Refuse a missing or closed handle
instead of selecting an existing tab. Bring that page forward before the proof
navigates it, before any handoff, and assert tab visibility after native capture. No production browser behavior, assertions, timeout, retry or gate changed.

Four fake-context tests fail with the previous first-tab selection and pass with the
scoped handle. Real Chrome, cookie persistence, quit timing and TCC checks remain CI-only.
Revert if the proof diverges from the broker's page or loses the reopened page.

Classify the new proof-page suite as repo-wide because it imports the desktop
helper outside scripts/. The existing suite-list guard proves it is on exactly one
list and collected in the merge queue. No check or assertion is removed.
