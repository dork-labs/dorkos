---
id: 261124-001240
title: queue-repeat-guard keeps its decision scripts, and the suite runner is renamed out of the test-*.sh pattern
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.queue-repeat-guard.door
  - wf.scripts-test.fixtures
  - wf.scripts-test.harness
prs: []
ratchet-release: []
field-changes: []
---

Main red, Nov 24. #4200 (DOR-5124) deleted `should-arm-automerge.sh` and its input builder, which
`queue-repeat-guard.yml` still runs, so `fixtures` went red and the queue's repeat-ejection door
could not decide. #4195 put the suite list in `scripts/test-scripts.sh`, a name the parity test
reads as a fixture suite, so `harness` went red. Both scripts are restored with their fixtures,
and the runner is now `scripts/run-scripts-suites.sh`.

Revert never; if the queue guard moves off these scripts, retire them then.
