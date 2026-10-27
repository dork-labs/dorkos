---
id: 261027-122636
title: The security gate counts desktop main, packaging and smoke scripts
kind: hygiene
status: proposed
actor: agent
gates: [wf.security-gate.security-gate, wf.security-review-initialize.initialize]
prs: []
ratchet-release: []
field-changes: []
---

DOR-3366. #3223 changed `apps/desktop/src/main/**` and `security-review` called
it "no security paths": the list covered the desktop preload only. The main
process starts the server, owns the window's privileges and talks to the OS, so
it belongs beside the preload. Electron packaging (`apps/desktop/electron-builder.yml`:
entitlements, hardened runtime, what ships) and the packaged smoke scripts
(`apps/desktop/scripts/smoke-*`) join it.

The pattern changes in all three tracked copies at once (the workflow, the
approved reference fixture, and `tools/security-approve/Policy.swift`); the
parity test keeps them equal. Each new entry has a match, a near-miss and a
rename fixture. The host-only interim checker is not a repo file and is updated
separately by Security; until it is, the local parity test reports the drift.

Metric (not in `ci/metrics.yaml`, so stated here; hygiene is exempt): PRs that
touch these desktop paths and get the automatic "no security paths" status.
Baseline 1 (#3223). Target 0. Check on 2026-11-10 by listing merged PRs that
touch `apps/desktop/src/main/` and reading their `security-review` status.

No required check, permission, timeout or ruleset change. Cost: more desktop PRs
wait for Security. Revert an entry only for a shown false classification, never
to clear a pending review.
