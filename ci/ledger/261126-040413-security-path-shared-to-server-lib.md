---
id: 261126-040413
title: Security's path list covers the server's new lib/secret-store/ (DOR-4931)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4931 moves the `@dorkos/shared` modules only the server reads into `apps/server/src`. Two of them hold secrets: `secret-file` (the exclusive-create secret files, the host key among them) and `extension-secrets` (the AES-256-GCM per-extension store). They move to `apps/server/src/lib/secret-store/`, and that folder joins `SECURITY_PATH_PATTERN`, the reviewed fixture and `tools/security-approve/Policy.swift`, kept equal by the parity test, which gains a main-list-only row for each file; `security-paths-check.test.mjs` gains a match row for the folder and one for `extension-settings`, which lands in the already covered `services/extensions/settings/`. Step 6's shared homes (`chat-client-id`, `room-attachment-paths`, `connections-lease`, `heartbeat-schemas`) stay in `@dorkos/shared` and on the list as they were; no file on the list leaves it. Security updates its installed local checker to match. Nothing measurable should move; revert only with the move itself.
