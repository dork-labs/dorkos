---
id: 261005-105214
title: An extension's approval covers the permission set the person saw; widening it asks again
status: accepted
created: 2026-10-05
spec: isolated-extension-backends
superseded-by: null
amends: null
---

# 261005-105214. An extension's approval covers the permission set the person saw; widening it asks again

## Status

Accepted

## Context

An update from an approved source keeps its approval, and a path-bound approval survives edits. Without more, a declared `allow.net`, `allow.run` or `allow.agents` could widen silently after a person said yes to a narrower one.

## Decision

Operator-only config `extensions.approvedPermissions[id]` records the set a person approved; a missing entry reads as the full in-process set, because every earlier approval was for full authority. `mayRunExtensionCode` requires the declared set to be covered by the approved one. Narrowing never asks; widening parks the extension in the existing approval queue with a card that leads on what is new.

## Consequences

### Positive

- Declared lists mean what the person saw.
- Moving an approved extension to `subprocess` costs nothing.

### Negative

- One more config field and migration; a dev-link author who widens `allow.net` sees an approval card.
