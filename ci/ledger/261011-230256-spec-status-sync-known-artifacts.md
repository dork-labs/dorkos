---
id: 261011-230256
title: spec-status-sync reads the known artifact names
kind: hygiene
status: proposed
actor: agent
gates: [claude.PostToolUse.spec-status-sync]
prs: [2778]
ratchet-release: []
field-changes: []
---

DOR-2704: the `spec-status-sync.sh` PostToolUse hook mapped any `04-*` or `05-*` spec file to `implemented`, so writing `04-acceptance.md` or `05-live-checklist.md` promoted a spec that was not built. It now reads the same known artifact names as `spec-manifest-ops.ts`, through the new `.claude/scripts/spec-artifact-status.ts`, and resolves its scripts beside itself so a test can run it against a sandbox repo. No gate, required check, retry or timeout changes; the hook still never blocks. Revert if a known artifact stops advancing a spec.
