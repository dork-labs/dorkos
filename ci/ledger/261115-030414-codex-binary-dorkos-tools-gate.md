---
id: 261115-030414
title: The real-binary Codex suite checks DorkOS tools behind a key-checking listener
kind: hygiene
status: proposed
actor: agent
gates: []
prs: [3748]
ratchet-release: []
field-changes: []
---

Adds four cases to the existing Codex real-binary suite for DOR-3169: a fresh thread at read-only and workspace-write, a cold resume and a fork, each against a fake DorkOS tool server that checks every key through the real principal service. No workflow, shard, timeout or required check changes; the suite runs where it already ran. Nothing measurable should move beyond a few seconds of that suite's run. Revert if these cases flake on CI.
