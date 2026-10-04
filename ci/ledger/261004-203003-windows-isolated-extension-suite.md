---
id: 261004-203003
title: Run the isolated-extension suite on the Windows runner
kind: experiment
status: proposed
actor: agent
gates:
  - wf.harness-windows.harness-windows
prs: []
hypothesis:
  metric: 'gate.wf.harness-windows.harness-windows.failure_rate@pull_request'
  baseline: 0.0187
  baseline_source: 'origin/ci-steward-data snapshots/2026-09-27.json through 2026-10-03.json, gates["wf.harness-windows.harness-windows@pull_request"]: 12 failure / 641 decided (success + failure); duration p50 over the same 641 runs 5.33 min'
  target: 0.03
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-2686 runs an extension's server half in its own Node process with Node's permission model on,
a network guard inside it, and a host-side broker for the programs it may run. Almost every part of
that is shaped by the platform: permission grants are real paths (drive letters, 8.3 short names),
the child's environment is built from nothing (Winsock needs `SystemRoot`), programs are resolved
through `PATHEXT` and stopped with `taskkill`, and the guard's raw-handle layer reads pipe handles.
The suite under `apps/server/src/services/extensions/isolation/__tests__/` is written against real
child processes, and every other CI leg is macOS or Linux, so nothing has ever run it on Windows.

The change adds one step to the existing advisory `harness-windows` job: `pnpm vitest run
apps/server/src/services/extensions/isolation`. It reuses the job's scope decision (`dorkos` depends
on `@dorkos/server`, so a server change already counts as affected) and its `dorkos^...` build, so
no new job, runner or required check. The suite takes about 25 seconds on macOS, most of it the one
watchdog test that waits out the real 15-second pong timeout.

This is a coverage change, so the hypothesis is that it does not make the job unreliable: the
failure rate on pull requests stays at or under 0.03 (baseline 0.0187). A red that is a real Windows
difference in isolation is the point and counts as a catch, not noise; read the failing test before
calling it flaky. Revert the step, or quarantine a single test with evidence, if the job's failure
rate climbs past the target from the isolation suite and the failures are not real defects. No
Windows user-facing claim follows from a green run (the demo-claim gate): a CI runner is not a
person's install.
