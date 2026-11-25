---
id: 261125-192030
title: open-pr.sh records the PR and the tickets it names in the work graph, and never refuses an open over it
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-5264: after a PR exists, `scripts/open-pr.sh` runs a new step 6,
`scripts/open-pr-work-links.sh`. It tells the DorkOS server that started this chat's turn
that the chat opened the PR, and works on the tickets the body names for sure (Linear issue
links and `DOR-` keys, a Fixes line included; never words like `COVID-19`, `HTTP-2` or `UTF-8`).
It names no chat: the server reads it off the chat's own identity token and refuses unless
that chat is mid-turn. It goes through `dorkos call work-graph.record-pr`, with the token in the
environment and the input on stdin. With no CLI it falls back to curl, and only to a loopback
`DORKOS_API_URL`, with the token in a config on stdin so `ps` never shows it.

The step never changes the open's exit code or output above it. It prints one `work-graph:`
line, and with no chat token, no server, a refusal or a 15-second stall it says the link was
not recorded. `scripts/test-open-pr.sh` pins the CLI call, the curl call against a real
loopback server, the unreachable server, a non-loopback address and the ticket rules. It needs
only bash, jq and node, so it stays in the `fixtures` job. No gate's retries, shards, timeout or
required status change, so this is hygiene. Revert if a PR open fails or stalls on step 6.
