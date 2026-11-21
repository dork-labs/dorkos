---
id: 261120-182110
title: Run the private Windows custody witnesses on explicitly selected draft PRs
kind: experiment
status: proposed
actor: agent
gates:
  - wf.windows-custody-witness.x64-producer
  - wf.windows-custody-witness.native-arm64
prs: []
hypothesis:
  metric: gate.wf.windows-custody-witness.x64-producer.duration_p90@pull_request
  baseline: null
  baseline_source: 'The observed main workflow inventory at 2f47b50c7ab2 has no Windows custody witness job. Its advisory harness-windows job runs the TypeScript harness and extension suites, so it has no comparable native witness samples.'
  target: 15
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4500 adds an opt-in native receipt for the exact reviewed source. The run
uses the ordinary same-repository draft PR event. Adding the
`run:windows-custody` label selects that head. A later head needs a fresh opt-in.
It does not run at PR open, on pushes, on a schedule or in the merge queue.

The first job pins Windows Server 2022, x64 Node 24.19.0, the VS 2022 v143
toolchain and SDK 10.0.26100.0. It builds the existing private artifacts once,
prepares the separate ARM64 companion and records the x64 and Node 22.23.3
ia32 cases independently. Between the two it runs the witness tools' own
node:test files (43 cases, seconds) on the same head, since no other suite
runs them and one of them checks the summary that credits the eleven cases. The second job uses native Node 24.19.0 on Windows
ARM64. It downloads the same-run artifact by its exact ID. The guardian and
companion checks use independently exported manifest digests.

Both jobs run only local fixture processes. They preserve guarded inputs,
native test observations and raw logs. The workflow keeps the current required
checks, release workflows, shared dependencies and runtime selection unchanged.
Both jobs have finite ceilings. The x64 producer should finish inside 15
minutes at p90 across opted-in runs over the first 14 days. Review actual
native receipts separately for eleven passing cases per intended architecture.
Narrow or retire the dedicated workflow if it repeatedly exceeds the budget
or produces an incomplete evidence run without a visible failure.
