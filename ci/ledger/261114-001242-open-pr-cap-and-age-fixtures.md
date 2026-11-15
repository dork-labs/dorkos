---
id: 261114-001242
title: scripts-test runs the open-PR cap and PR age list fixtures
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-3341 adds two scripts to the `creating-pull-requests` skill: `open-pr-cap.sh`,
which refuses a new PR while too many are open, and `pr-age-list.sh`, the standup
list of PRs older than three days. Each has a fixture script with a stubbed `gh`.

They run in the `scripts-test` workflow beside `test-watch-prs.sh`, for the reason
that step's own comment gives: a fixture nothing runs stops protecting anything.
The new step needs only bash and jq, adds well under a second to an existing job,
and changes no required check, retry, shard or timeout, so no metric in
`ci/metrics.yaml` can move. Revert if the step ever needs the network.
