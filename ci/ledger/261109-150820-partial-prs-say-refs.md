---
id: 261109-150820
title: Partial PRs say Refs, never Fixes or Closes; security PRs name only what's fixed
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The `creating-pull-requests` skill now carries two more lines, and the new
`.github/pull_request_template.md` checklist opens with the same two:

1. A PR that does one part of a multi-part ticket says `Refs DOR-…`, never
   `Fixes`/`Closes`, so Linear doesn't close open work.
2. A security PR's public title, body, commits and test names say what's fixed, never
   what's still open; residuals go to Security privately, not on GitHub.

Why: Linear closes a ticket on merge when a PR names it with a closing word, and
partial PRs kept closing tickets that still had work left. And a public PR that names
an open security gap tells everyone where to look before it is fixed.

This is a hygiene change: it changes no gate, job, retry, shard or timeout, and it
claims no speed or flake improvement. It is documentation only.
