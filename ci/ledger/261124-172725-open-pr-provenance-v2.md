---
id: 261124-172725
title: open-pr.sh signs PRs with a provenance v2 line from the provenance CLI, and never refuses an open over it
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-5047 steps 2-4: `scripts/open-pr.sh` used to build a version 1 provenance line with jq. It now
runs `scripts/provenance/provenance-line.ts` (through the repo's `node_modules/.bin/tsx`,
`--visibility public --surface github`), so the rules for the line live in one place,
`@dorkos/shared/provenance`, and a DorkOS turn's `agent` and `space` reach the PR body.

Signing never refuses an open. A field the environment does not name is left out and listed in
the output (`provenance: appended: ... (omitted: agent, space)`). When the CLI cannot run (no
`pnpm install`, no node, a crash, or output that is not one signature line), the PR opens with
`{"v":2,"surface":"github"}`, a warning and the reason. jq is no longer a hard requirement here.
The CLI costs about 0.1 s warm and 0.8 s cold.

`scripts/test-open-pr.sh` pins the arguments and every fallback with stub tsx, so those run in
the `fixtures` job, which has no `node_modules`. The cases that run the real CLI need an install
and skip there, saying so; they run under `pnpm test:scripts`, and the CLI's own suite pins the
line. No gate's retries, shards, timeout or required status change, so this is hygiene. Revert if
a PR open fails or stalls on the provenance step.
