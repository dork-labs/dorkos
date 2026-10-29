---
id: 261027-122636
title: The security gate counts the whole desktop app
kind: hygiene
status: proposed
actor: agent
gates: [wf.security-gate.security-gate, wf.security-review-initialize.initialize]
prs: [3224]
ratchet-release: []
field-changes: []
---

DOR-3366. #3223 changed `apps/desktop/src/main/**` and `security-review` called
it "no security paths": the list covered the desktop preload only. Security's
call (#dorkos, 2026-10-27): gate all of `apps/desktop/` as one entry, replacing
the preload entry. Sub-paths kept missing trust files: the main process, the
entitlements, the server entry, the login-shell path, the orphan watchdog, the
Vite config, packaging and the build and smoke scripts.

The pattern changes in all three tracked copies at once (the workflow, the
approved reference fixture, and `tools/security-approve/Policy.swift`); the
parity test keeps them equal, and Security updated the host-only interim
checker to match. Fixtures pair each match with a near-miss outside the folder
(`apps/desktopx/`, `apps/desktop-notes/`) and a rename.

Metric (not in `ci/metrics.yaml`, so stated here; hygiene is exempt): PRs that
touch `apps/desktop/` and get the automatic "no security paths" status.
Baseline 1 (#3223). Target 0. Check on 2026-11-10 by listing merged PRs that
touch `apps/desktop/` and reading their `security-review` status.

No required check, permission, timeout or ruleset change. Cost: every desktop PR
waits for Security. Revert only for a shown false classification, never to clear
a pending review.
