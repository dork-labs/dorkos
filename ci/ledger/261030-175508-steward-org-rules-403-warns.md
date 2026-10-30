---
id: 261030-175508
title: The steward reports an unreadable org rule as a warning, not an unhealthy day
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The daily collector now reports a refused read of the organization rulesets as a
warning, not as a failure that marks the day unhealthy. Every other live-comparison
problem (a malformed list, a missing or duplicated rule, drift, any other API error)
still fails closed, and `census --live` still refuses on all of them.

Why: since #3168 (10-24) the collector compares the required-workflow rules against
`orgs/dork-labs/rulesets`. The workflow's own `github.token` can never read org
rules (`403 Resource not accessible by integration`), so `ci-steward` went red every
day and "collector unhealthy" hid the real reds behind it. The team chose not to add
an org token (PM, #dorkos 10-30). A 403 is now told apart by its own finding code,
`required-workflow/unreadable`.

This is a hygiene change: it claims no speed or flake improvement. Revert if the
collector gets a token that can read org rules; then a 403 means something changed
and should fail again.
