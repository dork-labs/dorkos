---
id: 260730-182745
title: The stored response mode is projected onto ordered loudness rungs, and the UI writes one canonical value per rung
status: proposed
created: 2026-07-30
spec: room-details-sheet
superseded-by: null
---

# 260730-182745. The stored response mode is projected onto ordered loudness rungs, and the UI writes one canonical value per rung

## Status

Proposed.

## Context

`ResponseMode` stores five values — `always`, `engaged`, `direct-only`, `mention-only`, `silent` — and until now every UI offered all five as peer sentences that each began with "Replies". Nobody could rank them, and one of the five is a **behavioural alias**: `direct-only` means "mentioned by name" in a channel and "answers everything" in a direct message, so no single label can honestly cover it (`apps/server/src/services/rooms/addressing.ts`). Read as behaviour rather than as names, both room kinds have **four** distinct outcomes, not five, and the schema accepts every value in every kind — so a membership can hold one this room would never newly offer, set by a script, an older build, or an agent through the operator surface.

## Decision

We will treat the stored enum as a wire format and project it onto an ordered, four-position **loudness rung** — `silent` → `mention` → `engaged` → `everything` — in `entities/room/lib/response-mode.ts`, which becomes the one place that knows the behaviour table. `rungOf(mode, roomKind)` is **total**: every stored value lands on a rung in both kinds, so a value that is really there always renders somewhere. `modeForRung(rung)` writes **one canonical value per rung** and needs no room kind to do it, which means the UI never writes `direct-only` again — its meaning depends on where it is stored, and a control that writes it is a control whose consequence depends on a field the reader cannot see. Ordering is the mechanism, not decoration: position carries louder-than and quieter-than without help text, so both renderings (a segmented control above 768px, a list below) run quiet to loud.

## Consequences

### Positive

- **The behaviour table has exactly one reader.** `addressing.ts` is transcribed once, in one module, with a test that round-trips all five stored values in both room kinds — instead of each surface re-deriving what a mode means.
- **A stored value can always be seen and corrected.** Totality removes the class of bug where a setting that is really in the database renders as a blank control nobody can fix.
- **The alias stops multiplying.** With `direct-only` unwritable from any UI, the number of memberships whose meaning depends on their room's kind can only fall.
- **One model, two renderings, one test suite.** The phone's list and the desktop's segmented control share a value, a keyboard contract and a preview.

### Negative

- **A projection can drift from the thing it projects.** Adding a sixth stored value, or changing a behaviour by room kind in `addressing.ts`, silently makes the client wrong until this module is updated too. The mitigation is that this is the only place to update — and the table is quoted in its module doc so the divergence is visible in a diff.
- **`direct-only` becomes write-only history.** Existing memberships keep it and it still renders, but nothing new produces it, so the enum now has a value the product no longer creates. That is a migration we have chosen to defer rather than avoid.
- **The rung set is a client-side judgement about server behaviour, and we got it wrong once before merging.** The first implementation offered a direct message three rungs, on the inherited premise that its engaged window can never open. It is false: `engagementFor` runs for every room kind, mentions are offered in a direct message, and a **group** direct message is still `kind: 'dm'`, where people plainly do address each other by name. The premise came from the TSDoc on the retired `responseModeOptionsFor` in `main`, which is why it survived review — a wrong claim about the server, stated confidently in the client, propagated into a new model, and then into a spec written from that model. What shipped is **four in both kinds** (spec §2.1); the false claim is still in `main`, so the next reader there should not re-derive it. `PersonalityTab`'s copy of the same claim is corrected on this branch.
- **Four rungs is a ceiling the UI now imposes.** If a room kind ever genuinely gains a fifth behaviour, the scale, the meter and the aggregate all have to grow together.
