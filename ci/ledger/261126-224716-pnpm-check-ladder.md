---
id: 261126-224716
title: pnpm check prints the gate ladder and runs one rung; the four verify names go
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

A contributor learned the local gates from a dozen documents and four root
scripts (`verify`, `verify:preopen` and their two inner turbo chains), two of
them documented (DOR-4947). `pnpm check` now prints the ladder (edit, commit,
push, preopen, verify, PR, queue) with when each rung runs and what it runs,
and `pnpm check <stage>` runs a local rung's own command unchanged:
`format-changed.sh`, `lefthook run pre-commit`, `lefthook run pre-push`, and
`scripts/verify-proof/cli.ts run-preopen` or `run`. The PR and queue rungs run
only in CI; naming one prints the required checks and exits 2.

The four names are replaced in the same change with no alias (ADR
`261123-170832`): `verify` and `verify:preopen` become `pnpm check verify` and
`pnpm check preopen`; the inner chains become `check:verify:turbo` and
`check:preopen:turbo`, byte for byte the same commands. Every hook comment,
doc, skill and test that named them is updated. `test:scripts` already finds
its suites by glob (ledger fixture-suites-by-glob), so that part of the ticket
was done.

Hygiene, not an experiment: no gate runs anything new or skips anything, and
no CI workflow changes. Revert the rename if a caller outside this repo
breaks.
