---
id: 261124-184623
title: Check the private inbox on each Windows custody runner
kind: experiment
status: proposed
actor: agent
gates:
  - wf.windows-custody-witness.x64-producer
  - wf.windows-custody-witness.native-arm64
prs: []
hypothesis:
  metric: gate.wf.windows-custody-witness.x64-producer.duration_p90@pull_request
  baseline: 2.1
  baseline_source: 'CI Steward latest.json at cefa99f15f18 points to snapshots/2026-11-23.json. From November 17 through 23 the two completed x64 samples took 105 and 126 seconds. Five skipped jobs contributed no duration. The health warnings cover stale local hook exports.'
  target: 6
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4500 adds an inbox fixture to the existing opt-in Windows custody witness.
The x64 builder runs it in x64 Node 24.19.0 and ia32 Node 22.23.3. The ARM64
runner builds and runs it in native Node 24.19.0. Each process uses its own
Node release headers and import library. A passing receipt requires agreement
between two independent processes on the directory identity, observation of
the inherited file permissions, and removal of the empty directory.

The existing artifact for each runner also retains the tested addon, its
digest and the build and fixture logs. The guardian still needs all eleven
native cases on each architecture. The extra two x64-host builds should keep
the producer below six minutes at p90. Revisit the build steps if measured
duration exceeds that budget or if a passing step lacks its receipt.
