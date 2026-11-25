---
id: 261125-212923
title: Security's path lists cover C2's new kernel and shared homes
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-5303 (C2). The pure moves put code that Security's patterns covered into
new folders: five `services/core/` kernel folders and three `packages/shared`
files. On Security's call, `SECURITY_PATH_PATTERN` (workflow, reference fixture
and `Policy.swift`) gains all eight, and `SECURITY_DEEP_PATH_PATTERN` gains the
two that came from `rooms/repo/`. The parity test gets a row for each, with a
look-alike that stays off. This only widens which PRs need Security's review.
No job, timing or trigger changes, so nothing measurable should move.
