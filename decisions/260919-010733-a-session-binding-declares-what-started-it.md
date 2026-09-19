---
id: 260919-010733
title: A session binding declares what started it, and one mapping turns that into power
status: accepted
created: 2026-09-19
spec: null
superseded-by: null
amends: 260908-170643
---

# 260919-010733. A session binding declares what started it, and one mapping turns that into power

## Status

Accepted. Amends [260908-170643](260908-170643-rooms-are-an-unattended-surface-and-follow-the-operator-level.md)
(A room turn is an unattended surface and follows the operator's power level) by
replacing the MECHANISM two of its paragraphs describe. That ADR's decision is
unchanged and still governs: a room turn follows the operator's configured trust
stop, a bridged stranger's message does not, and a room conversation that already
has settings is untouched.

## Context

`RuntimeRegistry.persistSessionRuntime` is the one write that can seed a new
session's permission mode, and it took that decision as two OPTIONAL arguments:
an `interactive` flag and a mode an unattended caller had resolved for itself.
Optional made a caller who had not thought about power indistinguishable from
one with nothing to say, and three of the seven call sites passed neither. Each
caller that did care resolved its own answer at its own call site, which is how
rooms came to be the surface the `full-power-defaults` enumeration left out for
two weeks (DOR-1917). A new turn-starting surface would inherit whatever the
defaults happened to be rather than a decision somebody made (DOR-2105,
operator-approved 2026-09-18).

## Decision

We will make `persistSessionRuntime` take a REQUIRED, exhaustive `TurnOrigin`
union naming what started the session — `interactive`, `room` (carrying
`externalAuthor`), `schedule`, `relay-binding`, `agent-dm`, `connector-event`,
`test-harness` — and no caller will resolve a permission mode for the row again.
One mapping, `permissionSeedForOrigin` in
`apps/server/src/services/session/origin/turn-origin.ts`, turns an origin into
one of three policies, and the registry honours it:

| Origin                                         | Policy                      | The row gets                                      |
| ---------------------------------------------- | --------------------------- | ------------------------------------------------- |
| `interactive`                                  | `configured-stop`           | the operator's stop, on insert **and** on a claim |
| `room`, `externalAuthor: false`                | `configured-stop-on-insert` | the operator's stop, only on a row it mints       |
| `room`, `externalAuthor: true`                 | `none`                      | nothing (DOR-604)                                 |
| `schedule`                                     | `none`                      | nothing; a run's power is on its schedule row     |
| `relay-binding`, `agent-dm`, `connector-event` | `none`                      | nothing; each carries its own grant (DOR-604)     |
| `test-harness`                                 | `none`                      | nothing                                           |

The switch ends in a `never` binding, so adding a member fails the build until
somebody decides its power. A source census
(`session/origin/__tests__/turn-origin-call-sites.test.ts`) fails until a new
call site is written down with the origin it meant, which is what catches the
mistake types cannot: naming the wrong origin.

The two "configured stop" policies differ on one real case, and the difference
is the parent ADR's promise made mechanical. A row with no runtime yet, created
by a settings change made before the first message (DOR-812), is a person's own
row from their own sitting — so their binding write claims and seeds it, as it
always has. For a room the same row is evidence the conversation already exists,
so a room seeds only a row it mints.

## Consequences

### Positive

- A new turn-starting surface cannot compile without declaring itself, and
  cannot ship without somebody deciding what power it starts at.
- The origin→power answer is written once instead of being re-derived per call
  site, which is the shape that let rooms be forgotten.
- Each call site states a FACT it already holds and resolves nothing, so a
  caller can no longer be subtly wrong about the trust ladder.
- Behaviour is unchanged for every existing surface, including the pre-existing
  unbound row this ADR's own review caught.

### Negative

- The mapping now encodes WHEN as well as how much (`configured-stop` versus
  `configured-stop-on-insert`), which is one more thing a reader has to hold.
  The alternative was letting the origin carry a fact about the database row,
  which would have put DB state into a union that describes intent.
- A room turn still resolves the same stop a second time, for the turn it is
  about to start, because the row is written after the turn begins. Two callers
  of one pure function, not two answers, but it is not one call either.
- `TurnOrigin` members are bare discriminants where no field changes the answer,
  so a future reader wanting the room id or task id at the seam has to add it
  and thread it through. That is deliberate: a required argument nobody reads is
  a required argument callers guess at.
- **"Is this row new" is measured at a different moment than it used to be.**
  The room runner asked at the REQUESTED session id before the turn; the
  registry now asks at the id it is writing, which for claude-code is the
  canonical id the SDK minted. The two answer differently only when the
  settings re-key that moves the row to that id failed — a best-effort write
  that warns rather than throws (DOR-493) — and there a room would seed the
  fresh row on this design and would not have before. That is the more correct
  answer of the two (the row it seeds really is new), but it is a difference,
  and it is recorded rather than claimed away.
