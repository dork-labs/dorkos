---
id: 261121-033128
title: Name the native browser fixture return type
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: [4037]
ratchet-release: []
field-changes: []
---

The public Chrome fixture's inferred return type reaches a non-portable dependency
path and fails declaration checking with TS2742. Give the exported async factory
an explicit Promise result using LocalBrowserService and the type-only
LocalBrowserProfileStore interface, with the existing async close method.

This is type hygiene only. No runtime behavior, storage, signing, admission,
workflow, timeout, retry or quality floor changes. Check desktop typechecking
and the existing profile contracts. Repair if the named result stops matching
what the helper returns; do not weaken the declaration check.
