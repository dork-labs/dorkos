---
id: 261126-062200
title: api-lint's list-paging rule counts a collection, not a single resource holding an array
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4996, for DOR-4978. `isListBody` in `scripts/api-lint/rules.ts` called a 200 body a list when any property was an array, so a single resource with an array field (the agent manifest behind `GET /api/agents/current`: an `id`, `string[]` capabilities and an `mcpServers` array) would count once documented, and block that route's move onto the capability mount. A list is now a top-level array, or an object with no `id` property and at least one array whose items are not plain values (an `enum`, or only string, number, integer, boolean or null types). An array with no item schema still counts, and the object's other properties are not judged, because real lists carry `warnings` or counts beside their rows (`GET /api/sessions`).

Hypothesis: on main's document (66079e348c) the 101 `list-paging` items are unchanged, none added and none dropped, so the baseline does not move; the change only stops future single-resource routes from counting. No gate's retries, shards, timeout or required status change, so this is hygiene. Revert if a real list (an array of rows, with or without metadata) ever stops counting.
