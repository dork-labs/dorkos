---
slug: room-details-sheet
id: 260730-112334
created: 2026-07-30
status: specified
design-session: .dork/visual-companion/27428-1785409067
---

# Ideation: the members panel, audited against the real thing

- **Slug:** room-details-sheet
- **Id:** 260730-112334
- **Linear:** DOR-756
- **Anchor:** `origin/main` @ `377b11881`, 2026-07-30.
- **Method:** the audit was performed against a **screenshot of the running cockpit** (`#testcwd`), not against the source. Three of the seven findings do not exist in the source at all — they exist only in the rendering. This is the method spec `rooms` §14.5 mandates for this surface, after two defects shipped that every test passed and a screenshot caught instantly.

## 1. What the panel is

`RoomMembersDialog` (`apps/client/src/layers/features/room-membership/ui/`) is the surface spec `rooms` §14.3 asked for. Three entry points reach it: the sidebar row's "Members…" and "Add agents…", the open room's header roster, and the empty state. It is the first and only UI ever to touch the per-room `responseMode` override — a field the schema has carried since R1, changeable before this only by editing the database.

It is well engineered. The partial-failure behaviour in the add flow, the inline removal confirmation, the three-state fleet roster, and the keyboard contract in `AgentChipPicker` are all better than they need to be, and several carry comments recording the exact bug they fix. **None of the findings below are about care. They are about what the panel is a panel of.**

## 2. The seven findings

### 2.1 The setting outweighs the person

A member's name is 14px beside a 24px disc. The response-mode dropdown beneath it is 36px tall, full-bleed and bordered. The eye lands on the control, not on whom it belongs to. In a panel called _Members_, the member is the smaller element.

### 2.2 Two identical sentences, stacked

In the captured room both agents read "Replies while it is in the conversation" — twenty-four repeated characters of low-contrast text, twice, telling the reader nothing about the difference between these two agents, because there isn't one. Sameness should be silent; only difference deserves ink.

### 2.3 Two headings, two explanations, one dialog

"Who is in here, and when each agent replies", then a rule, then "Add agents", then "They join here and can read everything already said." The panel explains itself twice because it is two panels. The `intent` prop exists precisely because it cannot decide which half it is, and focus has to be argued about in a thirty-line comment.

### 2.4 The add list is a directory listing

The worst thing on screen, and invisible in source. Every project folder the operator owns, alphabetically, in plain text, **with no faces at all**:

> 144mono · 144x.co · ab-monorepo · AgentFS · Alpha Remount Agent · API Server · Art Blocks Analytics …

Numbers sort first. There is no recency, no grouping, no "agents you actually use". Ten directories away, `features/tasks/ui/AgentPicker.tsx` renders the same fleet **with** avatars. This is the file system leaking into the product.

### 2.5 The heaviest element is the one you cannot press

The "Add agent" button is full-width, mid-grey, bottom-anchored, and disabled. It reads as the dialog's primary action. The two things the reader actually came to do — change a mode, remove someone — carry no visual weight at all.

### 2.6 You are not in the room

No count, and the human — the person reading — appears nowhere. The panel answers "who is in here?" with a list that omits the reader and does not total itself.

### 2.7 Nothing says whether the room is fine

The reason a person opens this panel is "this room is too loud" or "nobody answered me". Two agents in the loudest useful mode is the most consequential fact on the screen, and it is expressed as two identical grey sentences the reader must find and compare unaided.

## 3. The core defect: five options, and nobody can rank them

The mode menu offers five sentences that all begin with "Replies":

| label                                   | stored         |
| --------------------------------------- | -------------- |
| Replies to everything                   | `always`       |
| Replies while it is in the conversation | `engaged`      |
| Replies when spoken to directly         | `direct-only`  |
| Replies only when @mentioned            | `mention-only` |
| Never replies on its own                | `silent`       |

They _are_ ordered loudest-to-quietest in code. Nothing on screen says so: no scale, no grouping, no numbers. The middle three are indistinguishable without knowing the addressing engine, and "on its own" implies the agent replies some other way.

**Worse, two of the five are aliases whose behaviour changes by room kind.** From `apps/server/src/services/rooms/addressing.ts` and `engagement.ts`:

| stored        | in a channel                | in a DM                                                                                                                        |
| ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `direct-only` | identical to `mention-only` | identical to `always`                                                                                                          |
| `engaged`     | the only bounded mode       | identical to `mention-only` — the window only ever opens on an `@mention`, and nobody `@`s anyone in a two-person conversation |

So a channel has **four** distinct behaviours dressed as five, and **a DM offers four options that produce three behaviours.** That is not a copy problem showing through the labels; it is a modelling problem showing through the copy.

> [!IMPORTANT]
> **The `engaged` row of that table is wrong, and the specification does not follow it.** The window opens in a direct message exactly as it does in a channel — `room-trigger.ts` gates `engagementFor` on nothing, and a group direct message is still `kind: 'dm'` — so a DM has four behaviours too. The claim was read off `main`'s `responseModeOptionsFor` TSDoc during this audit and carried forward as fact; it was believed all the way into a first implementation. Left standing here, with this note, because how a wrong premise travelled is the part worth remembering. The corrected table is [`02-specification.md` §2.1](./02-specification.md).

The bounded rule the `engaged` label gestures at is concrete and knowable: `rooms.engagedWindowMinutes` (10) and `rooms.engagedWindowPosts` (5), whichever runs out first. The UI has never said so, despite those being the operator's own settings.

## 4. What Slack teaches, and where it stops

Slack's channel sheet was reviewed as prior art. Worth taking: adding is a **row in the roster** rather than a second panel; the count sits in the title; each member gets a second line; the reader appears as "(you)"; and a right-aligned pill slot ("Channel Manager") holds per-member status.

Worth rejecting: a search field for four members; an "Everyone" filter whose every option shows the same list; six tabs over what for us is three fields.

Worth noting as a contradiction we walk through: Slack's tab bar splits **Members** from **Agents & apps**, and three rows below it sits a button reading **"Add people, agents, or apps."** They mix them where the work happens and segregate them where it is visible. For a product whose thesis is that agents are participants, one list with a badge is the answer — which is also Buzz's, whose NIP-OA cryptographically binds an agent key to the human who vouches for it.

Slack has **no per-member behaviour concept at all**, so its row shape offers nowhere to put a mode. That empty pill slot is exactly where ours goes.

## 5. What the panel cannot currently show

Facts that exist in the system and never reach this surface:

- **Whether an agent is working right now.** The server publishes room presence; `useRoomPresence` has shipped (#626). The panel does not know.
- **The agent's real face.** The roster draws a raw `IdentityAvatar` from the author render cache — a cache, so a renamed agent shows a stale face — while `AgentAvatar` (health ring, working pulse) and `resolveAgentVisual` sit one layer down and are used by every other surface.
- **The aggregate.** No component anywhere answers "how loud is this room".

## 6. States, audited

Seventeen states were enumerated against the current implementation. Six are handled well (roster loading, fleet loading, fleet failed, everyone-already-in, partial add failure, removal confirmation). Two are truthful but weak (roster failed makes the human be the retry button; the empty room gets the panel's least weight for its most important moment). **Nine are unhandled**, including mode-saving, mode-save-failed (the control keeps displaying a value that never saved), removal-undo, working-now, the archived room (fully editable, silently inert), and the DM (offers to convert itself to a group without saying so).

Twelve of the seventeen are unreachable without a live server, because rooms have **zero** dev-playground coverage across 18 pages and 40 showcase files. A state that cannot be reached in a playground is a state that ships unreviewed.

## 7. Decisions taken with the operator (2026-07-30)

1. **Option B — the sheet, not just the panel.** The surface becomes everything about a room, not only its roster.
2. **"managed by you" is hidden until it is informative.** Every agent is the operator's today, so printing it on every row is zero information. It appears only when the owner is not the reader. Absence is the signal, exactly as people get no bot glyph.
3. **Rename and Archive keep their existing entry points.** Inline rename on the sidebar row matches the group-rename gesture already there, and the archive confirmation is the right pattern. The sheet adds a second door to each rather than replacing them. Only `RoomTopicDialog` is retired outright.
