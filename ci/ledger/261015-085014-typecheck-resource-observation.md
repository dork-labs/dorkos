---
id: 261015-085014
title: 'Observe Linux memory counters during the unchanged full typecheck graph'
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: [2673]
ratchet-release: []
field-changes: []
---

PR #2673 typecheck jobs 116312957677 and 116321114313 (run 38702240169,
attempts 1 and 2) ended with runner shutdown, six unfinished tasks and 40 of 46
successful tasks. Neither captured log contains a TypeScript diagnostic or an
explicit out-of-memory diagnosis. Check annotations say only that the operation
was canceled. The cause remains unknown; the earlier V8 heap incident does not
establish the cause of these cancellations.

This evidence experiment streams bounded Linux host-memory, pressure and own
cgroup counters while the original `pnpm exec turbo typecheck --continue` runs.
Missing counters remain null, never an inferred zero or an OOM claim. It does
not sample command arguments, environments, process names or foreign process
RSS. Cgroup counters may include other processes in that cgroup and cannot alone
attribute a cancellation. Samples may stop if the runner itself disappears.

The full graph, dependency builds, Turbo concurrency 15, 8192 MiB Node heap,
20-minute job limit and required gate context remain unchanged. No retry,
quarantine or coverage reduction is added. Compiler failures and signal exit
statuses remain primary. Observation failure separately fails an otherwise
successful compiler step, so incomplete diagnostic collection is visible. The
owned sampler ends on control-pipe EOF and is waited before step exit; it also
checks parent identity. Output is capped at 240 samples and 256 KiB.

The maintained scripts fixture suite covers control EOF, absent parent identity,
compiler success, compiler failure, compiler signal, control-writer inheritance and observation-only failure.
The five Bash integration cases run on Linux; unsupported platforms explicitly
skip them. No reduction in failure rate is claimed before fresh hosted evidence.
