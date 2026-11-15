---
id: 261115-083454
title: One more real-Codex case in app-server.binary.test.ts for a cloned repo's own MCP server (DOR-4408)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Adds one test to `app-server.binary.test.ts`: a made-up repo whose `.codex/config.toml` names a probe MCP server must start it only at Full. It pins the DOR-4408 trust fix on the real binary. It runs wherever the binary is found, adds about 1 s, and changes no gate, job or required check. Nothing measurable should move. Revert if it flakes: drop the test and keep the unit and loader cases.
