---
id: 261115-233019
title: Pass the stranger-mark off switch to the dev server
kind: hygiene
status: active
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4453 turns DORKOS_MARK_STRANGER_TURNS on by default and keeps 'false' as the off switch. Turbo strict environment handling would otherwise strip the variable from the standard pnpm dev flow, so a developer who sets it to false in .env would still get the mark. The dev task now passes through exactly that variable, beside DORKOS_YOUR_BROWSER_ENABLED. It reaches no build or test task, and no cached-task key, gate, timeout, shard or required context changes.

This is hygiene, with no performance claim. Revert if the passthrough reaches a task beyond dev. The server env, relay and rooms tests cover the default and the off switch; final-head CI remains required.
