---
id: 260806-222547
title: A profile is a drawer to view and a settings tab to edit
status: accepted
created: 2026-08-06
spec: identity-consistency
superseded-by: null
---

# 260806-222547. A profile is a drawer to view and a settings tab to edit

## Status

Accepted (2026-08-08) — implemented across the Team, Identity & Profiles programme (DOR-966). (auto-extracted from spec: identity-consistency)

**Amended by 260816-223619 (2026-08-16, profile-unification):** the drawer is now one Profile with two homes (docked on `/session`, sheet elsewhere) and editing your own identity happens in place on its rows — Settings › Profile stays only as a second door. Still governing from this ADR: the `?profile=<id>` address, one component for every identity kind, `ResponsiveSheet`, and the hover card's `onViewProfile` callback prop.

## Context

`IdentityHoverCard` ships with a "View profile" footer marked **soon**, because there was nowhere to
send the click. Once a roster, a mention pill and a message avatar all want to open "who is this",
the surface has to be decided, and the three candidates behave very differently on a phone: a drawer
that both views and edits (one place, but form editing in a transient overlay), a full `/profile`
route (roomy, but a navigation away from whatever you were reading), or a split — a drawer to look,
settings to change. A related constraint: the thing being looked at may be an agent or a person, and
building two components would guarantee they drift, exactly as the two room roster rows already did.

## Decision

We will split viewing from editing. **One** profile drawer component renders **any** identity kind
from the same descriptor family `IdentityHoverCard` uses — a right-side sheet on desktop, full-screen
on mobile, addressed by a `?profile=<id>` search param so it is shareable and the back gesture
dismisses it. **Editing your own identity lives in a Settings › Profile tab, promoted to the top of
Settings**, and the drawer's Edit button deep-links to it through the existing
`?settings=<tab>` machinery. The hover card's deferred footer becomes a real control via an
`onViewProfile` callback prop rather than an import, so the primitive stays in `shared/`. Because no
`shared/ui` primitive pairs a desktop right drawer with a full-screen mobile sheet, we add
`ResponsiveSheet`, generalized from the two places that already hand-roll it.

## Consequences

### Positive

- One component for every kind, so an agent's profile and a person's cannot drift apart.
- A form lives on a settled surface, which is the difference between usable and infuriating on a phone.
- A profile is a URL, so it survives reload, back, and being sent to someone.
- The hover card stays presentational and layer-legal while finally doing something on click.

### Negative

- Editing is two clicks from viewing, and someone will want to rename themselves without leaving the
  drawer.
- A new shared primitive is one more thing to maintain, and the mobile account menu it sits beside
  opens a vaul drawer inside a Radix sheet — a composition this app has not used before and must be
  verified in a browser rather than reasoned about.
- Settings grows a tenth tab, and "promoted to the top" is a position that the next tab author will
  be tempted to take.
