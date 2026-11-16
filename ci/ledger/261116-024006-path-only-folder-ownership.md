---
id: 261116-024006
title: Keep folder ownership independent of server configuration
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.test-shard, wf.test.test]
prs: []
ratchet-release: []
field-changes: []
---

DOR-4514 removes an unnecessary configuration/projection dependency from the
CLI's folder-ownership check. The same canonicalize/isAgentHome functions move
to a path-only module; their existing exports remain available. The actual
room-worktree reserved-name refusal, whole-tree no-write snapshot and ordinary
folder positive control remain unchanged.

PR3836 Linux shard5 failed the first harness-adopt command case at5010ms against
the unchanged5000ms budget. The exact-head file passes23cases in isolation, so
this does not claim a deterministic timeout reproduction. Disposable probes
measured the original cold command at1561ms, with1557ms awaiting imports and
0.3ms resolving ownership; the next warm command took2.4ms. The ownership module
was importing path helpers from workspace provisioning, which loads server
configuration and projection dependencies. These are local diagnostic timings,
not an aggregate CI SLO baseline or improvement claim.

An import-graph boundary now requires ownership runtime dependencies to stay
within filesystem/path operations. Restoring the heavyweight import fails that
boundary. Forcing ordinary-folder ownership in the actual CLI command fails the
reserved-room refusal case. Restore both and run the unchanged CLI suite plus
real canonical/symlink ownership, workspace projection and agent-created suites.
The helpers retain missing-path fallback, symlink containment and legacy exports.

This is dependency hygiene. No setup warming, mocked ownership, skipped case,
timeout, retry, shard, worker cap, required check, credentials or quality floor
changes. Revert or revise if the dependency cut changes path classification,
loses a public export, makes room adoption write files, or stops the boundary
from catching a restored configuration dependency. Integrated exact-head and
Linux CI verification remain required; an isolated local pass does not replace
them.

Main integration at d9993507b247c84825d407e5621b1728b60fb965 independently
places these same path helpers directly in directory-ownership.ts (FG-005).
Keep that canonical leaf and remove the now-unneeded workspace-paths
intermediary. Main rewires every production helper caller to that leaf; no
caller needs helper reexports through project-agent-workspace. The canonical
exported signatures, real-path/import boundary and CLI refusal controls remain. This consolidates identical helper bodies, not ownership semantics.
