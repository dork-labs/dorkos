---
slug: room-details-sheet
id: 260730-112334
created: 2026-07-30
status: implemented
design-screens: ./design/ # committed here; the .dork/ session that made them is gitignored and local-only
---

# Specification: the room details sheet

- **Slug:** room-details-sheet · **Id:** 260730-112334 · **Linear:** DOR-756
- **Shipped** in [#636](https://github.com/dork-labs/dorkos/pull/636), merged to `main` as `bc9af5d09` on 2026-07-30. 45 commits. See [§12](#12-what-is-not-done) for what was deliberately left.
- **Anchor:** `origin/main` @ `377b11881`, 2026-07-30
- **Read first:** [`01-ideation.md`](./01-ideation.md) — the audit and the seven findings. [`04-design-decisions.md`](./04-design-decisions.md) — what was chosen in the visual session and why.
- **Governs:** `apps/client/src/layers/features/room-management/` (renamed from `room-membership`), plus named additions to `entities/room`, `entities/agent` and `shared/ui`.
- **Reconciled against the shipped branch, 2026-07-30.** This document was written before the work and building it proved parts of it wrong. Every signature, sentence and layer placement below has been read back off `feat/room-details-sheet` and corrected. Where the design was rejected during implementation, the rejection is recorded with its reason rather than the text being quietly deleted — a spec that agrees with the code by omission teaches nothing about why the code is the way it is. The corrections are collected in [§11](#11-what-implementation-changed) so a reader who knows the original can find them. **Reconciled a second time after an independent review of the branch**, which found six defects — all fixed, and this document describes the fixed code. Where it records a defect, that defect is history and says so.

## 1. The one-line statement

**A room sheet says who is in a room, how loud each of them is, and what the room is about — in one place, in one list, in plain words.**

## 2. The rung model (§3 of the ideation is the defect this fixes)

`entities/room/lib/response-mode.ts` is rewritten around **loudness rungs**. Position carries the meaning, which five peer sentences never could.

### 2.1 The rungs

| rung           | channel                                       | direct message                          |
| -------------- | --------------------------------------------- | --------------------------------------- |
| **Silent**     | `silent`                                      | `silent`                                |
| **@only**      | `mention-only` (and `direct-only` lands here) | `mention-only`                          |
| **Engaged**    | `engaged`                                     | `engaged`                               |
| **Everything** | `always`                                      | `always` (and `direct-only` lands here) |

**Four rungs in both kinds, because both kinds have four behaviours.** `direct-only` is the only genuine alias in the five, and what differs by room kind is which rung it lands on — `@only` in a channel, `Everything` in a direct message.

> [!NOTE]
> **The code does this. It did not for one commit, and the reason is worth keeping.**
>
> The first implementation gave a direct message three rungs (`DM_RUNGS`) and collapsed a stored `engaged` onto `@only` there. That was written from a premise this spec inherited from `main` — the TSDoc on the retired `responseModeOptionsFor` says the engaged window cannot open in a direct message "because nobody `@`s anyone in a two-person conversation" — and the premise is false:
>
> - `room-trigger.ts` computes `engagementFor` for **every** room kind. There is no channel gate.
> - `resolveMentions` is unconditional, and `RoomComposer` mounts the mention autocomplete with no kind gate, so the `@` palette is offered in a direct message.
> - Decisively, **a group direct message is still `kind: 'dm'`** — adding a second agent does not promote it to a channel. In a three-agent conversation people plainly do `@`-address each other, and the window opens exactly as it does in a channel.
> - Executed against `respondsTo` directly: `{ roomKind: 'dm', mentioned: false, isEngaged: true }` answers `true` for `engaged` and `false` for `mention-only`. They are not the same behaviour, so they may not share a rung.
>
> The table above is what shipped. The three-rung shape was the defect, and it cost more than a missing option: the rung that was already displayed as chosen fired a real narrowing write to `mention-only`, one-way, on a value the reader had not touched.
>
> The premise is still in `main`, on `responseModeOptionsFor`'s TSDoc. Whoever retires that file should not re-derive it. `PersonalityTab`'s response-mode select repeats it too; its comment is corrected, but whether an agent's manifest default should now offer `engaged` is a product question nobody has answered.

The old menu's real failure is therefore worse than "four options producing three": it withheld a behaviour a direct message genuinely has, so a bounded reply window was unreachable there by any means the UI offered.

### 2.2 The API

```ts
RESPONSE_RUNGS: readonly ResponseRungOption[]                      // { rung, label }, quiet → loud
rungOf(mode: ResponseMode, roomKind: RoomKind): ResponseRung        // total — never null
modeForRung(rung: ResponseRung): ResponseMode
explainRung(
  rung: ResponseRung,
  roomKind: RoomKind,
  window: EngagedWindow | null
): { sentence: string; note: string | null }
levelOfRung(rung: ResponseRung): 1 | 2 | 3 | 4                      // shared with the meter
```

`note` is `string | null` rather than optional, and the field is `sentence` rather than `headline`. Both are the same decision twice: a caller renders the second line when there is one and renders nothing when there is not, and an absent key and a null are two ways of saying that which every call site would have to handle separately. `EngagedWindow` is derived from the wire contract (`NonNullable<ServerConfig['rooms']>`) rather than restated, so this and `GET /api/config` cannot drift apart on a field name.

**Neither the rung list nor the write reads the room kind, and only `rungOf` does.** `RESPONSE_RUNGS` is a constant because both kinds offer the same four; `modeForRung` takes no kind because four of the five stored values mean the same thing wherever they live and the fifth is the alias nothing writes. That leaves exactly one function that has to know what kind of room this is, which is one fewer place to project through the wrong one.

`rungOf` is **total**. Every stored value maps to a rung in both room kinds — `direct-only` is the one that lands differently, and nothing writes it any more, so it is a value that can only be read. A control that renders blank for a value that is really there is a setting nobody can fix. The implementation this replaces had the same instinct (`responseModeOptionsFor` widened rather than narrowed for a stored value) and it survives the rewrite.

### 2.3 The copy

Real numbers, from the operator's own config, never invented. **As shipped**, exactly:

| rung           | sentence                                                                                                                   | note                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Silent**     | `Never speaks here`                                                                                                        | `You can still talk to it in its own session.`     |
| **@only**      | `Answers only when you @mention it.`                                                                                       | none                                               |
| **Engaged**    | `Answers when you @mention it — then keeps answering for {N} more minutes or {M} more messages, whichever runs out first.` | `Then it goes quiet again until you say its name.` |
| **Everything** | channel: `Answers every message in this room.` · DM: `Answers every message you send here.`                                | none                                               |

Three details the original draft did not have:

- **`Everything` names the room it is in.** The draft had one sentence for a channel and "Answers you every time" for a DM. Both shipped differently, and the difference is the point: in a channel the claim is about _every message_, in a DM it is about _every message you send_, because in a two-person conversation those are the same set and saying "in this room" would be pointlessly formal.
- **`@only` has no second line, in either kind.** It carried one in a direct message — "In a conversation this small, that means it mostly stays quiet" — which existed because `engaged` used to land on this rung there. That is the §2.1 premise in miniature: it predicts how a small room behaves, and a direct message holding three agents does not behave that way. The sentence above is exact in both kinds and needs no help.
- **`Engaged` has three answers, not one.** Real numbers when the window is readable; the shape of the rule with no numbers in it while the config read is still in flight (`window === null`); and, when either ceiling is `0`, `Answers when you @mention it, and stops as soon as it has.` with the note `The engaged window is switched off on this DorkOS, so this behaves like @only.` Both ceilings have to hold for the window to be open (`services/rooms/engagement.ts`), so a zero in either one is a rung that silently behaves as its neighbour — and a control with two rungs doing the same thing has to say so.

**Constraint:** if the window numbers cannot be read from config, the UI must not silently substitute 10/5 — an operator may have changed them and the sentence would then be false. This is the `window === null` row above.

`explainRung` answers for the rung it is asked about, in the kind of room it is asked in. It used to answer a direct message's `engaged` with the `@only` sentence — a description that was false of the membership it was describing — and that branch went with the §2.1 defect. Totality is `rungOf`'s job: it is what guarantees the rung reaching here is one the room draws.

## 3. Room loudness

New pure module `entities/room/lib/loudness.ts`.

```ts
roomLoudness(
  members: readonly RoomRosterEntry[],
  roomKind: RoomKind
): { level: 0 | 1 | 2 | 3 | 4; sentence: string; detail: string | null }

previewLoudness(
  members: readonly RoomRosterEntry[],
  roomKind: RoomKind,
  authorId: string,
  rung: ResponseRung
): same shape
```

**`roomKind` is an argument, and leaving it out of the draft was a real defect, not a typo.** Two of the five stored values change behaviour by room kind (§2.1), so an aggregate computed without it reports the wrong number for any roster holding one: a `direct-only` membership is `Everything` in a direct message and `@only` in a channel. The signature that omits the kind is one that cannot be right in both.

`level` is `0` only when there is **no agent at all**. Zero is its own answer and not "quiet" — an empty meter means there is no scale to be at one end of. Every other level is the position of the **loudest** agent present, because that is the one that decides what the room feels like.

### 3.1 The sentences, as shipped

| level                       | sentence                                        |
| --------------------------- | ----------------------------------------------- |
| `0` — no agents             | `There is nobody here to answer you`            |
| `1` — every agent Silent    | `Nobody here will answer you`                   |
| `2` — loudest is @only      | `Only @mentions get an answer here`             |
| `3`/`4` — somebody answers  | `{Count} agent(s) will answer you here`         |
| `3`/`4`, all of them louder | `{Count} agent(s) answer(s) every message here` |

The draft's "Nobody here will answer on their own" did not ship. "On their own" is the same evasion the old `silent` label ("Never replies on its own") was retired for — it implies the agent replies some _other_ way.

Two shapes the draft did not have at all:

- **The empty room says something different from the silent room.** `There is nobody here to answer you` and `Nobody here will answer you` are different facts with different fixes, and one sentence for both would send a person looking for a setting that is not the problem.
- **An all-`Everything` group gets its own sentence.** `Two agents answer every message here` rather than `Two agents will answer you here`: at level 4 the second is true but uselessly weak, and the difference between "will answer you" and "answers every message" is exactly the thing somebody opening this panel about a noisy room is trying to find out. Counts read as words up to nine, then as digits, and the verb agrees with the count.

`detail` names the exception **only when there is exactly one** — `Kai only when @mentioned`, `Kai never speaks here`. Two exceptions are a list, and a list of exceptions is the wall of peer sentences this aggregate exists to replace. Humans contribute nothing; they are never triggered.

`previewLoudness` **is the same function** as the real computation, differing only in its hypothetical input — one member's rung swapped before the shared computation runs, never a second reading applied afterwards. It also puts the hypothetical rung through the same round trip a real write takes (`modeForRung` then `rungOf`), so a preview always reports the rung the room would actually end up on rather than the one that was asked for. That round trip is the right design at any rung set; what it currently rounds `engaged` to in a direct message is the §2.1 defect and moves with it.

## 4. Identity: one disc, one badge, three tiers of truth

### 4.1 The badge slot

`shared/ui/identity-avatar.tsx` gains `badge?: ReactNode` — a corner glyph, bottom-right, ringed in the page background.

It must live in `shared` because **`entities/room` may not import `entities/agent`** (the sibling-entity rule), which is precisely why rooms once invented a second identity system. The _decision_ of which badge to pass lives in the feature layer, which can see both.

**Convention, to be encoded in the TSDoc: agents carry the glyph, people carry nothing.** Absence is the signal, so a roster of humans stays visually quiet. This is designed now, before mixed rosters exist, so that the day people join a room nothing has to be redesigned. Prior art: Buzz, whose NIP-OA binds an agent key to the human who vouches for it.

### 4.2 Visual source — three tiers, ordered by freshness

1. The **resolved manifest** visual (`resolveAgentVisual(manifest)`) — the source of truth.
2. The **author render cache** (`author.emoji` / `author.color`) — a cache, and it goes stale on rename.
3. A **neutral letter disc** when the agent cannot be resolved at all.

Tier 3 is a rule, not a fallback of convenience: hashing the agent's _path_ would produce a confident face that differs from the one every other surface draws. A visibly-unknown agent is honest; a wrong one is not.

### 4.3 `AgentPickerCandidate` carries the visual

Widened in `use-agent-picker-candidates`. One change fixes three things: the faceless picker (finding 2.4), the roster's stale faces, and the third copy of visual resolution living in `features/tasks/ui/AgentPicker.tsx`, which is deleted in favour of the candidate.

**As built the shape is `visual: AgentVisual | null` plus `description: string | null`, not the drafted `color` / `emoji` / `resolved: boolean`.** One nullable object rather than three parallel fields, because the three could disagree — a `resolved: true` beside a missing colour is a state with no meaning, and every consumer would have to decide what to do about it. `null` says "we do not know what this agent looks like" once, and every picker draws a letter for it.

`description` is the agent's own words from the same manifest the face comes out of, and it is `null` rather than `''` on purpose: a picker draws a second line for a description and draws **no** second line for the absence of one, and an empty string sliding through as a value is how a list grows a column of blank lines that push everything apart for nothing.

### 4.4 The picker is alphabetical, and that is a conclusion

Not a default, and not an ordering nobody got to. Recently-used-first is the obvious improvement and the cockpit has **no honest signal for it**:

- `RoomSummary.participants` is carried for direct messages only and is `null` for every channel, always — the server resolves it for `kind === 'dm'` and nothing else. An order built on it would be _direct messages_ wearing the word "rooms", and would rank an agent sitting in six channels at zero.
- `agentActivity` on the recent-sessions read is an agent's latest session `updatedAt` across sessions of any origin. It cannot tell a room turn from a coding session opened against the same directory, and it is only warm while the dashboard sidebar is mounted — so the same picker would offer two different orders depending on which door you came through.
- Per-room rosters would answer it exactly, at one request per room.

So the list is ordered the way `useRooms` orders channels, for the same reason: a list that stops moving is one you learn, and you can hit the same row without reading it. An order that _looked_ meaningful and was not would be worse than this one. Sorted by the name on screen rather than by path, with `localeCompare`, so accented names land where a person expects them.

## 5. The sheet

### 5.1 Structure

```
┌─ RoomDetailsHeader ─────────────────────────┐
│  # testcwd                     [Archived]   │  ← name, inline-editable
│  Clicker planning — add a topic             │  ← topic, inline-editable (channels only)
├─────────────────────────────────────────────┤
│  ▁▃▅  Two agents will answer you here       │  ← RoomLoudnessLine
│       Kai only when @mentioned              │
├─ PEOPLE 1 ─────────────────────────────────┤
│  ● Dorian (you)          joined 4 days ago  │  ← the reader IS in the roster
├─ AGENTS 2 ─────────────────────────────────┤
│  ⌁ Mio Clicker PM        [▁▃▅ Engaged] ⋯    │  ← RoomMemberRow
│    ╰ expanded: ResponseModeControl          │
│  ⌁ mio-click-code        [▁▃▅ Engaged] ⋯    │
│  + Add agents                               │  ← AddMembersRow, a row not a panel
├─────────────────────────────────────────────┤
│  Created 4 days ago          Archive room   │  ← footer
└─────────────────────────────────────────────┘
```

Two things the draft drew that are not there, and one it drew wrongly:

- **"Owner of this room" does not exist, on any row.** There is no owner field anywhere — not on `RoomRosterEntry`, not on the membership, not on the room. It is a **dependency of the mixed-roster future**, not a row feature that was cut: the day a room holds somebody else's agent, the relationship has to be modelled on the server before any row can print it. §5.4 records the same thing about "managed by {person}".
- **The add row says "Add agents", never "Add people or agents".** `transport.addRoomMember` reaches agents and nothing else: the client sends an `agentPath`, and the picker it opens is the fleet. (The request schema also accepts an `authorId` for an author row that already exists — which is how a removed agent is put back — but there is no path by which a person is added.) Offering to add people would be a control that cannot do what it says.
- **The roster is grouped, with a count per group**, rather than carrying one total in a section header. People first, then agents. One list, two headings — never tabs.

### 5.2 Components

**As built.** Three components the draft put in the feature layer are entity components, and the difference is not filing: anything in `entities/room` may be drawn by any feature, and all three are about a _room_ rather than about managing one.

| Component                                               | Layer                          | Responsibility                                   |
| ------------------------------------------------------- | ------------------------------ | ------------------------------------------------ |
| `RoomDetailsDialog`                                     | features/room-management       | Shell, `focus` routing, Escape orchestration     |
| `RoomDetailsHeader`                                     | features/room-management       | Name + topic inline editing, archived badge      |
| `RoomDetailsFooter`                                     | features/room-management       | Created-at, archive / bring-back                 |
| `RoomMemberList`                                        | features/room-management       | Grouping, counts, arrival and departure motion   |
| `RoomMemberRow`                                         | features/room-management       | One member, all variants                         |
| `RemoveMemberConfirm`                                   | features/room-management       | Inline confirmation                              |
| `AddMembersRow`                                         | features/room-management       | Collapsed row → inline picker                    |
| `AgentRosterPicker`                                     | features/room-management       | The picker's loading / failed / empty provenance |
| `InlineTextField`                                       | features/room-management       | Press-to-edit line, shared by name and topic     |
| `RoomLoudnessLine`                                      | **entities/room/ui**           | Aggregate meter, sentence, preview state         |
| `ResponseModeControl`                                   | **entities/room/ui**           | The rung scale + explanation, both renderings    |
| `LoudnessMeter`                                         | **entities/room/ui**           | Four ascending bars, presentational              |
| `loudness.ts`, `response-mode.ts`, `presence-copy.ts`   | entities/room/lib              | Pure derivations                                 |
| `member-line.ts`                                        | features/room-management/lib   | The second line's priority order                 |
| `use-room-details-view` / `-writes` / `room-details.ts` | features/room-management/model | Reads, writes, and the `focus` type              |

`presenceElapsed` lives in **`entities/room/lib/presence-copy.ts`**, not beside the composer in `widgets/room-view/lib`, because two surfaces now print it — the line under the composer and each member's row — and a room that says `4m` in one place and `4m 12s` in the other is telling a person two different things about one turn.

`RemoveMemberConfirm` is a separate module but is **rendered inside `RoomMemberRow`'s own subtree, by force rather than by taste**. It was a `Dialog` first, and a dialog over a dialog closed _both_ when it was answered: the inner one's dismissal reaches the outer as an interaction from outside it. Only a real portal reproduces that, so no jsdom test could have caught it. The same constraint is why "Create agent" closes the sheet before opening the creation dialog, and why Escape is handled on the sheet rather than on the confirmation — Radix listens for Escape on the document in the capture phase, so a handler further down the tree runs after it has already decided to close.

The composed shell stays well under 300 lines. That is the point of every extraction.

### 5.3 The `focus` prop

`intent: 'roster' | 'add'` becomes `focus: 'members' | 'add' | 'topic'`. It stops being a wart and becomes **deep-linking**, which spec `rooms` §14.5 explicitly asks for: "new channel, new DM, add agents, and members should all be palette-reachable and openable by URL."

### 5.4 The member row

Anatomy: disc + badge + live dot → name (with "(you)") → secondary line → loudness pill → `⋯`.

Secondary line, in priority order, and **it never claims something unverifiable**:

1. `"working now"` / `"still working, {elapsed}"` — from `useRoomPresence`
2. `"last spoke {relative}"` — **only** when a post by that author is visible in the loaded entries page
3. `"joined {relative}"` — from `roomMembers.joinedAt`, always true and always present

**"hasn't spoken here yet" is forbidden.** The room's history reader returns only the trailing page, so an agent that spoke five hundred messages ago reads exactly like one that has never spoken, and the row would print a libel about an agent that has been talking all week. Absence of a last-spoke line is the honest signal.

**The last-spoke line reads `useLoadedRoomEntries`, never `useRoomEntries`,** and the distinction is load-bearing rather than stylistic. `useLoadedRoomEntries` is an `enabled: false` observer: it reads whatever is already in the cache for that key and fetches nothing. A second _active_ observer on `['rooms', 'entries', id]` starts a background refetch, and that refetch's response lands on top of entries the room's SSE stream has already merged in — so opening this sheet would silently roll a live room's history back to whatever the server last returned. The sheet is a decoration on that cache entry and may not own it.

`"managed by {person}"` **ships as nothing.** There is no owner on the roster entry, the membership or the room, so there is no reader-versus-owner comparison to make and no name to print. Recorded here as the same dependency §5.1 names: it is the first thing the mixed-roster future needs modelled on the server, not a row feature that was descoped. Until then, absence is not the signal — there is simply no fact.

### 5.5 Presence, and its honest limit

`useRoomPresence` is fed by the room SSE stream, which `ChannelsPage` subscribes **for the room currently on screen**. Open the sheet from the sidebar over a room that is not open and there is no stream, therefore no presence.

The line is shown when presence is available and omitted silently otherwise. **A second stream must not be opened to decorate a dialog.**

## 6. Behaviour

| Concern           | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mode write**    | Optimistic on `roomKeys.detail(roomId)` — cancel, snapshot, write, rollback on error, settle. Pill dims in flight. **Never invalidate `roomKeys.all`**: it prefix-matches `['rooms','entries',id]` and would clobber SSE-delivered entries with a stale GET. Both existing roster hooks warn about this.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Confirmation**  | The meter moving _is_ the confirmation. No success toast for a setting the reader is watching change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Removal**       | The existing inline confirm, extracted unchanged, plus **Undo** — which restores the response mode it had, captured before the write. Without that, "undo" silently resets the agent to the server's join-time seed. The offer is raised from the mutation's own promise rather than a per-call `onSuccess`: one observer serves every row and holds one callback slot, so a second removal started before the first landed took the first agent's way back with it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Archived room** | Badge; one banner **in place of the loudness line**, not beside it — "Nobody is triggered in an archived room, so its members and their settings are on hold. Bring it back to change them." The aggregate sentence would be false there ("Two agents will answer you here" of a room that answers nothing), so it is replaced rather than greyed. Meters go dormant (grey, still showing the stored rung), rungs carry `aria-disabled` rather than `disabled` — a disabled button leaves the tab order, so the reason a screen reader was given would sit on a control it can never reach — with the banner as their `aria-describedby`, and "Bring this room back" in the footer. No preview is offered at all: there is nothing true to show. **The roster is held with the settings** — no add row, no "…" menu, no touch-path Remove — because adding names no `responseMode` and the server seeds one, so remove-then-add here would rewrite a deliberate `Silent` into `engaged` in the room the banner says nothing can be changed in. |
| **DM**            | Four rungs, the same as a channel (§2.1 — the shipped three is a defect). Adding says "Adding a second agent turns this into a group conversation" **before** the act. No topic affordance — a DM is anchored to a participant, not a subject (spec `rooms` §14.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Empty room**    | The picker opens expanded and focused, under the create dialog's already-reviewed line: "a channel with nobody in it has nobody to answer you."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Fleet empty**   | A route to making an agent, not a dead end.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Roster failed** | "Try again" calling `refetch`, matching the fleet picker beside it. The human is not the retry button. Keep "Everyone is still where they were."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 7. Motion

All of it explains; none of it decorates. Every item degrades under `prefers-reduced-motion` by **snapping, never by disappearing** — a motion preference must not remove information.

| Interaction              | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hover / focus a rung** | The room's own meter slides to what it _would_ become and the sentence rewrites, tinted as hypothetical. Leave and it slides back. Powered by `previewLoudness`. **Keyboard parity is mandatory** — arrowing the rungs previews exactly as hovering does.                                                                                                                                                              |
| **Commit a rung**        | Member meter and room meter animate together on **one named 150ms** duration (`BAR_TRANSITION`), not the 120ms drafted. The number matters less than its being one number: two durations would be two gestures that happen to be near each other rather than one system moving.                                                                                                                                        |
| **Agent added**          | The row opens its own height (150ms) and washes brand once (0.16 opacity, fading over 900ms). The wash is the slow half deliberately — the height change is the arrival, the wash is which one arrived, and a person needs longer to find it than to see it move. **The roster you open the sheet on must not perform**: `AnimatePresence initial={false}` reaches the wash as well as the row, through React context. |
| **Agent working**        | Not `AgentAvatar`'s pulse, which the draft assumed. This row draws the **identity** disc, and a room's working signal is a different fact from an agent's mesh health — so the row carries its own green dot with the same `animate-ping`. `motion-reduce:hidden` drops the ping and keeps the dot, so the fact survives the preference and only the motion goes.                                                      |
| **Row expand**           | Height transition 150ms, caret rotates. The clip that animation needs is `overflow-hidden`, which is why the region carries bottom slack for the last control's focus ring.                                                                                                                                                                                                                                            |
| **Removal**              | Row height collapses to zero so the Undo toast has a referent.                                                                                                                                                                                                                                                                                                                                                         |

House limits: 100–300ms, `motion` is the library, `focus-visible` only.

## 8. Dev playground

A new **`rooms`** page at `/dev/rooms` — not a `community` page. Every playground page is named for what you see (chat, marketplace, tables, onboarding); `CommunityAdapter` is a port, and naming a page after plumbing is how a playground stops being a mirror of the product. Rooms grows a section when outside members land.

Every cell of the state gallery becomes a showcase — the sheet's states, the row's variants, all rungs in both room kinds, the meter at every level and size, the picker's five states, and the removal confirm. Mock factories live beside the existing ones in `dev/mock-factories.ts`; **no showcase may need a server.**

**One cell of the gallery was not shipped, deliberately: a member row reading "couldn't read this agent".** The row for an unresolvable agent _is_ there — it draws a letter on a neutral disc, never a hashed face — but it does not say so in words. It cannot: at row level, "this agent's manifest failed to resolve", "the fleet is still loading" and "the mesh read failed" are indistinguishable, and in the second and third of those **every row on screen would libel its agent**. The provenance of that answer is knowable one level up, in `AgentRosterPicker`, which is exactly where the three states are told apart — so that is where the sentence lives, and the row stays quiet and honest. Its second line falls back to `joined {relative}`, which is always true.

## 9. What this retires, and what it does not

**Retired:** `RoomTopicDialog` and its test, deleted. A modal for one text field, opened from a menu, over a room already on screen, is scaffolding.

**Kept, deliberately** (operator decision): inline rename on the sidebar row, which matches the group-rename gesture already there; and the archive `AlertDialog`, which is the right pattern for a destructive confirm. The sheet adds a second door to each.

**Not touched:** `widgets/room-view/ui/RoomTimeline.tsx`. DOR-731's entry action menu is in flight on that file, and the standing rule for this surface is never two writers on the timeline.

## 10. Verification

- Unit: the rung model round-trips all five stored values in both room kinds; **both kinds yield four rungs** (§2.1); no two rungs in one room kind share an explanation; pressing the rung already chosen writes nothing; optimistic rollback leaves the **true** value on screen; Undo restores the captured mode — including for two removals confirmed before either resolved; an archived room offers neither add nor remove; the unresolvable agent draws a letter.
- Every assertion must be able to fail — state what product change makes it red, then prove it by breaking the behaviour. jsdom reports every element as 0×0, so nothing geometric is settled there.
- Browser: the segmented control does not truncate at its indent; the confirmation does not close the sheet (only real portals reproduce that); focus lands correctly from all four entry points. Plus the geometry jsdom cannot see at all — the preview transition and its reduced-motion snap, the two meters moving on one duration, the arrival wash firing for a new row and **not** for the roster the sheet opened on, a removed row collapsing under a live Undo, focus rings surviving the two `overflow-hidden` clips, the working dot's ping surviving the row's clip, and at 390×844: the sheet inside `max-h-[85vh]` with a pinned header and footer over a scrolling body, measured touch targets, vaul's dismiss not firing over the roster's own scroll, and a long description truncating rather than reflowing the picker.
- The panel is walked in a real cockpit at desktop and 390px before the PR claims anything. Two defects on this surface shipped green and were caught by a screenshot.

**Two things a browser cannot settle here, stated rather than faked:**

- **Real safe-area insets.** Headless Chromium reports `env(safe-area-inset-*)` as `0`, with no supported override, so the home-indicator gap cannot be measured and a test asserting it would be asserting `0 === 0`. What the suite checks instead is the shape of the rule that produces the gap: exactly one declaration inside the drawer pads for it, so there is nothing to double. The pixel remains a device check.
- **Touch-drag scrolling.** A mouse drag inside an `overflow-y: auto` box scrolls nothing in any browser, so "the roster scrolled instead of dismissing" splits into two claims: the wheel proves the roster is the scrolling region, and a pointer drag proves vaul does not dismiss over it. Both can fail; neither is the other.

## 11. What implementation changed

Collected so a reader who knows the original draft can find the corrections. Everything here is read back off `feat/room-details-sheet`; the two open items are named as open.

| §   | The draft said                                                           | What is true                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | A direct message offers **three** rungs, because it has three behaviours | **Four, in both kinds.** The premise was inherited from `main` and is false — `engagementFor` runs for every room kind, mentions are offered in a direct message, and a group DM is still `kind: 'dm'`. It shipped as three for one commit and was corrected before merge. |
| 2.2 | `explainRung → { headline, note? }`                                      | `{ sentence, note: string \| null }`                                                                                                                                                                                                                                       |
| 2.3 | One `Everything` sentence; DM reads "Answers you every time"             | Two sentences, naming the room they are in. `Engaged` has three answers, not one.                                                                                                                                                                                          |
| 3   | `roomLoudness(members)`                                                  | `roomLoudness(members, roomKind)` — the kind is an input, not a detail                                                                                                                                                                                                     |
| 3   | "Nobody here will answer on their own"                                   | `Nobody here will answer you`, and a separate sentence for a room with no agents at all. An all-`Everything` group gets its own shape.                                                                                                                                     |
| 4.3 | Candidate carries `color` / `emoji` / `resolved`                         | `visual: AgentVisual \| null` plus `description: string \| null`                                                                                                                                                                                                           |
| 5.1 | "Owner of this room" on the reader's row                                 | Ships as nothing. No owner field exists anywhere — a dependency of the mixed-roster future.                                                                                                                                                                                |
| 5.1 | "Add people or agents"                                                   | **"Add agents".** `addRoomMember` reaches agents and nothing else.                                                                                                                                                                                                         |
| 5.2 | `RoomLoudnessLine`, `ResponseModeControl` in the feature layer           | All three loudness components are in `entities/room/ui`; `presenceElapsed` is in `entities/room/lib`                                                                                                                                                                       |
| 5.4 | "last spoke" from `useRoomEntries`                                       | `useLoadedRoomEntries` — a second active observer would refetch over SSE-merged entries                                                                                                                                                                                    |
| 5.4 | "managed by {person}" when the owner is not the reader                   | Ships as nothing; see 5.1                                                                                                                                                                                                                                                  |
| 6   | Archived banner beside the loudness line                                 | **In place of it** — the aggregate sentence would be false there                                                                                                                                                                                                           |
| 7   | Commit animates over 120ms                                               | 150ms, and one named duration shared by both meters                                                                                                                                                                                                                        |
| 7   | The working pulse is `AgentAvatar`'s                                     | The row draws the identity disc and carries its own dot; a room's working signal and an agent's health are different facts                                                                                                                                                 |
| 8   | A gallery cell reading "couldn't read this agent"                        | Not shipped. Indistinguishable at row level from a loading or failed fleet, in both of which every row would libel its agent.                                                                                                                                              |

Three decisions taken during implementation that the draft did not anticipate:

- **`LoudnessMeter` has no third size for the preview.** A taller meter says _louder_, and the preview's job is very often to report the **same** level — a room with an `Everything` agent in it does not get quieter because one other agent does. A mark that grew anyway would answer wrongly in exactly the case the preview is most worth having. Height is loudness, so nothing else may change it; that a reading is hypothetical is said in words and in the tint around them.
- **Both renderings of the rung scale run quiet → loud.** The phone's list shipped reversed for one commit, on the argument that the meter's bars grow upward. The argument dies at a window resize: the same four options would physically turn over as the layout crossed 768px. One control, one direction.
- **44px per rung is a sub-768 requirement, not a global one.** The phone's list rows are `min-h-12`; the desktop segments are `h-9`, which is a pointer target and not a thumb's.

**Two touch targets missed 44px, and a browser is the only thing that could have said so.** Both were arithmetic that read as correct for as long as nobody put a ruler on it, and jsdom reports every box as 0×0, so no unit test could ever have caught either.

- **The loudness pill measured 42px.** Its reach comes from an invisible `::after` outset, and an absolutely positioned pseudo-element is inset from its containing block's **padding** box — so the pill's 1px border eats a pixel at each end and `-inset-1.5` buys 10px, not 12. Fixed to `-inset-[7px]`, which measures 44.
- **The chip's remove button measured 39px.** Here the reach could not grow: the dead space between one chip's button and the next wrapped row's is 12px, so 6px each way is exactly half and two adjacent targets meet without overlapping. The 7px that would have lifted a 30px button to 44 makes them overlap by 2px — and a tap in that overlap deletes the wrong agent, which is the incident the surrounding comment already records. **So the size grew instead of the reach**: `p-2` → `p-2.5` makes the button 34px, and 34 + 6 + 6 is 46.

The general lesson is the second one: when a hit area is short, the fix is the control's own size unless there is provably dead space to reach into. Reach that overlaps a neighbour is worse than a small target, because a small target is a missed tap and an overlapping one is the wrong action.

**Nothing is open.** The three items this section listed as open — the direct-message rung set, the `@only` DM note, and `explainRung`'s DM branch — are all in §2.1 and §2.3 as they now ship. Three more the review found afterwards are fixed with them: two removals in flight lost the first one's Undo (one mutation observer, one slot for per-call callbacks); an archived room let you add an agent under a banner saying its settings were on hold; and pressing the rung already displayed as chosen fired a real write.

---

## 12. What is not done

This section is for whoever picks this up next. Everything above describes what shipped; this is what did not, and why.

**Nothing here was ever looked at by a person.** The browser suite measures geometry and `/dev/rooms` makes every state reachable without a server, but no human eye has compared the shipped sheet against the design screens. That is a real gap on this repo, not a formality: the room message toolbar shipped visually broken past all-green Playwright specs, because position and clickability both survive a broken appearance. **Open `/dev/rooms` beside [`./design/`](./design/) before trusting this.**

**Filed as follow-ups, deliberately out of scope:**

|             |                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DOR-771** | `Button size="sm"` is 40px on touch app-wide, not 44. Forking the design system for one surface was the wrong fix; changing it globally has visual blast radius across every screen. There is a working ruler to verify against — `apps/e2e/tests/rooms/room-sheet-helpers.ts` binary-searches `elementFromPoint` to sub-pixel precision. |
| **DOR-772** | A direct message's title does not follow its roster. Add a second agent to a conversation called "Ana" and it stays "Ana" while the avatar becomes a stack — while the sheet's own copy says adding a second agent turns it into a group conversation.                                                                                    |
| **DOR-773** | `PersonalityTab`'s response-mode select still withholds `engaged`. Its justifying comment is corrected here; whether the select should now offer it is an open product question.                                                                                                                                                          |

**Known, unfiled, and small:**

- **Concurrent rung changes share one mutation observer**, so the in-flight dim can move off a row early when two are changed at once. Values are never wrong — the cache carries both — but the feedback can be. Documented in `use-room-details-writes.ts`.
- **You can still add and remove members in an archived room's roster via the API**; the sheet holds both, but the server does not (`room-service.ts` checks `archived` only on `post` and `notice`). The UI is the only guard.
- **The picker is alphabetical, not recency-ordered.** `RoomSummary.participants` is `null` for every channel by design, so there is no honest recency signal to sort by. The whole investigation is recorded in `agent-choices.ts` so nobody redoes it — do not "fix" this without a new data source.
- **`ResponseModeControl`'s touch rendering cannot be seen from the playground's viewport toggle.** The toggle clips a wrapper div while `useIsMobile` reads real `matchMedia`, so the below-768px list can only be reached by narrowing the actual browser window. That is a playground limitation affecting every media-query-driven component, not this one.
