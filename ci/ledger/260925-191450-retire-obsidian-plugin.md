---
id: 260925-191450
title: Remove retired Obsidian build and test plumbing
kind: hygiene
status: active
actor: agent
gates:
  - wf.test.test-shard
  - wf.typecheck.typecheck
  - wf.scripts-test.fixtures
prs: []
ratchet-release: []
field-changes: []
---

The operator retired the Obsidian surface (DOR-2343). Remove its package, test project, build-output cache entry, fixture-mirroring guard and changed-file typecheck hook branch. Update test workflow prose; required contexts, retries, timeouts, shard counts and supported-surface floors stay intact.

This is retirement hygiene, not a speed experiment. The 2026-09-24 CI status snapshot reports healthy collection and queue-green as its constraint. No performance improvement is claimed.

Verify package census, CI census, ledger coverage and supported client/server/desktop builds and tests. Revert if supported behavior depends on removed plugin machinery; do not restore an obsolete gate solely to preserve its old test count.
