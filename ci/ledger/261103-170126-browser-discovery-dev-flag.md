---
id: 261103-170126
title: Pass the browser discovery opt-in to the dev server
kind: hygiene
status: active
actor: agent
gates: []
prs: [3477]
ratchet-release: []
field-changes: []
---

DOR-3215 adds an off-by-default browser discovery flag. Turbo strict environment handling would otherwise strip it from the standard pnpm dev flow, so the dev task passes through exactly DORKOS_YOUR_BROWSER_ENABLED. It reaches no build or test task, and no cached-task key, gate, timeout, shard or required context changes.

CI status was read before this change: the current constraint is headroom, which this runtime-only configuration wiring does not address. This is hygiene, with no performance claim. Revert if the passthrough reaches a task beyond dev or changes default-off behavior. The server route and client tests cover flag-off refusal and hidden UI; final-head CI remains required.
