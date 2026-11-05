---
id: 261105-010125
title: Register boot-cache sign-out beside the opt-in owner auth spec
kind: hygiene
status: proposed
actor: agent
gates: [wf.browser-test.browser-test]
prs: [3522]
ratchet-release: []
field-changes: []
---

The browser gate in queue run 41882667122 rejected the new sign-out cache spec
because all its tests intentionally skip without DORKOS_E2E_AUTH. It mutates
global owner/login state and uses a fresh isolated server, just like
settings/auth-login.spec.ts. Register it beside that spec in OPT_IN_SPECS.

This updates the gate's opt-in inventory rather than adding a new skip mechanism.
Fixtures prove the new exemption is valid only while every test skips; an
unexpected skipped spec and an opted-in spec that starts executing still fail.
The local auth run exercises the real spec. Revert the entry when the spec moves
to an isolated CI auth project, at the same time its default-run contract changes.

CI status was read before this change (2026-11-03 snapshot). No job, required
context, retry, timeout, or shard setting changes, and no performance claim.
