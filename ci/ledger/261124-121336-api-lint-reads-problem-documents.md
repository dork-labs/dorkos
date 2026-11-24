---
id: 261124-121336
title: The API lint's error-shape rule reads problem documents
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

The API lint's `error-shape` rule (DOR-4996) counted an error response as shared only when
its `application/json` body was a `$ref` to `ErrorResponse`, and its own source said "DOR-4979
adds `Problem`". DOR-4979 moves the routes to RFC 9457 problem documents, served as
`application/problem+json` with a `$ref` to `Problem` (or an `allOf` over it when the problem
carries extension members), so every switched route read as a regression.

The rule now reads the `application/problem+json` body first, then the JSON one, and accepts
`Problem` beside `ErrorResponse`. No rule became looser for a route that still answers the old
shape. The baseline only went down: `error-shape` 606 to 369, `error-missing` 40 to 39. A test
covers a plain problem, one with extension members, and an inline problem body (still counted).

Revert if a route can pass `error-shape` without a shared error schema in its document.
