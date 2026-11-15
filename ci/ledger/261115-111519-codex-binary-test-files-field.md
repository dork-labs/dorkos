---
id: 261115-111519
title: The DOR-4408 real-Codex case in app-server.binary.test.ts also expects the Activity line's new files field (DOR-4410)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

One line in an existing case of `app-server.binary.test.ts`: the Activity line it expects now carries `files`, the `.codex/config.toml` paths found from the repo top down to the chat's folder (DOR-4410). No new case, no new binary run, and no gate, job or required check changes. Nothing measurable should move. Revert with the DOR-4410 change if the case starts failing for this field.
