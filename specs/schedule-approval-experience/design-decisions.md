# Design Decisions

Visual companion session: `.dork/visual-companion/46793-1787328179/`
Screen: `01-approval-experience.html`. All selections recorded in the
session's event log and confirmed verbally by the operator (2026-08-21).

## 1. What shape should the approval take?

**Options:** A) Join the Ask-card family — full card with face, summary,
cadence, first-run times, instructions reveal. B) Compact row that expands
in place. C) Row plus a dedicated review sheet with edit-then-approve.

**Chosen: A.** One family of "needs your judgment" cards, not three row
styles in one section. Reuses the Ask cards' receipt, keyboard, and motion
machinery. The sheet (C) was rejected as a second surface to design and
maintain; the expanding row (B) as two clicks to informed consent.

## 2. Capture who, why, and where from

**Options:** A) Full provenance — `tasks_create` gains a `reason` argument,
the proposing session id + agent identity are stamped on the row, the card
and notification say "«Agent» proposed a scheduled task" with a "View the
conversation →" deep link. B) Reason only, keep "An agent."

**Chosen: A.** Approval becomes reviewable evidence. The session id is
already resolved at the same construction site for the capability tools;
this wires the existing value through.

## 3. "Run it once"

**Options:** A) Ship with the new card. B) File as a follow-up.

**Chosen: A.** A third card action that runs the proposed prompt
immediately as a single supervised run — no timer armed, nothing approved.
The card live-updates ("Test run finished — view what it did →") and
Approve remains, now backed by evidence. Approval by demonstration is the
signature moment of this feature.

## 4. Polish set (multi-select)

**Selected:**

1. Reject stops being a silent hard delete — receipt beat with a held
   "Rejected · Undo," implemented as a deferred delete (the DELETE fires
   only after the undo window passes; undo cancels it). Approve gets
   "Approved — first run …".
2. Keyboard parity — A/D answer keys on schedule cards, same scoping as
   Ask cards.
3. Tighter popover copy — one honest line ("2 schedules want your
   approval"), no double explainer, no "requests waiting for your answer"
   mislabel.
4. Mobile a11y fix — section headings become `sr-only` below `md` instead
   of `hidden`, restoring them to the screen-reader tree.
5. Activity rows get faces — xs agent avatar wherever a row carries
   `agentId`.
6. Coalesce Activity bursts — "«Agent» finished 4 runs · 12m" with expand.
7. Motion parity — schedule cards get the answered-exit melt; the
   "All clear ✓" beat fades/rises instead of popping.
8. One source of "what's waiting" — unify the popover's aggregation with
   the sound/banner machinery's derivation.

**Explicitly deselected:** grouping duplicate same-name proposals (the
operator toggled it off after consideration — duplicates stay as
independent rows).

## Final Design Summary

A pending schedule renders as a card in the Inbox's "Needs You" section
(and the home triage surface) with: the proposing agent's face and name;
"from «session title»" linking to the originating conversation; the
agent's stated reason in its own words; the human-readable cadence with
timezone; the first few concrete run times; a collapsed "Show exact
instructions" reveal of the stored prompt; actions Approve / Reject /
Run it once, answerable with A/D; an optimistic receipt on decide
("Approved — first run today at 3:00 PM" / "Rejected · Undo") that melts
on the Ask cards' exit curve. Run it once executes the prompt now as one
supervised run and shows the outcome on the card with a link to what it
did. Server-side, proposals carry `reason`, `proposedBySessionId`, and the
proposer's agent identity; `schedule.parked` notifications are titled by
the real proposer. The popover's copy, mobile heading semantics, Activity
identity/coalescing, all-clear motion, and the single what's-waiting
derivation land as the polish wave.
