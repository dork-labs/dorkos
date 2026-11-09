---
id: 261109-150820
title: A PR that does one part of a multi-part ticket says Refs, never Fixes or Closes
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The `creating-pull-requests` skill now carries one more line: a PR that does one part
of a multi-part ticket says `Refs DOR-…`, never `Fixes`/`Closes`, so Linear doesn't
close open work. The same line opens the checklist in the new
`.github/pull_request_template.md`.

Why: Linear closes a ticket on merge when a PR names it with a closing word, and
partial PRs kept closing tickets that still had work left.

This is a hygiene change: it changes no gate, job, retry, shard or timeout, and it
claims no speed or flake improvement. It is documentation only.
