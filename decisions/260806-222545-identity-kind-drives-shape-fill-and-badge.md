---
id: 260806-222545
title: Identity kind drives shape, fill and badge in IdentityAvatar
status: draft
created: 2026-08-06
spec: identity-consistency
superseded-by: null
---

# 260806-222545. Identity kind drives shape, fill and badge in `IdentityAvatar`

## Status

Draft (auto-extracted from spec: identity-consistency)

## Context

`IdentityAvatar` (`apps/client/src/layers/shared/ui/identity-avatar.tsx:137`) carries a working,
colourblind-safe convention — square for an agent, circle for a person, the agent's own colour as a
solid fill, a `Bot` corner badge, a platform glyph for someone bridged in — and was deliberately kept
kind-agnostic so that a room could draw an agent without importing `entities/agent`, which the FSD
layer rule forbids. The cost was that mapping a kind to a `{ shape, variant, badge }` triple became
the caller's job, and an audit of every identity surface found it done correctly in **2 of ~20**
(`MessageAuthorAvatar.tsx:70-72`, `identity-hover-card.tsx:120-122`). The rest inherit
circle/tint from `AgentAvatar` (`entities/agent/ui/AgentAvatar.tsx:39`), which never passes either
prop — so the violation is inherited by construction, not repeated by hand.

## Decision

We will give `IdentityAvatar` an optional `kind: AuthorKind` prop (plus `origin`, for the external
badge) that derives `shape`, `variant` and `badge` defaults, with explicit props still overriding per
axis and `badge={null}` as the explicit opt-out. `kind` reuses `AuthorKindSchema`'s
`'human' | 'agent' | 'system'` rather than introducing a second spelling. The component stays
presentational — it reads a kind, it does not resolve one — so the FSD reason it exists survives.
`AgentAvatar` stays as the agent wrapper (its health ring is mesh vocabulary `shared/` must not
learn) but its props **narrow**: it no longer extends `VariantProps<typeof identityAvatarVariants>`,
so it can no longer be handed a `shape`, and it hard-passes `kind="agent"`.

## Consequences

### Positive

- The convention is now structural: forgetting it is not an available mistake through either path.
- Twelve call sites gain square/fill/`Bot` from one edit to the base, with no call-site change.
- `shared/` still knows nothing about agents, so a room keeps drawing one without a layer violation.
- The narrowing is compile-checked, so a regression is a type error rather than a visual one nobody
  files.

### Negative

- Two ways to say the same thing now exist (`kind`, or the explicit triple), and the older spelling
  survives at a handful of already-correct call sites until they are swept.
- `IdentityAvatar` gains a type import from `@dorkos/shared` and an icon import, so a component that
  was previously dependency-free has two.
- Existing tests asserting `rounded-full` on agents go red on purpose and must be rewritten rather
  than deleted.
