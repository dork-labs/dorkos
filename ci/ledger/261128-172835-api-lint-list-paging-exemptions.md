---
id: 261128-172835
title: api-lint's list-paging rule skips a reasoned list of lists that never page
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4982 (A5 under DOR-4977). Of the 74 `list-paging` findings on main (1f86da4a9d), 48 are lists the API lead classified as never paging: small, fixed or one-resource views, a graph read whole, lists with no order that holds still, lists the architect asked to leave until a later roadmap step removes or rebuilds them, and the room lists a later item reshapes. They now sit in `scripts/api-lint/list-paging-exemptions.ts`, each with a category and a one-line reason, and the rule skips them, so the count is only real debt: the baseline falls from 74 to 26. A test fails when an entry has no reason or no longer matches an unpaged list in the committed document, so stale entries cannot pile up. No gate's retries, shards, timeout or required status change, so this is hygiene. Revert if entries start being added to dodge paging rather than because a list should not page.
