---
slug: unified-conversation
id: 260818-001825
created: 2026-08-18
status: specified
---

# Specification: Unified conversation surfaces — one tree, approvals anywhere, a live lane

- **Slug:** unified-conversation
- **Id:** 260818-001825
- **Status:** Draft
- **Date:** 2026-08-18
- **Author:** Claude (directed by Dorian), SPECIFY stage
- **Tracker:** DOR-1327 (umbrella, project _Unified Conversation Surfaces_)
- **Anchor:** `main` @ `d7e4768e6`, 2026-08-18. **Every `file:line` below was opened and read on this branch.** Where the ideation's map differs, §1.1 records the correction; the ideation is not edited.
- **Inputs:** [`01-ideation.md`](./01-ideation.md) (§6 holds thirteen resolved decisions this spec implements without reopening), [`design-decisions.md`](./design-decisions.md) (the operator's four picks and the design an implementer builds from), `design/01-messaging-exploration.html`, `design/picks.jsonl`.

---

## Overview

DorkOS draws a conversation three times: the agent session (`/session`), a channel and a direct message (both `/channels`). Two of those are the same code (`RoomKind` only changes naming), so it is **two implementations to merge and three presentations to keep**. They already share the composer primitives, the row's style tokens, the grouping math and the accessible feed — and duplicate the row, the list, the composer host, the hover actions, the markdown renderer, the scroll pinning, and, most expensively, the two separate vocabularies for "someone is working" and "someone needs you".

This spec does three things, in one programme:

1. **One `Conversation` compound.** Every surface composes the same tree. Look is decided by `tailwind-variants`; behaviour by **capability flags**; content by a **body-renderer map**. A row never asks which surface it is on.
2. **The Ask.** A tool prompt, a question or an MCP elicitation stops being a session-local secret and becomes a first-class object broadcast to the whole app, listable on mount, and answerable from wherever the person happens to be — with a fail-closed authority rule and the room's privacy rule preserved exactly.
3. **The live lane.** One reserved, fixed-height line above every composer that holds the Ask, the stalled notice, presence, the session's own status, and the queue note — in that priority order, in one morphing container, with zero layout shift by construction.

One sentence of design: **the conversation is one component tree, and the space above the composer is one object that says the single most important true thing.**

## Background / Problem Statement

Three concrete failures, all measured or shipped:

1. **The dead line.** A room whose agent parks on an approval shows: _"Meeting Notes is waiting for you to approve something before it can carry on. Open Meeting Notes's session to answer — it gives up if nobody does."_ (`apps/server/src/services/rooms/notices/notice-copy.ts:206-213`, verbatim). The person hunts for the session. Ten minutes later (`apps/server/src/config/constants.ts:171`, `INTERACTION_TIMEOUT_MS: 10 * 60 * 1000`) the prompt auto-denies and the agent answers badly or not at all. DOR-784 (2026-07-31) is the incident: agents sat silent 20–41 minutes because their prompt showed only in their own session.
2. **Two approval systems, one meaning.** Capability approvals already ride the global fan-out and a list-on-mount endpoint (`services/core/approvals/approval-events.ts:22,33`; `routes/approvals.ts:375`) and render in a header pill, the sidebar's _Heads up_ zone and the home triage header. The SDK tool prompts — the ones that actually stop turns, ten times an hour — ride **only** the per-session stream. The global stream carries one coarse bit for them: `lifecycle: 'blocked'`. `apps/client/src/layers/entities/attention/model/derive-attention-signals.ts:193-208` names the consequence in a comment: a session this window has not attached to degrades to a generic "Waiting on you" with no kind, and the fix it names is _"the fleet-wide stream carrying the interaction kind, which is a server change."_ This spec is that server change.
3. **Two busy vocabularies.** The session says its state in `ChatStatusStrip` **above** the composer (`features/chat/ui/ChatPanel.tsx:416`). The room says its state in `RoomPresenceLine` **below** the composer (`widgets/room-view/ui/RoomSurface.tsx:310`), placed there deliberately because putting it above would push the last message (`specs/room-presence` §5.1). Neither is clickable. Neither can show the other's states.

## Goals

- One implementation of the row, the timeline, the composer host, the hover actions and the "what is happening" line, composed three ways.
- A person can answer any agent prompt from any route in the cockpit, without navigating, and the answer resolves everywhere at once.
- Detail about a prompt reaches only somebody who may act on it. The room's existing vague notice is unchanged and still the log.
- The space above the composer never changes height, so nothing it shows can push the conversation.
- The Dev Playground shows every state of all of it in one place.
- Nothing lands half-migrated: each of the four pull requests is shippable to `main` on its own, and each deletes what it replaces.

## Non-Goals

Carried from `01-ideation.md` §1 and §6 #13, plus what this spec adds:

- **Approvals tier C** — desktop/Telegram/Slack notification _actions_, park-instead-of-deny on timeout, and "don't ask again for this file / folder / this agent in this room" scope options. The card keeps the slot; the behaviour is a separate item.
- **Presence tier 3** — the verb glimpse on the room's presence wire ("is reading `standup.md`"). Needs a new field on `RoomSignalEventSchema`.
- **Human typing indicators in rooms** (`specs/room-presence` §5.2 keeps that a separate row, if ever).
- **Codex / OpenCode approval-timeout parity** beyond what the runtime interface already carries — DOR-803 stays its own item.
- **A per-agent room halt.** §5.3.4 explains why the peek's Stop is the room-wide halt and what a per-author halt would actually cost.
- **Delivering the waiting notice to bridged DMs** (`services/relay/chat-bridge/deliver.ts:78`).
- **Rewriting the Obsidian embed** beyond keeping `DirectTransport` at parity for the one new transport method.
- **The fleet-wide `PresenceStrip`** (`features/presence-strip/`, mounted by `app/HomeRoomPage.tsx:119`). It answers "who on this team is working, anywhere", which is a different question from "what is happening in this conversation". It is untouched.
- **`ChatStatusSection` is not folded into the lane.** See §1.1 — it is the composer's model/mode/git status line, not a busy indicator.

## Technical Dependencies

None new. Everything rides shipped machinery:

| Thing                                  | Where                                                                                                                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global event fan-out                   | `apps/server/src/services/core/event-fan-out.ts` (`eventFanOut.broadcast(name, data)`, :196-226)                                                                                                                                                     |
| The client's allowlist for it          | `apps/client/src/layers/shared/lib/transport/stream-manager.ts:202-264` (`GENERIC_EVENTS`), pinned by `apps/server/src/services/core/__tests__/sse-event-allowlist.test.ts`                                                                          |
| Runtime-agnostic interaction state     | `apps/server/src/services/session/session-state-projector.ts` (`trackInteraction` :1101-1119, `getPendingInteractions` :1372, registry :1722, `onProjectorStatusChange` :295)                                                                        |
| The pending DTO                        | `packages/shared/src/schemas.ts:1157-1202` (`PendingInteractionDTOSchema`) and its selector `apps/server/src/services/session/pending-interactions.ts:61`                                                                                            |
| Fail-closed authority                  | `apps/server/src/lib/caller-authority.ts` (`readCallerAuthority`, `requireOperatorCookieUnderLogin`), `apps/server/src/services/core/approvals/` (`resolveDecisionAuthority`), `packages/relay/src/adapters/approver-allowlist.ts:75` (`mayApprove`) |
| Virtualization                         | `@tanstack/react-virtual`, already used at `features/chat/ui/MessageList.tsx:238`                                                                                                                                                                    |
| Multi-slot variants                    | `tailwind-variants`, already used at `features/chat/ui/message/message-variants.ts:18`                                                                                                                                                               |
| Popover that becomes a sheet on phones | `apps/client/src/layers/shared/ui/responsive-popover.tsx`                                                                                                                                                                                            |
| Feed a11y + roving keyboard            | `shared/ui/feed.tsx`, `shared/model/feed/use-feed-keyboard-nav.ts`                                                                                                                                                                                   |
| Room halt                              | `POST /api/rooms/:id/halt` (`routes/rooms.ts:676`) → `RoomService.haltRoom` (:538) → `RoomTriggerDispatcher.halt` (`room-trigger.ts:2386`); client `entities/room/model/use-halt-room.ts`                                                            |
| Room → session binding                 | `apps/server/src/services/rooms/room-session-ledger.ts` (`RoomSessionBinding` :35, `list()` :97)                                                                                                                                                     |

---

## 1. The verified map

### 1.1 Corrections to `01-ideation.md` §3

The ideation's map was assembled from a moving tree. Everything below was re-read at the anchor commit. **The ideation is not edited; this table is the correction of record.**

| Ideation said                                  | Actually                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/…`, `widgets/…`, `entities/…`        | Every client path is under **`apps/client/src/layers/`** (`layers/features/…`). There is no `apps/client/src/features/`.                                                                                                                                                                                                                                                                                                                                                                                   |
| `ChatPanel.tsx:390-509`                        | Component at `ChatPanel.tsx:81`; 512 lines. `ChatStatusStrip` mounted at **:416** (that part was right).                                                                                                                                                                                                                                                                                                                                                                                                   |
| `MessageItem.tsx:143-228`                      | Component at **:96**; 228 lines. `:143` is the `messageItem({…})` call. `MessageItemProps` (:16) is **not exported**.                                                                                                                                                                                                                                                                                                                                                                                      |
| "Rooms already import `messageItem`"           | **They do not.** `messageItem` is exported at `features/chat/index.ts:17` and has exactly one consumer, `MessageItem.tsx:143`. `RoomEntryRow` styles itself. The unification therefore _creates_ the shared row rather than completing it.                                                                                                                                                                                                                                                                 |
| `ChatInputContainer.tsx:337-530`               | Component at **:126**; 536 lines. `InteractiveInputPanel` mounted at :360, `ChatStatusSection` at :515.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `RoomEntryRow.tsx:200-400`                     | Component at **:157**; 400 lines. Parts: `RoomEntryHeader.tsx` (171), `RoomEntryBody.tsx` (166), `RoomEntryAttachments.tsx` (137), `RoomEntryActions.tsx` (149).                                                                                                                                                                                                                                                                                                                                           |
| `RoomComposer.tsx:427-480`                     | Component at **:120**; 604 lines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RoomNoticeRow.tsx:172-198`                    | Component at **:171**; 198 lines. Siblings: `RoomMomentRow.tsx:84` (160), `RoomPendingRow.tsx:67` + `RoomPendingList:229` (244), `RoomThreadReplyRow.tsx:44` (140).                                                                                                                                                                                                                                                                                                                                        |
| `router.tsx:366` / `:446`                      | `/session` at **:364**, `/channels` at **:444**.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `HomeRoomPage.tsx:192`                         | Component at **:84**; 216 lines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `InteractiveInputPanel.tsx:55-83`              | Real path `features/chat/ui/input/InteractiveInputPanel.tsx`; component :36, `BatchApprovalBar` at **:55**. The three prompt components live in `features/chat/ui/tools/`: `ToolApproval.tsx` (567), `QuestionPrompt.tsx` (530), `ElicitationPrompt.tsx` (238), `BatchApprovalBar.tsx` (70). Inline mounts in `AssistantMessageContent.tsx` at **:327** (elicitation), **:416** (approval), **:483** (question) — all three correct.                                                                       |
| — (not in the map)                             | `features/chat/ui/tools/ApprovalReceipt.tsx` (172) and `ApprovalReceiptRow.tsx` (78) **already exist**. Receipts are not new work; they are work to generalize.                                                                                                                                                                                                                                                                                                                                            |
| `interactive-handlers.ts:648-720` / `:729-800` | `handleAskUserQuestion` at **653-715**, `handleElicitation` at **724-795**. `handleToolApproval` at 971-1068 (correct).                                                                                                                                                                                                                                                                                                                                                                                    |
| `session-store.ts:465-503`                     | Real path `services/runtimes/claude-code/sessions/session-store.ts`; `approveTool` :461, `submitAnswers` :481, `submitElicitation` :490.                                                                                                                                                                                                                                                                                                                                                                   |
| `agent-types.ts:95`                            | Real path `services/runtimes/claude-code/agent-types.ts:95` — **runtime-specific**, which is why §3.2 broadcasts from the projector instead.                                                                                                                                                                                                                                                                                                                                                               |
| `session-stream.ts:855-880`                    | Real path `packages/shared/src/session-stream.ts` — a **schema** module. `lifecycle = 'blocked'` is _written_ in `apps/server/src/services/session/session-state-projector.ts` (:903, :1119, :1269).                                                                                                                                                                                                                                                                                                       |
| `GENERIC_EVENTS` in `routes/events.ts`         | It is a **client** constant: `apps/client/src/layers/shared/lib/transport/stream-manager.ts:202-264`. Its guard is `apps/server/src/services/core/__tests__/sse-event-allowlist.test.ts` (a textual cross-scan, with a named exception list at :62-66).                                                                                                                                                                                                                                                    |
| `chat-bridge/deliver.ts:78`                    | Real path `apps/server/src/services/relay/chat-bridge/deliver.ts:78` (`DELIVERABLE_NOTICES = new Set(['turn_failed', 'halted'])`).                                                                                                                                                                                                                                                                                                                                                                         |
| "stream manager attaches ≤ 2 sessions"         | The budget is **three connections**: one attached session, one global list stream, and one optional pinned (PiP) session. There is one `attachedSessionId` (:308) and one `pinnedSessionId` (:318). The conclusion the ideation drew is still right — one attached session means fine-grained pending state is structurally unavailable fleet-wide — but the number is wrong, and `stream-manager.ts:298-301` carries a stale docstring saying "two durable streams" that this programme fixes in passing. |
| "`ChatStatusStrip`/`ChatStatusSection` folded" | Only `ChatStatusStrip` folds. **`ChatStatusSection` (`status/ChatStatusSection.tsx:84`, 571 lines) is the composer's status LINE** — model, permission mode, git, runtime chip, the Session panel behind `⋯` — built on `features/status`' `StatusLine` and mounted inside the composer card at `ChatInputContainer.tsx:515`. It is not a busy indicator and must not become lane content; it becomes `Conversation.Footer` content, unchanged.                                                            |
| Dev Playground "7 touch points" for a page     | For **creating** a page, seven (the skill is right). For **renaming** one, see §6.2 — five for the id plus two more if the section array is renamed too, and the skill's step 6 is stale about where `PAGE_COMPONENTS` lives.                                                                                                                                                                                                                                                                              |

### 1.2 What is confirmed and load-bearing

- `messageItem` (`features/chat/ui/message/message-variants.ts:18`) — slots `root · gutter · avatarTimestamp · body · header · authorName · timestamp · actions · content`; variants `role: user|assistant`, `position: first|middle|last|only`, `density: comfortable|compact`, `anchor: corner|rail`; defaults `assistant / only / comfortable / corner`. A second `tv()`, `toolStatus` (:151), lives in the same file with `status: pending|running|complete|error|neutral`.
- `MessageList.tsx:128` (530 lines) — `useVirtualizer` (:238), `ScrollThumb` (:30), `useUnreadCursor` (:27), two announcers (`useStreamingAnnouncer` :28, `useApprovalAnnouncer` :29) rendering live regions at :507-510 (`transcript-announcer`) and :522-527 (`approval-announcer`).
- `RoomTimeline.tsx:134` (298 lines) — **not** virtualized; `groupByThread` (:173), `RoomPendingList` (:295), `RoomTimelineSkeleton` (:81).
- `shared/lib/group-timeline.ts` — `GROUP_GAP_MS` :22, `unreadPlacement` :96, `buildTimelineRows` :219. Already surface-neutral.
- `features/composer/index.ts:66-72` — `Composer = { Root, Input, OverlayLane, Attachments, ClearArmedHint }`. The one existing namespace compound.
- `RoomSurface.tsx:108` (378 lines) — `aboveTimeline` (:47) and `aboveComposer` (:61) slots, both documented as **outside the scroller** because a height change inside it moves `scrollHeight` under `useStickToBottom` and un-pins a reader who never scrolled. That constraint governs where the lane sits (§5.1).
- `use-stick-to-bottom.ts` (223 lines) — `StickToBottom` :60, `useStickToBottom` :116.
- `entities/room/model/use-room-presence.ts` (492 lines) — `PRESENCE_TTL_MS` 30 000 (:41), `PRESENCE_TICK_MS` 1 000 (:53), `observe` :167, `clearAuthor` :194, `prune` :221, `summarize` :297, `useRoomPresence` :341, `useRoomPresenceAuthorIds` :395, `useRoomPresenceEverywhere` :459.
- `entities/room/lib/presence-copy.ts` — `presenceSentence` :71-76, `presenceCountSentence` :89-92.
- `features/chat/ui/status/strip-state.ts` — `StripState` union and `deriveStripState`, a pure priority stack with no React. **This is the model the lane's state machine is built from**, not a new invention.
- `entities/session/model/session-stream-store.ts` (1251 lines) — `pendingInteractions` :88, the interaction reducer :802-810 and :820-825, `useSessionAwaitingDecision` :1155-1166.
- `entities/attention/model/attention-signal.ts:26` — `AttentionSignalKind = 'permission-prompt' | 'question' | 'error' | 'idle-timeout'`; `AttentionSignal` :37-61.

---

## 2. The `Conversation` compound

### 2.1 Placement, and why a new slice

**Decision: a new `apps/client/src/layers/features/conversation/` slice.** Not a grown `features/chat`.

The argument is the layer rule, not taste. `features/chat` carries a large session-specific model — `model/chat-types.ts`, `model/build-palette-commands.ts`, the streaming view hooks, `MessageContext` (a session context: `sessionId`, `activeToolCallId`, tool handles). If the shared tree lived there, `widgets/room-view` would import a feature (legal) but every room-side hook that needed a shared model would be a **feature model importing a sibling feature's model**, which `.claude/rules/fsd-layers.md` forbids outright. A neutral slice has no such pull: it depends only on `entities/*` and `shared/*`, and the two host **widgets** wire it to their own renderers.

```
layers/features/conversation/
├── ui/
│   ├── ConversationRoot.tsx        Conversation.Root — the context provider
│   ├── ConversationHeader.tsx      slot
│   ├── ConversationFooter.tsx      slot
│   ├── Timeline.tsx                the one virtualized list
│   ├── ScrollThumb.tsx             moved from features/chat/ui/
│   ├── LiveLane.tsx                §5
│   ├── LivePeek.tsx                §5.3
│   ├── ComposerHost.tsx            Conversation.Composer — §2.7
│   ├── message/
│   │   ├── MessageRoot.tsx  MessageGutter.tsx  MessageAuthor.tsx
│   │   ├── MessageBody.tsx  MessageAttachments.tsx
│   │   ├── MessageReactions.tsx    MessageActions.tsx
│   │   ├── message-variants.ts     moved: `messageItem` + `toolStatus`
│   │   └── message-styles-context.tsx   the slot classNames, provider + hook
│   └── rows/
│       ├── DayDivider.tsx  UnreadDivider.tsx   moved from features/chat/ui/message/
│       ├── NoticeRow.tsx  MomentRow.tsx  ThreadReplyRow.tsx  PendingRow.tsx
├── model/
│   ├── conversation-context.ts     ConversationContextValue + useConversation()
│   ├── capabilities.ts             ConversationCapabilities
│   ├── target.ts                   ConversationTarget
│   ├── lane-state.ts               deriveLaneState — §5.2
│   ├── use-timeline-scroll.ts      the ONE scroll/stick hook (§2.4)
│   └── use-unread-cursor.ts        moved from features/chat/model/view/
├── lib/
│   ├── format-entry-time.ts        the ONE time formatter (§2.9)
│   └── row-kinds.ts                ConversationRow discriminated union
└── index.ts
```

Layer check: `features/conversation` imports `entities/room`, `entities/session`, `entities/attention`, `shared/*`, and — for UI composition only — `features/composer`, `features/entry-actions`, `features/ask` (§4.3). It imports no widget and no other feature's model. Both hosts are widgets, so `widgets/session` and `widgets/room-view` composing it is legal in both directions.

**`MessageContext` stays in `features/chat`.** It is the session renderer's own context (tool handles, `activeToolCallId`), consumed only by `AssistantMessageContent.tsx:254`. Moving it would drag session concepts into the neutral slice for no gain. The compound's own styling context is a _different, new_ thing: `message-styles-context.tsx`, which carries only the `messageItem` slot classNames.

### 2.2 The API

> **Amended 2026-08-18 (P4, DOR-1331), against what shipped.** Three things in this section read
> differently now, and each is argued at length in `04-implementation.md`:
> **(1)** `capabilities.toolCards` does not exist. Which body a row draws is settled by the renderer
> the host hands it (`renderSessionBody` vs `renderRoomBody`), which is §2.6's gate; a flag two
> capability tables had to keep in step while nothing read it was a check that could not fail.
> **(2)** `capabilities.streamHealth` was added, and it is what decides whether the live lane says
> "this client has stopped hearing" — a room does, a session says it in its status strip instead.
> **(3)** The timeline's prop is `renderRow`, not `renderBody`: the two row wrappers hold what only
> each surface knows, so the timeline calls the host back for a whole row and `ConversationBodyRenderer`
> stays the §2.6 seam INSIDE it.

```ts
/** Which of the three presentations this conversation is. */
export type ConversationSurface = 'session' | 'room' | 'dm';

/** What this conversation can do. Behaviour branches on these, never on `surface`. */
export interface ConversationCapabilities {
  /** Emoji reactions on a row. */
  reactions: boolean;
  /** Rows can open a thread, and a thread panel exists. */
  threads: boolean;
  /** The "run this with…" action on a row (session only today). */
  runWith: boolean;
  /** The composer accepts files. */
  attachments: boolean;
  /** The composer offers an @mention picker and bodies render mention pills. */
  mentions: boolean;
  /** The lane may say this client has stopped hearing the conversation. */
  streamHealth: boolean;
  /** The lane may show presence for other authors. */
  presence: boolean;
  /** The lane may show this conversation's own turn status (elapsed, tokens, mode). */
  turnStatus: boolean;
  /** The lane may grow an Ask card. */
  asks: boolean;
}

export interface ConversationContextValue {
  surface: ConversationSurface;
  capabilities: ConversationCapabilities;
  target: ConversationTarget;
  density: 'comfortable' | 'compact';
  anchor: 'corner' | 'rail';
}

/** Read the conversation this part belongs to. Throws outside `Conversation.Root`. */
export function useConversation(): ConversationContextValue;

export const Conversation = {
  Root: ConversationRoot,
  Header: ConversationHeader,
  Timeline: ConversationTimeline,
  LiveLane: ConversationLiveLane,
  Composer: ConversationComposer,
  Footer: ConversationFooter,
};

export const Message = {
  Root: MessageRoot,
  Gutter: MessageGutter,
  Author: MessageAuthor,
  Body: MessageBody,
  Attachments: MessageAttachments,
  Reactions: MessageReactions,
  Actions: MessageActions,
};
```

The capability objects are **declared by each host**, as module constants, so nothing derives behaviour from `surface`:

```ts
// layers/widgets/session/model/session-capabilities.ts
export const SESSION_CAPABILITIES: ConversationCapabilities = {
  reactions: false,
  threads: false,
  runWith: true,
  attachments: true,
  mentions: false,
  streamHealth: false,
  presence: false,
  turnStatus: true,
  asks: true,
};

// layers/widgets/room-view/model/room-capabilities.ts
export const ROOM_CAPABILITIES: ConversationCapabilities = {
  reactions: true,
  threads: true,
  runWith: false,
  attachments: true,
  mentions: true,
  streamHealth: true,
  presence: true,
  turnStatus: false,
  asks: true,
};
/** A DM is a room whose kind changes naming only, so it shares the room's capabilities. */
export const DM_CAPABILITIES = ROOM_CAPABILITIES;
```

That table is the whole of "what is different between the surfaces", written once, in the layer that knows. When a session gains reactions, one boolean moves and no row changes.

### 2.3 Composition, as the hosts write it

```tsx
// widgets/room-view/ui/RoomSurface.tsx (after)
<Conversation.Root
  surface={room.kind === 'dm' ? 'dm' : 'room'}
  capabilities={ROOM_CAPABILITIES}
  target={roomTarget}
  anchor="corner"
  density="comfortable"
>
  <Conversation.Header>
    {aboveTimeline}
    <RoomMasthead room={room} />
  </Conversation.Header>
  <Conversation.Timeline
    rows={rows}
    renderRow={renderRoomRow}
    onOpenThread={openThread}
    ref={timelineRef}
  />
  <Conversation.LiveLane
    presence={roomPresence}
    stalled={stream.stalled}
    asks={asksForRoom}
    onPeek={openPeek}
  />
  <Conversation.Composer />
</Conversation.Root>
```

`widgets/session` composes the same tree with `SESSION_CAPABILITIES`, `renderSessionBody`, `turnStatus` instead of `presence`, and a `Conversation.Footer` holding `ChatStatusSection`.

### 2.4 `Conversation.Timeline` — one virtualized list

Built by porting `MessageList.tsx` (the virtualized one) and folding `RoomTimeline.tsx`'s three room-only behaviours into it.

```ts
export interface ConversationTimelineProps {
  /** Ordered rows, already grouped. See `lib/row-kinds.ts`. */
  rows: readonly ConversationRow[];
  /** Draws one row. The host's own row wrapper, which composes §2.6's body renderer inside it. */
  renderRow: ConversationRowRenderer;
  /** Sequence the unread cursor is placed against; `null` when everything is read. */
  lastReadSeq?: number | null;
  /** Called when a row asks to open its thread. Required when `capabilities.threads`. */
  onOpenThread?: (rootId: string) => void;
  /** Rows the server has accepted but not yet committed (rooms' optimistic posts). */
  pending?: readonly ConversationPendingRow[];
  className?: string;
}

export interface ConversationTimelineHandle {
  /** Scroll a row into view and flash it. Used by the peek's "replying to…" link. */
  scrollToRow(rowId: string, opts?: { flash?: boolean }): void;
  scrollToBottom(opts?: { behavior?: ScrollBehavior }): void;
}
```

Row kinds — the union both surfaces now share:

```ts
export type ConversationRow =
  | {
      kind: 'message';
      id: string;
      payload: unknown;
      grouping: MessageGrouping;
      author: MessageAuthor;
      at: string;
    }
  | { kind: 'day-divider'; id: string; at: string }
  | { kind: 'unread-divider'; id: string; count: number }
  | { kind: 'notice'; id: string; at: string; body: ReactNode }
  | { kind: 'moment'; id: string; at: string; body: ReactNode }
  | { kind: 'thread-reply'; id: string; rootId: string; replyCount: number; lastAt: string };
```

`payload` is deliberately `unknown` and only ever handed back to the host's own `renderBody`. Forcing `ChatMessage` (`shared/model/chat-message-types.ts:18`) and `RoomEntry` (`packages/shared/src/room-schemas.ts:850`) into one union is the premature merge decision 4 of the ideation refuses; the chrome unifies, the content stays typed at its own end.

What it inherits from each parent:

| From `MessageList.tsx`                                        | From `RoomTimeline.tsx`                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `useVirtualizer` (:238)                                       | thread grouping via `groupByThread` (:173) → produces `thread-reply` rows |
| `ScrollThumb` (:30)                                           | the pending list (`RoomPendingList` :295) → `pending` prop                |
| `useUnreadCursor` (:27)                                       | `useStickToBottom` semantics (:116)                                       |
| the two announcers (:28-29, regions at :507-510 and :522-527) | the skeleton (`RoomTimelineSkeleton` :81)                                 |

**The scroll hooks merge into one.** `features/chat/model/view/use-scroll-overlay.ts:14` (49 lines, overlay visibility) and `widgets/room-view/model/use-stick-to-bottom.ts:116` (223 lines, follow/un-follow) become `model/use-timeline-scroll.ts`, whose contract is `use-stick-to-bottom`'s — because it is the one with the hard-won rules the room documented (a height change inside the scroller un-pins a reader). The overlay hook's job (when to show the scroll-to-bottom button and the new-messages pill) becomes two derived booleans on the same hook. The room's tuned thresholds win any disagreement, and `RoomSurface`'s slot rule (chrome is a flex sibling, never inside the scroller) is preserved: `Conversation.Header`, `LiveLane`, `Composer` and `Footer` are all siblings of the scroller.

### 2.5 `Message.*` — one row

`MessageItem.tsx` (session) and `RoomEntryRow.tsx` + its four part files (room) merge into seven parts. `Message.Root` computes `messageItem({ role, position, density, anchor })` once and provides the slot classNames through `message-styles-context.tsx`; each part reads its own slot.

```tsx
<Message.Root role="assistant" position="first" id={row.id}>
  <Message.Gutter /> {/* avatar rail or corner avatar+timestamp */}
  <Message.Author /> {/* name + timestamp; hidden when position ≠ first */}
  <Message.Body>{renderBody(row.payload)}</Message.Body>
  <Message.Attachments items={row.attachments} />
  <Message.Reactions /> {/* renders null unless capabilities.reactions */}
  <Message.Actions /> {/* one hover-action system, §2.8 */}
</Message.Root>
```

Every part takes `asChild` (the repo has 188 uses) and stamps `data-slot` (728 uses, mandated). Every export carries TSDoc (Hard Rule 4).

**Capability flags, not surface checks.** `Message.Reactions` renders `null` when `capabilities.reactions` is false. `Message.Actions` composes its menu from the capabilities: `runWith` adds the `RunWithMenu` item, `threads` adds "Reply in thread", `reactions` adds the emoji row. What a body may contain is settled by WHICH body renderer the host hands the row (`renderSessionBody` vs `renderRoomBody`) — that is this section's gate, and there is no capability flag beside it. There is no `surface === 'room'` anywhere below `Conversation.Root` — a lint-visible property, and §7.1 pins it with a source scan.

**Hover actions merge.** `features/chat/ui/message/RunWithMenu.tsx:55` (141 lines) and `features/entry-actions` (`EntryActionBar`, `EntryActionMenu`, `EntryReactionRow`, `EntryReactionPicker`, `EntryReactionGrid`, `useEntryActions`, `ENTRY_ACTION_ORDER`, `RovingGroup`) become one system. `features/entry-actions` is the survivor — it already has the roving keyboard group, the long-press path and the mobile alternates the design system requires — and it gains one action id, `run-with`, whose availability is `capabilities.runWith`. `RunWithMenu.tsx` is deleted and its popover body becomes that action's content.

### 2.6 The body-renderer map

```ts
/** Turns one message row's opaque payload into its rendered body. */
export type ConversationBodyRenderer = (payload: unknown, ctx: BodyRenderContext) => ReactNode;

export interface BodyRenderContext {
  /** The row this body belongs to. */
  rowId: string;
  /** True while this row is the streaming tail. */
  isStreaming: boolean;
}
```

Two implementations, each owned by its host widget:

| Renderer            | Lives in                                     | Renders                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderSessionBody` | `widgets/session/ui/render-session-body.tsx` | `MessagePartSchema` parts (`packages/shared/src/schemas.ts:2370`) through the existing `features/chat` components: `AssistantMessageContent` (591 lines — over the 500-line split threshold; §8 P4 splits it), `UserMessageContent`, `StreamingText`, `ThinkingBlock`, `ToolCallCard`, `SubagentBlock`, `MemoryRecallBlock`, `McpSigninCard`, `ErrorMessageBlock`, `CompactBoundaryRow`, `OutputRenderer`, and the three inline prompts (which move to `features/ask`, §4.3). |
| `renderRoomBody`    | `widgets/room-view/ui/render-room-body.tsx`  | `RoomEntrySchema.body` through `MarkdownContent` (`shared/ui`, imported at `RoomEntryBody.tsx:20`, rendered :141) plus `buildMentionComponents` (`MentionPillRenderer`, :29) and `lib/mention-markup.ts`.                                                                                                                                                                                                                                                                     |

Neither renderer knows about the other. `features/conversation` imports neither.

### 2.7 `Conversation.Composer` and the `ConversationTarget`

One host over the shipped `Composer.*` primitives (`features/composer/index.ts:66-72`), with an adapter for everything the two hosts do differently.

```ts
/** What the composer needs to send into this conversation. */
export interface ConversationTarget {
  readonly kind: 'session' | 'room';
  /** Session id or room id. */
  readonly id: string;
  /** Placeholder, already phrased for this surface ("Message #mio…"). */
  readonly placeholder: string;
  /** False while the conversation cannot accept input (archived room, gone session). */
  readonly canSend: boolean;
  /** Send now. Rejects rather than silently dropping. */
  send(draft: ConversationDraft): Promise<void>;
  /**
   * Hold for the current turn instead of sending. Absent when the surface has no
   * queue — a room does not, and `Conversation.Composer` shows no queue chrome
   * when this is undefined rather than showing a disabled one.
   */
  queue?(draft: ConversationDraft): Promise<void>;
  /** How many drafts are already held. `0` when `queue` is absent. */
  readonly queueDepth: number;
  /** Attachment upload + removal, or `null` when `capabilities.attachments` is false. */
  readonly attachments: ConversationAttachmentPort | null;
  /** Mention search + insertion, or `null` when `capabilities.mentions` is false. */
  readonly mentions: ConversationMentionPort | null;
}

export interface ConversationDraft {
  text: string;
  attachmentIds: readonly string[];
  /** Set when the draft is a thread reply. */
  parentEntryId?: string;
}
```

`ChatInputContainer.tsx` (536 lines) and `RoomComposer.tsx` (604 lines) collapse into `ComposerHost.tsx` plus two small adapters (`widgets/session/model/session-target.ts`, `widgets/room-view/model/room-target.ts`). Everything genuinely session-only that lived in `ChatInputContainer` — the interactive-prompt takeover (`InteractiveInputPanel` at :360), the queue panel, `ChatStatusSection` at :515 — becomes either a capability-gated slot on the host (`asks`, `queueDepth > 0`) or `Conversation.Footer` content.

### 2.8 The variant contract

- **`tailwind-variants` for look, one file:** `features/conversation/ui/message/message-variants.ts`, moved wholesale (both `messageItem` and `toolStatus`). Variants stay exactly as they are — `role`, `position`, `density`, **`anchor: corner | rail`** — with `anchor` carrying the whole visual difference between the session's corner avatar and the room's avatar rail. No new variant is added in this programme; a new _look_ would be a new option on `anchor`, never a new `if`.
- **`cva` for the leaf primitives** the compound adds (the lane's tone, the peek row), matching the 14 existing `shared/ui` uses.
- **`data-slot` on every part**, named for the part (`data-slot="message-gutter"`), so browser tests and the per-area stand-down rules in `contributing/design-system.md` can target them by name rather than by tag.
- **`asChild` where a part is a single element** — `Message.Root`, `Message.Author`, `Conversation.Header`, `Conversation.Footer`.
- **TSDoc on every export**, enforced by `eslint-plugin-jsdoc`.

### 2.9 What is deleted, and what replaces it

Nothing on this list is left behind a flag or kept "just in case". Each deletion lands in the phase named.

| Deleted                                                                                                                               | Replaced by                                                           | Phase |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----- |
| `features/chat/ui/message/MessageItem.tsx` (228)                                                                                      | `features/conversation/ui/message/Message*.tsx`                       | P1    |
| `widgets/room-view/ui/RoomEntryRow.tsx` (400)                                                                                         | same                                                                  | P1    |
| `widgets/room-view/ui/RoomEntryHeader.tsx` (171)                                                                                      | `Message.Author`                                                      | P1    |
| `widgets/room-view/ui/RoomEntryAttachments.tsx` (137)                                                                                 | `Message.Attachments`                                                 | P1    |
| `widgets/room-view/ui/RoomEntryActions.tsx` (149)                                                                                     | `Message.Actions` + `features/entry-actions`                          | P1    |
| `widgets/room-view/ui/RoomEntryBody.tsx` (166)                                                                                        | `widgets/room-view/ui/render-room-body.tsx` (the renderer, not a row) | P1    |
| `features/chat/ui/message/{DayDivider,UnreadDivider}.tsx`                                                                             | `features/conversation/ui/rows/`                                      | P1    |
| `widgets/room-view/ui/{RoomNoticeRow,RoomMomentRow,RoomThreadReplyRow}.tsx`                                                           | `rows/{NoticeRow,MomentRow,ThreadReplyRow}.tsx`                       | P1    |
| `features/chat/ui/message/RunWithMenu.tsx` (141)                                                                                      | the `run-with` action in `features/entry-actions`                     | P1    |
| `widgets/room-view/lib/entry-time.ts` (`formatTime` :20, `formatAbsoluteTime` :39)                                                    | `features/conversation/lib/format-entry-time.ts`                      | P1    |
| `features/chat/ui/status/ChatStatusStrip.tsx` (171)                                                                                   | `Conversation.LiveLane`                                               | P2    |
| `features/chat/ui/status/strip-state.ts`                                                                                              | `features/conversation/model/lane-state.ts`                           | P2    |
| `widgets/room-view/ui/RoomPresenceLine.tsx` (165)                                                                                     | `Conversation.LiveLane` presence content                              | P2    |
| `widgets/room-view/ui/RoomStalledNotice.tsx`                                                                                          | `Conversation.LiveLane` stalled content                               | P2    |
| the `aboveComposer` slot's presence/stalled comments in `RoomSurface.tsx:283-310` and `RoomThreadPanel.tsx:419,438`                   | the lane, mounted once per surface                                    | P2    |
| `features/chat/ui/tools/BatchApprovalBar.tsx` (70)                                                                                    | `features/ask` `AskStack`                                             | P3    |
| `features/chat/ui/tools/{ToolApproval,QuestionPrompt,ElicitationPrompt,ApprovalReceipt,ApprovalReceiptRow,QuestionAnswerSummary}.tsx` | moved to `features/ask/ui/`, re-based on `AskCard.*` chrome           | P3    |
| `widgets/room-view/ui/RoomTimeline.tsx` (298)                                                                                         | `Conversation.Timeline`                                               | P4    |
| `features/chat/ui/MessageList.tsx` (530)                                                                                              | same                                                                  | P4    |
| `features/chat/model/view/use-scroll-overlay.ts` (49)                                                                                 | `model/use-timeline-scroll.ts`                                        | P4    |
| `widgets/room-view/model/use-stick-to-bottom.ts` (223)                                                                                | same                                                                  | P4    |
| `widgets/room-view/ui/RoomComposer.tsx` (604)                                                                                         | `Conversation.Composer` + `room-target.ts`                            | P4    |
| `features/chat/ui/input/ChatInputContainer.tsx` (536)                                                                                 | `Conversation.Composer` + `session-target.ts`                         | P4    |
| `features/chat/ui/input/InteractiveInputPanel.tsx`                                                                                    | the composer host's `asks` slot                                       | P4    |
| `widgets/room-view/ui/RoomPendingRow.tsx` (244)                                                                                       | `rows/PendingRow.tsx` + the timeline's `pending` prop                 | P4    |

`pnpm knip` runs at the end of each phase; a phase is not done while it reports a new orphan.

---

## 3. The Ask — server

### 3.1 One wire shape, reusing the DTO that already exists

New module `packages/shared/src/interaction-events.ts`, exported as `@dorkos/shared/interaction-events` (add the subpath to `packages/shared/package.json`'s `exports` map).

```ts
import { z } from 'zod';
import { PendingInteractionDTOSchema } from './schemas.js';

/**
 * One prompt an agent is parked on, addressed to whoever may answer it.
 *
 * The interaction itself is `PendingInteractionDTOSchema` **verbatim** — the same
 * object the per-session stream and the recovery snapshot already carry, so the
 * card that renders it cannot drift between the two paths and no second shape
 * has to be kept in step.
 */
export const InteractionPendingEventSchema = z
  .object({
    /** The session whose turn is parked. */
    sessionId: z.string().min(1),
    /** The session's working directory — the deep link, and the identity fallback. */
    cwd: z.string().min(1),
    /** What is being asked. Carries `type`, `id`, `startedAt`, `remainingMs`, and the kind's own fields. */
    interaction: PendingInteractionDTOSchema,
    /** The room this session answers in, when it is bound to one. */
    roomId: z.string().min(1).optional(),
    /** The agent's author id in that room, for correlating with the presence line. */
    roomAuthorId: z.string().min(1).optional(),
  })
  .openapi('InteractionPendingEvent');
export type InteractionPendingEvent = z.infer<typeof InteractionPendingEventSchema>;

/** How an Ask stopped being pending. */
export const InteractionOutcomeSchema = z.enum(['answered', 'cancelled', 'expired']);

export const InteractionResolvedEventSchema = z
  .object({
    sessionId: z.string().min(1),
    /** The interaction id — the same id `InteractionPendingEvent.interaction.id` carried. */
    interactionId: z.string().min(1),
    outcome: InteractionOutcomeSchema,
    /** ISO timestamp of the resolution, for the receipt line. */
    resolvedAt: z.string(),
    /**
     * A label for whoever answered, when the server knows one — the operator's
     * display name, or a bridged approver's handle. Absent for `expired` and for
     * an install with no accounts, where "you" is the only possible answer.
     */
    resolvedBy: z.string().optional(),
  })
  .openapi('InteractionResolvedEvent');
export type InteractionResolvedEvent = z.infer<typeof InteractionResolvedEventSchema>;

export const PendingInteractionsResponseSchema = z
  .object({
    interactions: z.array(InteractionPendingEventSchema),
    /** Per-source degradation, in the shape `GET /api/sessions` already uses (ADR-0310). */
    warnings: z.array(z.string()).optional(),
  })
  .openapi('PendingInteractionsResponse');
export type PendingInteractionsResponse = z.infer<typeof PendingInteractionsResponseSchema>;
```

**Two things deliberately NOT on the wire.**

- **No denormalized identity** (`agentName`, `agentEmoji`, `agentColor`). Every client that renders this already holds the fleet session list off the same global stream, so `sessionId` joins to a `Session` with its name, agent and colour — the exact join `derive-attention-signals.ts`'s `sessionSignal` already does. Putting a name on a hot event creates a second copy that goes stale the moment an agent is renamed, and would make this the only fan-out event carrying identity. `cwd` is on the payload precisely so the fallback ladder (session not in the list yet → basename of `cwd`) works without one.
- **No per-second countdown.** `startedAt` and `timeoutMs` ride inside the DTO; `remainingMs` is computed server-side at emit and at list, and the client ticks locally from `startedAt + timeoutMs`. This is the rule `01-ideation.md` §7 names and the one `listPendingInteractions` (`pending-interactions.ts:61-82`) already enforces.

### 3.2 Where the broadcast comes from

**Decision: the `SessionStateProjector`, not the claude-code runtime.**

`session.pendingInteractions` lives on `services/runtimes/claude-code/agent-types.ts:95` — it is one runtime's map. The projector is the runtime-agnostic twin: `trackInteraction` (`session-state-projector.ts:1101-1119`) already folds every `BLOCKING_INTERACTION_EVENT_TYPES` event from _any_ runtime into `this.interactions` and flips `lifecycle` to `blocked`, and `resolveInteraction` already ingests the resolution through the same seq'd stream. Broadcasting from there means Codex and OpenCode get the Ask the moment they emit the events, with no adapter work — which is also why DOR-803 stays a separate item rather than a blocker.

The projector must not import the fan-out (it imports no transport today, and the module is unit-tested in isolation). It uses the seam it already has for exactly this:

```ts
// session-state-projector.ts — beside onProjectorStatusChange (:295)

/** Notified when a projector starts or stops holding a pending interaction. */
export type InteractionChangeListener = (change: InteractionChange) => void;

export type InteractionChange =
  | { type: 'pending'; sessionId: string; cwd: string; interaction: PendingInteractionDTO }
  | { type: 'resolved'; sessionId: string; interactionId: string; outcome: InteractionOutcome };

/** Subscribe to interaction transitions across every live projector. */
export function onProjectorInteractionChange(listener: InteractionChangeListener): () => void;
```

`notifyInteractionChange` is throw-isolated exactly like `notifyStatusChange` (:301-319) and fires from three places:

| Fired at                                                                | Emits                                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------- |
| `trackInteraction` (:1101), after `this.interactions.set(id, …)`        | `pending`                                            |
| `resolveInteraction`, on the ingested `interaction_resolved`            | `resolved` with `outcome: 'answered'`                |
| the cancel/expiry path (`interaction_cancelled`, and `markInterrupted`) | `resolved` with `outcome: 'cancelled'` / `'expired'` |

`session-list-broadcaster.ts` subscribes and broadcasts. It already imports `eventFanOut` (:31) and `onProjectorStatusChange` (:32), so this is one more subscription in `start()`:

```ts
this.unsubscribeInteractions = onProjectorInteractionChange((change) => {
  if (change.type === 'pending') {
    const binding = this.roomBindings?.bindingForSession(change.sessionId);
    eventFanOut.broadcast('interaction_pending', InteractionPendingEventSchema.parse({
      sessionId: change.sessionId,
      cwd: change.cwd,
      interaction: change.interaction,
      ...(binding ? { roomId: binding.roomId, roomAuthorId: binding.authorId } : {}),
    }));
    return;
  }
  eventFanOut.broadcast('interaction_resolved', InteractionResolvedEventSchema.parse({ … }));
});
```

`roomBindings` is a **port injected at `start()`**, not an import: the broadcaster must not reach into `services/rooms/`. `RoomSessionLedger` (`room-session-ledger.ts`) gains one method beside `list()` (:97):

```ts
/** The room binding a session answers for, or `undefined` when it answers for none. */
bindingForSession(sessionId: string): RoomSessionBinding | undefined;
```

It is a single indexed read on `room_sessions`, and it is redirect-aware through the same `successorFor` (:202) path the ledger already uses, so a session rekeyed mid-turn still resolves to its room. `apps/server/src/index.ts` wires the ledger in where both already exist.

### 3.3 `GET /api/sessions/pending-interactions`

```
GET /api/sessions/pending-interactions
→ 200 PendingInteractionsResponse
```

Registered in `routes/sessions.ts` **above** `router.get('/:id', …)` (:169), because Express 5 would otherwise match `pending-interactions` as an `:id`. This is the one ordering trap in the route file and the reason the route is not named `/:id/…`-shaped.

The source is a new module-level function beside `listProjectorStatuses()` (`session-state-projector.ts:1886`):

```ts
/**
 * Every pending interaction across every live projector, with server-authoritative
 * `remainingMs` and expired entries excluded.
 *
 * Bounded exactly as {@link listProjectorStatuses} is: a projector lives until its
 * session is evicted or the process restarts, so this answers for the recent fleet
 * and never for all history. That is the same bound the live fan-out has always had.
 */
export function listPendingInteractionsAcrossSessions(
  now: number = Date.now()
): Array<{ sessionId: string; cwd: string; interaction: PendingInteractionDTO }>;
```

It delegates per projector to `getPendingInteractions(now)` (:1372), which delegates to the canonical `listPendingInteractions` selector (`pending-interactions.ts:61`), so the expiry semantics cannot fork — the rule that method's own TSDoc states.

The route joins each row with `bindingForSession` and answers. `warnings` is present but empty today; it exists because the same route is the natural home for a future runtime that cannot answer, and adding the field later would be a breaking response change.

**Authority on the read:** the list is scoped to the caller the same way `GET /api/sessions` is (`sessionGate`, mounted app-wide at `app.ts:159`). It carries no more than the per-session stream already gives an attached client. It does **not** run the operator-cookie bar — reading that something needs a person is not deciding it, and the header pill must render for a cockpit that has not yet proven itself for a decision. Deciding runs the bar (§3.4).

### 3.4 Authority: who may answer

Today the six answer routes (`routes/sessions.ts:761, 782, 806, 828, 845, 897`) are protected by `sessionGate` alone. That was defensible while the only way to reach them was the session you were looking at. Broadcasting the Ask everywhere makes them reachable from everywhere, and DOR-609's lesson is that _who acted_ is not _who may_.

Add one shared guard in `routes/sessions.ts`, modelled line for line on `routes/approvals.ts:169-219`:

```ts
/**
 * Refuse anything that is not a person in the cockpit answering for themselves.
 *
 * Fail-closed and structural: an agent that presents its identity header can
 * never answer ANY prompt, its own included, because `readCallerAuthority`
 * reports `agentIdentityPresented` for a header that did not even resolve. Under
 * login-on, a caller holding a per-user API key is refused too — an agent
 * legitimately holds one of the person's keys, which is exactly the residual
 * DOR-474 closed for capability approvals and this closes for tool prompts.
 */
function requirePersonToAnswer(req: Request, res: Response): OperatorCookieRefusal | undefined;
```

Composed from the shipped pieces, no new predicate:

1. `readCallerAuthority(req, res)` (`lib/caller-authority.ts`) → `resolveDecisionAuthority(...)`. Refuse when the caller is not a person acting for themselves. **`agentIdentityPresented` is the "the requester never self-approves" rule**, made structural rather than by comparing ids: the answer path simply is not reachable by anything presenting an agent identity, so there is no id to compare and no way to spoof one.
2. `requireOperatorCookieUnderLogin(res, 'whether a tool runs')`. With login off it allows (there is no cookie for anyone to present) — the named, documented residual, identical to capability approvals.

Refusals answer `403` with the existing `OperatorCookieRefusal` shape (`{ status, code, error }`), so the client's `decision-refusal.ts` copy path (`features/approvals/lib/`) already renders them.

**"Eligible approver" stated exactly:**

| Who                                               | Eligible when                                                                                       | Enforced by                                                                                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The local operator** (cockpit, this machine)    | login off: always. login on: a browser session cookie, no agent identity header, no approval token. | `requirePersonToAnswer` on all six routes                                                                                                                                           |
| **A person in a bridged room** (Telegram / Slack) | their platform user id is in that adapter's configured approver allowlist                           | `mayApprove(allowlist, userId)`, `packages/relay/src/adapters/approver-allowlist.ts:75-80` — already shipped on the relay approval path, **unchanged and not widened by this spec** |
| **The requesting agent**                          | never                                                                                               | (1) above; no exception exists                                                                                                                                                      |
| **Any other agent**                               | never                                                                                               | (1) above                                                                                                                                                                           |

The two approver sets never merge: the cockpit's bar is the operator cookie, the bridge's bar is its own allowlist, and neither can satisfy the other. An empty or malformed allowlist means nobody, never anyone (`approver-allowlist.ts` module doc: _"absence is not consent"_).

### 3.5 The room half — deliberately zero server change

**Decision: the room correlates through the global `interaction_pending`, carrying `roomId`. There is no new room signal, and `RoomTurnWaiting` is not touched.**

Why the global event and not a room signal:

- The card has to render on routes that are not the room — the header pill, the sidebar, the home triage. So the global event is required _anyway_; a room-scoped duplicate would be a second source of one fact, free to disagree, and the both-ends allowlist rule would then have to be paid twice.
- Room signals are **not replayed** (`specs/room-presence` §3.2, and the no-`id:` framing). A person opening a room while an Ask is already live would need the list-on-mount regardless — which is global. A room signal would therefore cover strictly less ground at strictly more cost.
- The mapping already exists server-side (`RoomSessionLedger`), and `roomId` on a per-caller stream leaks nothing the caller's own room list does not already show.

Why `RoomTurnWaiting` (`room-turn-port.ts:87-95`) keeps exactly its two fields:

Its only consumer is `reportWaiting` (`notice-log.ts:378`) → `buildWaitingNotice` (`notice-copy.ts:181`), which by design carries no tool name, no question and no countdown, damped once per room+agent. Adding `sessionId` and `interactionId` to it would add fields with no reader, which is the kind of speculative widening this repo removes rather than accumulates. **Everything on the room side stays as shipped**: `WAITING_NOTICE_GRACE_MS = 60_000` (`room-turn-runner.ts:489`), the `WAITING_KINDS` map (:510-514), the grace-armed `bounds.onWaiting` (:625-636), and the three sentences at `notice-copy.ts:206-213`, word for word.

The result is the design the ideation asked for and the screen drew: **the live card is instant and ephemeral; the durable notice is late and vague, and it is the log.** A second-answered Ask still leaves no line, because the grace timer is still cleared by `interaction_resolved` (`room-turn-runner.ts:637`).

### 3.6 The allowlist, both ends

`'interaction_pending'` and `'interaction_resolved'` are added to `GENERIC_EVENTS` (`apps/client/src/layers/shared/lib/transport/stream-manager.ts:202-264`) **in the same pull request** that adds the broadcasts, with a comment in the house style saying what they are. `apps/server/src/services/core/__tests__/sse-event-allowlist.test.ts` proves both directions and goes red if either half is missing. Neither name goes in `NOT_BROADCAST_BY_LITERAL` (:62-66) — both are literal broadcasts.

---

## 4. The Ask — client

### 4.1 The store

**Decision: `entities/attention`, not `entities/session`.**

The forcing argument is the layer rule: `entities/attention` must read this store (its whole job is "what needs me"), and an entity may not import a sibling entity (`.claude/rules/fsd-layers.md`: _"Entity importing sibling entity: WRONG"_). Putting it in `entities/session` would make the one consumer that matters illegal. `entities/attention` is also where its twin already lives — `use-pending-approvals.ts` — so the two queues sit side by side and are read the same way.

```
layers/entities/attention/model/use-pending-interactions.ts
```

Shape, mirroring `use-pending-approvals.ts` exactly:

```ts
export const PENDING_INTERACTIONS_QUERY_KEY = ['pending-interactions'] as const;

/**
 * Every prompt anywhere in the fleet that is waiting on a person.
 *
 * Seeded on mount from `transport.listPendingInteractions()` and then kept live
 * by the global stream, so a window that opened after an Ask was raised shows it
 * as fast as one that was watching.
 */
export function usePendingInteractions(): {
  interactions: readonly InteractionPendingEvent[];
  isLoading: boolean;
};
```

Live updates are two `useEventSubscription` calls writing through `queryClient.setQueryData` — the pattern `use-tunnel-sync.ts` establishes and `contributing/state-management.md` documents:

- `interaction_pending` → upsert by `interaction.id`.
- `interaction_resolved` → remove by `interactionId`, and hand the outcome to the receipt store (§4.5) so the card can morph rather than vanish.

**Dedupe against the per-session store.** `entities/session/model/session-stream-store.ts:88` holds `pendingInteractions` for the one attached session, fed by the seq'd per-session stream (reducer :802-810, :820-825). Both hold the same `id` (the projector's). The rule, stated once:

> The **global** store is the single source for the card family (header pill, sidebar, home, the room lane). The **per-session** store keeps owning the inline prompt inside the transcript. For an id present in both, `remainingMs` comes from the per-session DTO (it is seq'd and fresher) and `roomId` from the global one.

So the attached session shows exactly one card in the transcript and one entry in the tray, and answering either resolves both through `interaction_resolved`.

### 4.2 `entities/attention` gains a real signal

`derive-attention-signals.ts` (:170) currently degrades a non-attached blocked session to `permission-prompt` with copy "Waiting on you", and says so in the comment at :193-208. That comment is deleted with the degradation.

- `AttentionSources` gains `interactions: readonly InteractionPendingEvent[]` from `usePendingInteractions()` (replacing the attached-session-only `interactions` record).
- The `blocked` branch (:191-222) reads the interaction's real `type`, so the kind is now exact for **every** session:
  - `approval` → `permission-prompt`
  - `question` → `question`
  - `elicitation` → `permission-prompt` (an MCP server's prompt is answered like a permission ask; that reading was already the right one and stays)
- `secondary` becomes the Ask's own words — "wants to edit `standup.md`" from `displayName` / `blockedPath` — instead of the placeholder "Waiting on you".
- `since` is `new Date(interaction.startedAt).toISOString()` for every session, not just attached ones.
- `AttentionSignalKind` is unchanged. The four kinds were never the problem; not knowing which one was.

Downstream, `features/dashboard-sidebar`'s `select-now-items.ts` stops giving a background agent's _question_ the shield glyph, which is the visible half of the same defect.

### 4.3 One card family — `features/ask`

**Decision: a new `features/ask` slice owning the card chrome, with `features/approvals` re-based onto it.** Not "extend `ApprovalCard`", and not "generalize `ToolApproval`".

The reason is that the two are different objects, and merging their data would be wrong: a capability approval is a persisted, ULID-keyed request with a two-hour window; an Ask is an in-memory hold on a live turn with a ten-minute one. What they share is entirely presentational. So the _chrome_ is extracted and both adopt it.

```
layers/features/ask/
├── ui/
│   ├── AskCard.tsx            AskCard.{Root,Face,Headline,Detail,Countdown,Actions,Receipt}
│   ├── InteractionAsk.tsx     the adopter for an InteractionPendingEvent (all three kinds)
│   ├── AskStack.tsx           the burst form (replaces BatchApprovalBar)
│   ├── AskList.tsx            the tray body
│   ├── ApprovalPrompt.tsx     ← moved from features/chat/ui/tools/ToolApproval.tsx
│   ├── QuestionPrompt.tsx     ← moved
│   ├── ElicitationPrompt.tsx  ← moved
│   ├── AskReceipt.tsx         ← moved from ApprovalReceipt.tsx (+ AskReceiptRow)
│   └── QuestionAnswerSummary.tsx ← moved
├── model/
│   ├── use-answer-ask.ts      one mutation, fans by kind to the six transport methods
│   ├── use-ask-shortcut.ts    ⌘⇧A
│   └── ask-exit-transition.ts ← moved from features/approvals/lib/approval-exit-transition.ts
├── lib/
│   ├── ask-headline.ts        the one sentence: "<agent> wants to <verb> <target>"
│   └── format-time-left.ts    ← moved from features/approvals/lib/ (shared by both card kinds)
└── index.ts
```

Who renders what, after:

| Surface                                                                                  | Renders                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Header pill (`widgets/approvals-indicator`, 279 lines)                                   | `AskList` — capability approvals and Asks in one list, ordered by time left. Its count becomes both.                                                   |
| Sidebar _Heads up_ (`features/dashboard-sidebar`, label at `build-sidebar-model.ts:390`) | rows from `useAttentionSignals()`, now carrying the real kind (§4.2)                                                                                   |
| Home triage (`widgets/home/ui/PinnedTriageHeader.tsx`, 117)                              | `AskList`                                                                                                                                              |
| The room / session live lane                                                             | `InteractionAsk` grown from the lane (§5.2)                                                                                                            |
| The session transcript, inline                                                           | `ApprovalPrompt` / `QuestionPrompt` / `ElicitationPrompt` from `AssistantMessageContent.tsx:327, 416, 483` — same components, now built on `AskCard.*` |
| `features/approvals`' `ApprovalCard` (288)                                               | keeps its own data and hooks; its markup becomes `AskCard.*`                                                                                           |

FSD: `features/approvals` and `features/chat` rendering `features/ask` components is **UI composition across features**, explicitly allowed. Neither imports the other's model.

### 4.4 Behaviour

**Headline copy** (`lib/ask-headline.ts`, one function, unit-tested):

| Kind        | Line                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| approval    | `{agent} wants to {verb} {target}` — verb and target from `displayName` / `title` / `blockedPath`, falling back to `{agent} needs your OK to run {toolName}` when the prompt gives neither |
| question    | `{agent} has a question`                                                                                                                                                                   |
| elicitation | `{agent} needs something from {serverName}`                                                                                                                                                |

Plain, active, one idea per sentence — `writing-for-humans`. The card never invents a diff stat or a preview the prompt did not supply (`design-decisions.md` §3).

**Countdown.** From `startedAt + timeoutMs` inside the DTO, ticked locally at 1 s. `formatTimeLeft` is reused. Thresholds from `research/20260316_tool_approval_timeout_visibility_ux.md`: neutral above 2 min, **warn at 2 min**, **urgent at 60 s**. The bar is a linear `<progress>`-shaped div with `aria-hidden`; the accessible countdown is the text.

**Keyboard.** `A` allows and `D` denies **only when the card has focus** — never a document-level hotkey, because an Ask that lands while you are typing must not swallow a keystroke. `⌘⇧A` (`useAskShortcut`) moves focus to the next unanswered Ask, opening whatever surface holds it. Both are additive to `ToolApproval`'s existing in-card key handling (`ToolApproval.tsx:505`).

**Focus.** An arriving Ask never steals focus. It arrives with the message-entrance grammar (fade + 8 px) and announces itself once through the existing `useApprovalAnnouncer` live region (`MessageList.tsx:29`, region at :522-527) — which the lane reuses rather than adding a second announcer (§5.6).

**Bursts.** Two or more pending Asks with the same `sessionId` **and** the same `interaction.type === 'approval'` **and** the same `toolName` collapse into one `AskStack`: _"Meeting Notes wants to read 5 files ▾"_, expandable to the list, with **Allow all** mapping to `transport.batchApprove(sessionId, toolCallIds)` and **Deny all** to `batchDeny`. Different agents never stack. This is the shipped `BatchApprovalBar` behaviour, generalized and given the card's chrome.

**Receipts.** On `interaction_resolved` the card morphs in place rather than disappearing, using the shipped exit transition (`RESOLVE_HOLD_S = 0.4`, `MELT_S = 0.2`, `approval-exit-transition.ts:10,13,37`):

| Outcome                                                       | Line                                         |
| ------------------------------------------------------------- | -------------------------------------------- |
| answered by this window                                       | `You allowed this` / `You said no`           |
| answered elsewhere, `resolvedBy` known                        | `Already allowed by {resolvedBy} at {hh:mm}` |
| answered elsewhere, no name                                   | `Already answered at {hh:mm}`                |
| `cancelled` (session gone, agent restarted, turn interrupted) | `No longer needed`                           |
| `expired`                                                     | `Nobody answered in time`                    |

Every one is a receipt, never a disappearance. The rule from the design screen — _"never a button that does nothing"_ — is implemented as: the actions are removed at the same frame the receipt text appears, and a click that races the resolution is answered by the server's own idempotent no-op (`session-store.ts:461` returns `false` for an unknown id) and shows the receipt.

**Optimism.** Answering writes the receipt immediately and removes the entry from the query cache, then waits for `interaction_resolved` to confirm. A rejected mutation restores the card and surfaces the refusal copy (`decision-refusal.ts`) — including the 403 from §3.4, which reads as one sentence about needing to be signed in on this machine.

### 4.5 Transport

One method. Answering reuses the six that already exist.

```ts
// packages/shared/src/transport.ts — in the Transport interface (507-2382),
// beside approveTool (:733) … submitElicitation (:770)

/**
 * Every prompt across the fleet that is waiting on a person, with
 * server-authoritative time left. The seed for the live stream; see
 * `GET /api/sessions/pending-interactions`.
 */
listPendingInteractions(): Promise<PendingInteractionsResponse>;
```

| Implementation    | File                                                                               | Behaviour                                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HttpTransport`   | `apps/client/src/layers/shared/lib/transport/session-methods.ts` (beside :404-471) | `fetchJSON(baseUrl, '/sessions/pending-interactions')`                                                                                                                                                                                          |
| `DirectTransport` | `apps/client/src/layers/shared/lib/direct/session-methods.ts` (beside :296-337)    | in-process call to the same `listPendingInteractionsAcrossSessions` + ledger join. **A real implementation, not a stub** — the embed already implements all six answer methods for real, so a stubbed list would be the only half-working half. |

`embedded-mode-stubs.ts:474-497` (the capability-approval stubs) is untouched: capability approvals genuinely do not exist in the embed, and Asks genuinely do.

---

## 5. The live lane

### 5.1 Geometry, and the layout-shift guarantee

One component, `Conversation.LiveLane`, mounted by `Conversation.Root`'s children **as a flex sibling of the scroller**, directly above `Conversation.Composer`. Not inside the scrolling element — `RoomSurface.tsx:36-46` documents why in full: a height change inside the scroller moves `scrollHeight` under `useStickToBottom`, which un-pins a reader who never scrolled.

| Property   | Value                                                                            | Why                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Height     | **fixed `h-6` (24 px)**, never `min-h`                                           | The guarantee is that the number is constant. 24 px is the smallest step on the spacing scale that gives a 12 px line a 4 px optical gutter either side; the mockup's ~22 px is not on the scale. |
| Typography | `text-xs` (12/16), `text-secondary`, agent names `text-primary font-medium`      | matches `ChatStatusStrip` and `RoomPresenceLine` today                                                                                                                                            |
| Padding    | `px-3`, matching the composer's own inset                                        | the lane reads as the composer's shoulder, not a band                                                                                                                                             |
| Overflow   | `flex items-center gap-2 overflow-hidden`, the text node `truncate`              | **it never wraps**; the peek carries what is cut                                                                                                                                                  |
| Empty      | an empty div of the same height, `aria-hidden="true"`, no border, no placeholder | a quiet room looks quiet; the dashed box in the mockup was an annotation                                                                                                                          |
| Mobile     | identical height and rules                                                       | 24 px is affordable on a phone; a lane that grew on a phone would break the one property it exists for                                                                                            |

Mounted **once per conversation surface**. The room's thread panel (`RoomThreadPanel.tsx:419, 438`) composes its own `Conversation.Root` and therefore its own lane, scoped to the thread — which is how the "replying in a thread" state stays one claim on one line.

### 5.2 The state machine

`features/conversation/model/lane-state.ts`, a pure function with no React, modelled on `deriveStripState` (`features/chat/ui/status/strip-state.ts`) — which it absorbs.

```ts
export type LaneState =
  | { kind: 'ask'; ask: InteractionPendingEvent; count: number }
  | { kind: 'stalled' }
  | {
      kind: 'presence';
      sentence: string;
      authorIds: readonly string[];
      since: string;
      late: boolean;
    }
  | { kind: 'turn-waiting'; waitingType: 'approval' | 'question'; elapsed: string }
  | { kind: 'turn-progress'; message: string; determinate: boolean; percent: number | null }
  | { kind: 'turn-system'; message: string }
  | {
      kind: 'turn-streaming';
      verb: string;
      verbKey: string;
      elapsed: string;
      tokens: string;
      isBypass: boolean;
    }
  | { kind: 'turn-complete'; elapsed: string; tokens: string }
  | { kind: 'queued'; depth: number }
  | { kind: 'empty' };

export function deriveLaneState(input: LaneStateInput): LaneState;
```

**Priority, first match wins.** Each rung names the capability that gates it and the source it reads.

| #   | State            | Gate                      | Source                                                                                                    |
| --- | ---------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | `ask`            | `capabilities.asks`       | `usePendingInteractions()` filtered to this conversation (`sessionId` for a session, `roomId` for a room) |
| 2   | `stalled`        | always                    | the surface's own stream state (`use-room-stream`'s `stalled`; the session's `syncConnectionState`)       |
| 3   | `presence`       | `capabilities.presence`   | `useRoomPresence(roomId, scope)` (`use-room-presence.ts:341`)                                             |
| 4   | `turn-waiting`   | `capabilities.turnStatus` | today's `deriveStripState` priority 1                                                                     |
| 5   | `turn-progress`  | `capabilities.turnStatus` | priority 2 (compaction and friends)                                                                       |
| 6   | `turn-system`    | `capabilities.turnStatus` | priority 3                                                                                                |
| 7   | `turn-streaming` | `capabilities.turnStatus` | priority 4 — verb through `activityVerb`, elapsed, tokens, the bypass warning                             |
| 8   | `turn-complete`  | `capabilities.turnStatus` | priority 5, auto-dismisses                                                                                |
| 9   | `queued`         | `target.queueDepth > 0`   | the composer's own queue                                                                                  |
| 10  | `empty`          | —                         | —                                                                                                         |

Three rungs earn their place in that order and are worth stating:

- **`stalled` beats `presence`, and that is not new.** `specs/room-presence` §5.4: a client that cannot read the stream must not claim to know who is working. The presence store is cleared, not merely hidden.
- **`ask` beats `stalled`.** An Ask that is already in hand is still true and still answerable even when the stream has gone quiet — the countdown runs off `startedAt`, not off the wire. A stalled stream that hides a live Ask would recreate the exact failure this programme exists to remove.
- **`turn-waiting` (rung 4) survives even though rung 1 exists.** They are different facts: rung 1 is "there is an Ask _object_ here you can answer"; rung 4 is "this session's turn is parked" in a state the projector reported without a DTO in hand (a capability hold, a runtime that reported `blocked` without a prompt). Collapsing them would make the second silently invisible.

**Presence content**, unchanged in words: `presenceSentence(names, state)` (`presence-copy.ts:71-76`) at one to three names, `presenceCountSentence(count, state)` (:89-92) above that, elapsed from the oldest claim's `since`, no timer under 10 s. Avatars stack in front of the sentence via `IdentityAvatar`, capped at three plus a `+N` disc.

**Ask content**, one line: amber `needs-you` dot, the agent's face, `askHeadline(ask)`, and the word **Answer** as the affordance. Clicking or pressing Enter grows the lane into the `InteractionAsk` card (§5.5).

### 5.3 The peek

`features/conversation/ui/LivePeek.tsx`, opened by clicking or pressing Enter on the lane's presence content. Built on `ResponsivePopover` (`shared/ui/responsive-popover.tsx`) so it is a popover on a desktop and a bottom sheet on a phone, with no second implementation.

One row per working agent:

```
[face]  Meeting Notes · working · 1m 04s
        Replying to “can you log today’s decisions?”        ← link, scrolls to the entry
        [ Open its session → ]  [ Stop ]
```

#### 5.3.1 Who, state, elapsed

From the presence store (`use-room-presence.ts:297` `summarize`), which already collapses several claims per author to one row at the oldest `since`. No new data.

#### 5.3.2 "Replying to …"

The presence record carries `entryId`. The host widget passes `resolveRowExcerpt(entryId)` — it already holds the timeline rows — and the link calls `timelineRef.current.scrollToRow(entryId, { flash: true })` (§2.4). No server data.

#### 5.3.3 "Open its session"

Needs the room-author → session mapping, which `GET /api/rooms/:id` does **not** carry (verified: `RoomWithRoster` has no `sessionId` on the room, the member or the roster entry), and which `specs/room-presence` §15 deliberately kept off the presence signal — _"the in-flight version waits for a design that checks the caller's right to it."_

**This spec is that design.** One new read route:

```
GET /api/rooms/:id/sessions
→ 200 { bindings: { authorId: string; sessionId: string }[] }
```

- `routes/rooms.ts`, beside `GET /:id` (:138). Resolves the caller with `resolveCaller(res)`, then `requireVisibleRoom(roomId, caller.id)` — so a room you cannot see answers 404, exactly as `getRoom` does — and `requirePersonAuthor(caller.id, 'see where a room's work runs')`, so an agent cannot enumerate other agents' sessions.
- Body from `RoomSessionLedger.list()` (:97) filtered to the room. No session content, no cwd, no status — ids only, which is the minimum that makes a link.
- Client: `entities/room/api/use-room-sessions.ts`, a TanStack Query keyed `['room-sessions', roomId]`, fetched when the peek opens (not on room mount — it is only ever needed by this affordance). The link is `/session?session={sessionId}` and is absent, not disabled, for an author with no binding.

This is the one server addition in P2, and it is named as such in §8.

#### 5.3.4 Stop — honest, and why it is the room-wide halt

The mockup draws a per-row **Stop**. A per-agent stop cannot be built honestly in this phase, for a measured reason:

- Calling `POST /api/sessions/:id/interrupt` (`routes/sessions.ts:943`) directly would bypass the room's halt bookkeeping. `RoomTriggerDispatcher.halt` (`room-trigger.ts:2386`) marks `haltedTurns` **before its first `await`** precisely because _"a turn whose stream closes while this method is still delivering interrupts must find the mark already there, or it posts the answer Stop was pressed to prevent — the two-second race measured on 2026-08-15."_ An interrupt that skipped the mark would re-open that race.
- A genuine per-author halt is not a filter on that function. `halt` also writes one `halted` notice for the whole room (`reportHalted(room, claims.length)`) and drops the room's entire gather buffer. A per-author version needs its own notice copy and a scoped buffer drop, which is a room-conduct decision with its own review.

So, and this is the design rather than a compromise:

| Working agents | What the peek offers                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| exactly one    | a **Stop** button on that row. It calls `haltRoom` and stops that agent, because it is the only one.  |
| two or more    | no per-row Stop. One footer action, **Stop everything in this room**, with the count ("Stops all 3"). |

A button never stops work the person did not mean to stop, and it never claims a precision the server does not have. The per-author halt is filed as a follow-up (§9).

The **session** surface's peek has no Stop: the session composer already has one, and a second would be two buttons for one verb.

### 5.4 Copy

Existing sentences are kept verbatim: `presenceSentence` / `presenceCountSentence` (`presence-copy.ts:71-92`), the three `WAITING_LINES` (`notice-copy.ts:206-213`), and `ChatStatusStrip`'s verb ladder through `activityVerb`. New strings, all held to `writing-for-humans` (short, active, no em dashes, one idea each):

| Where           | String                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| lane, Ask       | `{agent} needs your OK to {verb} {target}` · `Answer`                                                                                                        |
| lane, queued    | `1 queued` / `{n} queued`                                                                                                                                    |
| peek, row state | `working` · `still working`                                                                                                                                  |
| peek, action    | `Open its session`                                                                                                                                           |
| peek, single    | `Stop`                                                                                                                                                       |
| peek, several   | `Stop everything in this room` (`Stops all {n}`)                                                                                                             |
| receipt         | `You allowed this` · `You said no` · `Already allowed by {name} at {hh:mm}` · `Already answered at {hh:mm}` · `No longer needed` · `Nobody answered in time` |
| tray, empty     | `Nothing needs you`                                                                                                                                          |

### 5.5 Motion — the budget from `01-ideation.md` §6 #11, unchanged

| Moment                  | Motion                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lane content changes    | `AnimatePresence mode="wait"` crossfade, **150–200 ms**, keyed on the state's discriminant plus its label (`verbKey`'s existing trick, so it animates on a real change and stays still otherwise) |
| Working dot             | the shipped `STATUS_DOT_PULSE` (`shared/ui/status-dot.ts`), `motion-safe:animate-pulse`; nothing else in the lane moves                                                                           |
| Ask arrival             | the message-entrance grammar: fade + 8 px, spring `stiffness: 320, damping: 28`                                                                                                                   |
| Ask grows into the card | the lane's content is the card's collapsed state; the growth is a height + opacity transition, **300 ms** ease-in-out, matching the tool-card expand                                              |
| Reply hand-off          | lane content fades **160 ms** while the reply rises (`specs/room-presence` §5.4, made literal)                                                                                                    |
| Peek open               | `ResponsivePopover`'s own entrance; nothing added                                                                                                                                                 |
| Reduced motion          | `useReducedMotion()` and branch **off**, not shorter. The end states all read statically: the dot is present, the text is present, the card is open.                                              |

No new duration, curve or token is invented. `contributing/design-system.md` §Motion is the catalogue; §Identity's grammar governs anything that draws a face.

### 5.6 Accessibility

- **The lane is `role="status" aria-live="polite" aria-atomic="true"`** on its text node only, replacing `RoomPresenceLine`'s announcer (:103-107) one for one — same politeness, same atomicity, same `data-testid` split by scope (`room-presence-announcer` / `thread-presence-announcer`) so the shipped browser tests keep their handles.
- **Asks are announced by the existing approval announcer**, not by the lane. `useApprovalAnnouncer` (`MessageList.tsx:29`, region at :522-527) already owns that job and outlives the card, which is the reason `ToolApproval.tsx:225-229` gives for not announcing resolutions from the card. Two live regions both announcing an Ask is the siren the sidebar's own contract forbids.
- **Counts, not verbs.** The lane announces the sentence it shows and nothing more; it never announces elapsed ticks. This is the sidebar's rule (`contributing/design-system.md` §Zones → "One live region, counts only") applied to the second place a fleet of agents could turn a screen reader into a siren.
- **The lane is one tab stop.** Enter or Space opens the peek (or the Ask card); Escape closes it and returns focus to the lane. It is never in the tab order when `empty` (`tabIndex={-1}`, `aria-hidden`).
- **Focus-visible parity**: the lane's hover affordance (a tint step) has an explicit `focus-visible:` twin, per the design system's parity rule.
- **Colour is never the sole indicator**: the amber Ask state carries the word "Answer"; the working dot is paired with the sentence.

---

## 6. Dev Playground

### 6.1 The Conversation page

The `chat` page becomes **Conversation**, restructured into five sections. The Rooms page keeps what is genuinely room-only.

| Section         | Shows                                                                                                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Surfaces**    | session, room and DM **side by side from one fixture set** — the same rows rendered through the three capability objects. This is the section that makes a regression in the unification visible in one glance.                                                                          |
| **Message row** | the matrix: `anchor` (corner × rail) × `role` (user × assistant) × `density` (comfortable × compact) × capabilities (reactions on/off, threads on/off, run-with on/off, tool cards on/off)                                                                                               |
| **Timeline**    | day and unread dividers, grouping, the unread cursor, thread grouping, the pending list, the skeleton, the empty state, and a long virtualized run                                                                                                                                       |
| **Live lane**   | **every** `LaneState`: empty · presence at 1/2/3/4+ · working_late · thread scope · stalled · queued · each of the five `turn-*` states · Ask (single) · Ask (stack) · the receipt set · reduced-motion. Plus the peek (one agent, several agents) and the Ask card grown from the lane. |
| **Composer**    | the one host against both `ConversationTarget` adapters: idle, typing, attachments, mentions, queue depth, an Ask takeover, and the archived/`canSend: false` state                                                                                                                      |

Showcase moves:

| Today                                                                                                                          | Becomes                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MessageShowcases.tsx`                                                                                                         | _Message row_ (rewritten against `Message.*`)                                                                                                                  |
| `StatusShowcases.tsx` (the strip half)                                                                                         | _Live lane_                                                                                                                                                    |
| `RoomPresenceShowcases.tsx` (`RoomPresenceLine` section, registered on the **identity** page at `identity-sections.ts:95`)     | _Live lane_ — the entry moves to the Conversation page, and the identity page loses it                                                                         |
| `InputShowcases.tsx`                                                                                                           | _Composer_                                                                                                                                                     |
| `ApprovalsShowcases.tsx`, `ApprovalReceiptShowcases.tsx`, the approval parts of `ToolShowcases.tsx`                            | one **Asks** section on the Conversation page (the card family), with the capability-approval card cross-listed from Subsystems per the skill's borrow pattern |
| `RoomThreadShowcases.tsx` row-rendering demos                                                                                  | retired — they re-render rows the _Surfaces_ section now shows for real                                                                                        |
| `RoomsShowcases.tsx`, `RoomDeliveryShowcases.tsx`                                                                              | stay on **Rooms** (header, roster, delivery, bridge)                                                                                                           |
| `StatusLineShowcases.tsx`, `TrustDialShowcases.tsx`, `SessionInspectorShowcases.tsx`, `ChipShowcases.tsx`, `MiscShowcases.tsx` | stay; `StatusLineShowcases` is `ChatStatusSection`'s line, which is **not** the lane (§1.1)                                                                    |

`PageConfig.label` becomes **"Conversation"**, `description` is rewritten, `group` stays `session` (its group in `playground-config.ts:173-182`).

### 6.2 The rename is seven files, and the skill has a stale line

Renaming the page id `chat` → `conversation` and its array `CHAT_SECTIONS` → `CONVERSATION_SECTIONS`:

1. `dev/playground-registry.ts:7` — the `Page` union member.
2. `dev/playground-registry.ts` — the named re-export **and** the aliased import spread into `PLAYGROUND_REGISTRY`.
3. `dev/playground-config.ts:173-182` — the `PageConfig` (`id`, `label`, `path`, `sections`).
4. `dev/playground-pages.ts:59` — the `PAGE_COMPONENTS` key.
5. `dev/sections/chat-sections.ts` → `conversation-sections.ts` — all **51** entries carry `page: 'chat'`.
6. `dev/pages/ChatPage.tsx` → `ConversationPage.tsx`.
7. `dev/__tests__/playground-registry.test.ts` — the hardcoded union in _"PLAYGROUND_REGISTRY equals the union of all page-level arrays"_ lists every section array **by name**.

(The other page-list assertions — `PAGE_ORDER`, `every-showcase-mounts.test.tsx`, `OverviewPage.test.tsx` — are all derived from `PAGE_CONFIGS`/`PAGE_COMPONENTS` and need no edit. No router entry exists: `getPageFromPath()` matches `path` generically.)

**Fix the skill as part of this work.** `.claude/skills/maintaining-dev-playground/SKILL.md:233` says _"Add the page component to `PAGE_COMPONENTS` in `dev/DevPlayground.tsx`"_. `PAGE_COMPONENTS` moved to `dev/playground-pages.ts:54` (DOR-1117, so it can be imported without the shell). Line 233 and the "Files to Know" table's `dev/DevPlayground.tsx` row are corrected in P4.

---

## User Experience

1. **Dorian asks in #mio:** "Meeting Notes, can you log today's decisions?" Within a second the lane above the composer reads `Meeting Notes is working on it`, and starts counting at ten seconds. Nothing moved: the lane was already there, blank.
2. **Meeting Notes needs permission** to edit `notes/2026-08-17-standup.md`. Instantly the lane turns amber: `Meeting Notes needs your OK to edit standup.md · Answer`. At the same moment the header pill goes to "1 needs you", the sidebar's Heads up row says "wants to edit standup.md" with the time left, and the home triage header lists it. Nothing steals focus; the half-typed message in the composer is untouched.
3. **Dorian clicks Answer.** The lane grows into the card: who, the verb, the file, the agent's reason, time left with a thin bar, and **Allow** / **Deny** / **Open session**. He presses `A`. The card becomes `You allowed this`, then settles out. Every other surface clears in the same beat.
4. **Or he was on `/tasks`.** He presses `⌘⇧A`, the pill's tray opens focused on the Ask, and he answers there. Same card, same result, no navigation.
5. **He was at lunch.** The prompt times out at ten minutes. The room's late notice still reads exactly as it does today — vague, no path, no countdown — and the tray's card says `Nobody answered in time`. That failure is not fixed here; §9 says who fixes it.
6. **Three agents are working.** The lane reads `3 agents are working on it`. He clicks it: a peek lists each one with its face, state and elapsed time, what it is replying to (clicking scrolls the timeline there and flashes the row), and **Open its session**. At the bottom: **Stop everything in this room · Stops all 3**.
7. **A second person in a bridged Slack room** who is not on the approver list sees none of that. They see the room's ordinary late notice: "Meeting Notes is waiting for you to approve something before it can carry on." No file name, no command, no button.
8. **The connection drops.** The lane stops claiming to know: presence clears and the stalled notice takes the line. A live Ask stays, because its clock never came off the wire.
9. **The session chat** shows the same lane in the same place, with its own content: `Working · 42s · ~3.2k tokens`, the compaction progress bar, the permission-mode warning, and the completed flash — the things `ChatStatusStrip` says today, now in the shape every surface shares.

---

## Testing Strategy

House rule (`.claude/rules/testing.md`): every check below can fail, and the seeded defect that turns it red is named. jsdom reports every element as `0 × 0`, so nothing geometric is settled in a unit test.

### Unit (vitest)

| File                                                                                  | Asserts                                                                                                                                                                        | Seeded defect                                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `features/conversation/model/__tests__/lane-state.test.ts`                            | the full priority table §5.2, rung by rung, including `ask` over `stalled` and `stalled` over `presence`; each capability flag gating its rung                                 | swap rungs 2 and 3 → the stalled-beats-presence case goes red                                |
| `features/conversation/lib/__tests__/row-kinds.test.ts`                               | `buildTimelineRows` output maps to the six row kinds; day and unread dividers land where `unreadPlacement` says                                                                | change `GROUP_GAP_MS` → grouping assertions go red                                           |
| `features/ask/lib/__tests__/ask-headline.test.ts`                                     | one line per kind, plus the fallback when `displayName` and `blockedPath` are both absent                                                                                      | drop the fallback → red                                                                      |
| `features/ask/model/__tests__/use-answer-ask.test.ts`                                 | each kind routes to the right transport method; a burst routes to `batchApprove`                                                                                               | route `question` to `approveTool` → red                                                      |
| `entities/attention/__tests__/use-pending-interactions.test.tsx`                      | list-on-mount seeds; `interaction_pending` upserts by id; `interaction_resolved` removes; a duplicate id from both sources yields one entry with the per-session `remainingMs` | make the upsert append → the dedupe assertion goes red                                       |
| `entities/attention/__tests__/derive-attention-signals.test.ts` (extend)              | a **non-attached** blocked session with a `question` interaction produces `kind: 'question'`, not `permission-prompt`                                                          | revert to the degradation → red. _This is the test the comment at :193-208 was waiting for._ |
| `apps/server/src/services/session/__tests__/session-state-projector.test.ts` (extend) | `trackInteraction` fires one `pending`; a resolution fires one `resolved` with `answered`; expiry fires `expired`; listeners are throw-isolated                                | remove the notify call → red                                                                 |
| `apps/server/src/services/session/__tests__/pending-interactions.test.ts` (extend)    | `listPendingInteractionsAcrossSessions` excludes expired entries and spans several projectors                                                                                  | return the raw map → the expiry assertion goes red                                           |
| `apps/server/src/services/rooms/__tests__/room-session-ledger.test.ts` (extend)       | `bindingForSession` resolves a retired id through `successorFor`                                                                                                               | drop the redirect → red                                                                      |

### Server route tests

`apps/server/src/routes/__tests__/sessions-pending-interactions.test.ts` (new), using `FakeAgentRuntime` and `@dorkos/test-utils` scenarios:

- `GET /api/sessions/pending-interactions` returns one envelope per parked session, with `roomId` present only for room-bound ones and `remainingMs` recomputed at read time. **Seed:** freeze `remainingMs` at emit → the recompute assertion goes red.
- The route resolves ahead of `GET /:id`. **Seed:** register it after → the request 404s as a session id.
- **Authority, six routes × three callers.** For each of `approve`, `deny`, `batch-approve`, `batch-deny`, `submit-answers`, `submit-elicitation`: a person in the cockpit succeeds; a caller presenting `X-DorkOS-Agent` is refused 403 **even for an interaction it did not raise** (the requester-never-self-approves rule, made structural); a caller presenting a per-user API key under login-on is refused 403. **Seed:** remove `requirePersonToAnswer` from any one route → that row goes red. This table is the whole security surface of §3.4 and it is worth its length.

`apps/server/src/routes/__tests__/rooms-sessions.test.ts` (new): `GET /api/rooms/:id/sessions` answers bindings for a member, 404s for a room the caller cannot see, and refuses an agent caller. **Seed:** drop `requirePersonAuthor` → the agent row goes red.

SSE integration via `collectDurableEvents`: a turn that parks emits `interaction_pending` on the global fan-out **before** the per-session `approval_required` reaches a late subscriber, and the resolution emits exactly one `interaction_resolved`. **Seed:** notify before `this.interactions.set` → ordering goes red.

`sse-event-allowlist.test.ts` proves `interaction_pending` and `interaction_resolved` in both directions. **Seed:** drop either literal from `GENERIC_EVENTS` → red.

### Client (RTL + jsdom, mock `Transport`)

- `features/conversation/__tests__/Message.test.tsx`: with `reactions: false` the reactions slot renders nothing; with `runWith: false` the action is absent from the menu; every part stamps its `data-slot`.
- **A source scan, in the manner of `sse-event-allowlist.test.ts`:** `features/conversation/__tests__/no-surface-switches.test.ts` greps `features/conversation/ui/` for `surface ===` and fails on any hit outside `ConversationRoot.tsx`. This is the one mechanical guarantee that decision 3 of the ideation survives contact. **Seed:** add `surface === 'room'` to a row → red.
- `features/ask/__tests__/AskCard.test.tsx`: `A`/`D` fire only when the card has focus (assert a keydown on `document.body` does nothing); the receipt replaces the actions in the same commit; a burst of five same-tool approvals renders one stack with Allow all.
- `entities/attention/__tests__/…` as above.
- Lane rendering is asserted for **content**, never for height — jsdom cannot see 24 px, and a test that implied it could would be one of the vacuous shapes `.claude/rules/testing.md` catalogues.

### Browser (`apps/e2e`)

Three flows, all on the **mock leg** (test-mode runtime, registered from a `*.spec.ts` so the shared test server is not torn down mid-park — the lock `chat/interactive-prompts.ts` documents).

| File                                                                                      | Flow                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/e2e/tests/conversation/ask-anywhere.ts` (module, registered by `chat-mock.spec.ts`) | A room-bound session parks on an approval. Assert the card appears **in the room's live lane** and in the **header pill on `/tasks`**. Answer from the header pill; assert the room lane clears to a receipt in the same window, and that the agent then streams the branch-naming sentence only an approval could produce (`APPROVED-BRANCH`) — so "the card went away" is never the assertion. |
| `apps/e2e/tests/conversation/lane-no-shift.spec.ts`                                       | Open a room with history, scroll to a known offset, record `scrollTop` and the first visible row's bounding box, publish a presence signal (`tests/rooms/room-signals.ts`'s injector), and assert **both are unchanged** while the lane's text node is non-empty. This is the browser-only claim; the reserved lane is exactly the property jsdom cannot see.                                    |
| `apps/e2e/tests/conversation/peek.spec.ts`                                                | Two agents working. Open the peek; assert two rows with names and elapsed times; click "replying to…" and assert the timeline scrolled to that entry and flashed it; assert the footer reads "Stop everything in this room · Stops all 2"; press it and assert the `halted` notice lands and the lane clears.                                                                                    |

Existing suites that must stay green unchanged, as the regression net: `tests/rooms/room-conversation.spec.ts`, `room-entry-actions.spec.ts`, `room-reactions.spec.ts`, `room-presence.spec.ts`, `room-presence-sidebar.spec.ts`, `room-sheet.spec.ts`, `room-sheet-phone.spec.ts`, `tests/chat/interactive-prompts.ts`, `live-turn-visibility.ts`, `session-read-state.ts`, `tests/streams/multi-window.spec.ts`.

### Mocking strategy

Client: mock `Transport` via `TransportProvider` (`createMockTransport` from `@dorkos/test-utils`), extended with `listPendingInteractions`. Server: `FakeAgentRuntime` plus the shared scenarios; the projector's listener seam is exercised directly rather than through a runtime, because it is runtime-agnostic and that is the point.

---

## Performance Considerations

- **Fan-out volume.** `interaction_pending` fires once per prompt raised, `interaction_resolved` once per resolution. A parked turn emits two events for its whole life. No timer, no per-second countdown, no republish loop — the countdown is client-local off `startedAt`. Payload is ~400 bytes.
- **The list endpoint** is a walk of the in-memory projector map with an O(1) ledger read per row. It is called once per window mount and on reconnect, never polled.
- **Virtualizing the room timeline** is a net win: `RoomTimeline` renders every row today, and a busy channel is the case where it hurts. The risk is not cost but behaviour (§Risks in the ideation) — hence the browser tests.
- **The lane re-renders once a second while a turn runs** (the elapsed tick), as `ChatStatusStrip` does today. It is a leaf: the tick lives inside the lane's text node, not in `Conversation.Root`, so the timeline never re-renders for it. This is the rule `PresenceStrip` already documents for its own rows ("the rows carry an immutable `since` precisely so the header above them does not re-render once a second").
- **The peek's room-sessions query** is fetched on open, not on room mount, and cached per room.

## Security Considerations

- **Detail follows the right to act, structurally.** The Ask's detail (tool name, file path, command, the agent's reason) rides the global stream, which is per-caller on a single-identity install and gated by `sessionGate`. It never enters a room entry, so it never reaches a bridged platform. The room's durable notice keeps carrying no tool name, no question and no countdown (`notice-copy.ts:206-213`), which is DOR-613's rule and is untouched.
- **Fail closed, twice.** `requirePersonToAnswer` refuses anything presenting an agent identity header — including a header that did not resolve, because a header that did not resolve still means a machine is calling. Under login-on it also refuses a per-user API key, which is the key an agent legitimately holds. An agent therefore cannot answer any prompt, its own least of all.
- **The bridge's allowlist is not widened.** `mayApprove` (`approver-allowlist.ts:75-80`) keeps its own list, deliberately separate from `dmAllowlist`, and keeps reading empty as nobody.
- **The new room route discloses ids only.** `GET /api/rooms/:id/sessions` answers `authorId → sessionId` for a room the caller can see and refuses agent callers. It is the authorization design `specs/room-presence` §15 deferred; the presence signal payload still carries no session id.
- **No new information on the presence wire.** `RoomSignalEventSchema` is unchanged.
- **No model influence.** No tool, context field or prompt text lets an agent raise, extend, suppress or answer an Ask. The only producer is the projector, folding events the runtime emitted.

## Documentation

| File                                                 | Change                                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contributing/design-system.md`                      | New **Live lane** subsection under Components: the reserved height, the priority stack as the one status vocabulary, the announcer rule, the motion budget. Amend §Motion's catalogue with the lane crossfade. Amend the `RoomPresenceLine` mentions.      |
| `contributing/architecture.md`                       | A short note that `Conversation` is the second namespace compound after `Composer`, with the capability-flag rule stated once and a pointer here.                                                                                                          |
| `contributing/state-management.md`                   | Add `interaction_pending` / `interaction_resolved` to the `KnownEvent` list in §Event Stream.                                                                                                                                                              |
| `docs/concepts/` (new page, `answering-agents.mdx`)  | "Answer your agents from anywhere" — what an Ask is, where it shows up, the ten-minute window, who can answer in a shared room. `writing-for-humans`, no jargon. Register in `contributing/INDEX.md`.                                                      |
| `docs/concepts/rooms.mdx`                            | Amend "what you see while an agent works": the line moved above the composer and is clickable.                                                                                                                                                             |
| `docs/api/openapi.json`                              | Regenerate (`pnpm docs:export-api`) for the two new routes and three new schemas.                                                                                                                                                                          |
| `.claude/skills/maintaining-dev-playground/SKILL.md` | Fix line 233 and the Files-to-Know row: `PAGE_COMPONENTS` lives in `dev/playground-pages.ts`.                                                                                                                                                              |
| `changelog/unreleased/`                              | One fragment per phase, user-voiced (`changelog/README.md`; `<YYMMDD-HHMMSS>-<slug>.md`).                                                                                                                                                                  |
| `specs/room-presence/02-specification.md`            | **Not edited.** Its §5.1 (presence under the composer) and §5.4 (stalled hides presence) are superseded and preserved respectively by §5.1–5.2 here; this paragraph is the cross-reference of record, and ADR `260818-002806` carries it machine-readably. |

---

## Implementation Phases

Four pull requests. Each is one worktree, one builder, one adversarial review against `REVIEW.md`, and each lands on `main` with nothing half-migrated. The order is the ideation's PR train (row → lane → Ask → composer), which is option A's sequence inside option B's scope (`design-decisions.md` §1).

### P1 — Row and row kinds

**Touches:** new `features/conversation/{ui/message,ui/rows,model/conversation-context,model/capabilities,lib/format-entry-time,index.ts}`; `features/entry-actions` gains the `run-with` action; `widgets/session` and `widgets/room-view` compose `Message.*` inside their existing lists; `widgets/*/model/*-capabilities.ts`.

**Deletes:** `MessageItem.tsx`, `RoomEntryRow.tsx`, `RoomEntryHeader.tsx`, `RoomEntryAttachments.tsx`, `RoomEntryActions.tsx`, `RoomEntryBody.tsx` (→ `render-room-body.tsx`), `RunWithMenu.tsx`, `entry-time.ts`, the two dividers' old homes, `RoomNoticeRow.tsx`, `RoomMomentRow.tsx`, `RoomThreadReplyRow.tsx`, and `messageItem`'s export from `features/chat/index.ts:17`.

**Tests:** `Message.test.tsx`, `no-surface-switches.test.ts`, `row-kinds.test.ts`; existing room and chat suites green unchanged.

**Reviewer's browser check:** open `/channels` and `/session` side by side. Rows look exactly as they did. Hover a room row: reactions, thread reply and the kebab all work. Hover a session row: **Run with** works and there is no reactions row. Right-click a link in each: the link-safety menu is intact.

### P2 — The live lane, the peek, and the placement move

**Touches:** `features/conversation/{ui/LiveLane,ui/LivePeek,model/lane-state}`; both host widgets mount it; `entities/room/api/use-room-sessions.ts`; **one server route**, `GET /api/rooms/:id/sessions` (`routes/rooms.ts`) — the single deviation from a client-only phase, taken because "Open its session" is half of the peek Dorian picked, and §5.3.3 is the authorization design `room-presence` §15 asked for. Stop is wired to the shipped `useHaltRoom`.

**Deletes:** `ChatStatusStrip.tsx`, `strip-state.ts`, `RoomPresenceLine.tsx`, `RoomStalledNotice.tsx`, and the under-composer placement plus its comments in `RoomSurface.tsx:283-310` and `RoomThreadPanel.tsx:419,438`.

**Tests:** `lane-state.test.ts` (the full table); `rooms-sessions.test.ts`; `lane-no-shift.spec.ts` and `peek.spec.ts`.

**Reviewer's browser check:** open a quiet room — a blank 24 px line sits above the composer and the room still looks quiet. Scroll up to the middle of the history and note where you are. Make an agent pick something up: the line fills in and **the page does not move**. Click it: the peek opens with the agent, its time, and what it is replying to; click that and the timeline jumps there. Kill the server: the line becomes the stalled notice. Open the session chat: the same line now carries elapsed, tokens and the mode warning.

### P3 — The Ask, end to end

**Touches:** `packages/shared/src/interaction-events.ts` + the `exports` map; `session-state-projector.ts` (the listener seam and the three fire points); `session-list-broadcaster.ts` (subscription + broadcast + injected `roomBindings` port); `room-session-ledger.ts` (`bindingForSession`); `routes/sessions.ts` (the list route + `requirePersonToAnswer` on six routes); `stream-manager.ts` (`GENERIC_EVENTS`); `transport.ts` + both implementations; new `features/ask`; `features/approvals`' `ApprovalCard` re-based; `entities/attention` (`use-pending-interactions`, `derive-attention-signals`); `widgets/approvals-indicator`, `widgets/home`, `features/dashboard-sidebar` render the shared list; the lane's `ask` rung goes live.

**Deletes:** `BatchApprovalBar.tsx`; `features/chat/ui/tools/{ToolApproval,QuestionPrompt,ElicitationPrompt,ApprovalReceipt,ApprovalReceiptRow,QuestionAnswerSummary}.tsx` (moved to `features/ask/ui/`); `features/approvals/lib/{format-time-left,approval-exit-transition}.ts` (moved); the degradation branch and its comment in `derive-attention-signals.ts:193-208`.

**Tests:** the whole server table above (authority is six routes × three callers), the projector and ledger units, `sse-event-allowlist`, the attention and card units, and `ask-anywhere.ts`.

**Reviewer's browser check:** in a room, make an agent ask to edit a file. The lane turns amber within a second and the header pill counts it — **on every route**. Navigate to `/tasks`, press `⌘⇧A`, answer there; go back to the room: a receipt, and the agent carries on. Do it again and answer from the room instead; the pill clears. Start typing in the composer and have an Ask arrive: the caret does not move and `A` types the letter `a`. Finally, `curl` the approve route with `X-DorkOS-Agent` set: 403.

### P4 — Timeline, composer host, the sweep, and the docs

**Touches:** `Conversation.Timeline` (the merged virtualized list), `model/use-timeline-scroll.ts`, `Conversation.Composer` + the two `ConversationTarget` adapters, `Conversation.Footer` (holding `ChatStatusSection` unchanged), the Dev Playground rename and its five sections, `AssistantMessageContent.tsx` split under 500 lines, the docs table above, and the skill fix.

**Deletes:** `MessageList.tsx`, `RoomTimeline.tsx`, `use-scroll-overlay.ts`, `use-stick-to-bottom.ts`, `RoomComposer.tsx`, `ChatInputContainer.tsx`, `InteractiveInputPanel.tsx`, `RoomPendingRow.tsx`, plus the retired playground showcases. `pnpm knip` must be clean.

**Tests:** the timeline and composer units; the full existing room + chat browser suites, which are the real gate for this phase; `playground-registry.test.ts` green after the rename.

**Reviewer's browser check:** in a busy channel, scroll fast — the thumb tracks, the unread cursor is where it was, opening a thread keeps the position, and posting while scrolled up shows the new-messages pill rather than yanking. Attach a file and `@`-mention in a room; queue two messages mid-turn in a session. Then open `/dev/conversation`: the _Surfaces_ section shows session, room and DM side by side from one fixture, and _Live lane_ shows every state including the Ask stack and the receipts.

---

## What is not done

Named here so a cold reader does not improve a deliberate gap back into a bug.

1. **The ten-minute timeout still auto-denies.** This programme makes the prompt findable, not patient. Park-instead-of-deny is approvals tier C (`design-decisions.md` §2) and is the single most valuable follow-on. It is a change to the runtime's hold semantics, not to any surface here.
2. **No notification actions.** Nothing reaches you when the cockpit is closed. Desktop, Telegram and Slack Allow/Deny buttons are tier C.
3. **No scope options.** "Allow & don't ask again" keeps its slot in the action row and does nothing yet; the third Ask for the same file still happens. Tier C.
4. **No verb glimpse in a room.** The lane says "is working on it", never "is reading `standup.md`". That needs a new field on `RoomSignalEventSchema` republished with the claim — presence tier 3, deferred with tier C.
5. **No per-agent Stop in a room.** §5.3.4 explains it: a per-author halt needs its own notice copy and a scoped gather-buffer drop, and interrupting the session directly re-opens the 2026-08-15 race. The peek is honest about what it stops.
6. **Bridged DMs still drop the waiting notice.** `services/relay/chat-bridge/deliver.ts:78` delivers only `turn_failed` and `halted`. A person on Telegram learns nothing while an agent waits. Untouched here.
7. **Codex and OpenCode timeout parity is DOR-803.** They inherit the Ask for free (§3.2 broadcasts from the runtime-agnostic projector), but whether their prompts carry a timeout at all is that item's question.
8. **Human typing indicators do not exist** and are not a lane state. `specs/room-presence` §5.2 keeps that a separate row, if ever.
9. **The room's durable waiting notice is unchanged, on purpose.** It stays vague, late and damped. It is the log, not the affordance, and making it actionable would put a tool name into a shared room.
10. **`RoomTurnWaiting` gains no fields** (§3.5). If a later item genuinely needs `sessionId` there, it adds it with a reader.

---

## Open Questions

All resolved during SPECIFY. Originals preserved as the audit trail.

- ~~Grow `features/chat` or make a new slice?~~ **(RESOLVED — default chosen: a new `features/conversation` slice.)** **Answer:** §2.1. **Rationale:** the layer rule decides it, not taste — a shared tree inside `features/chat` would force room-side hooks into feature-model cross-imports, which `.claude/rules/fsd-layers.md` forbids outright.
- ~~Does the room correlate the Ask through the global event or a new room signal?~~ **(RESOLVED — default chosen: the global `interaction_pending`, carrying `roomId`.)** **Answer & rationale:** §3.5. A room signal would cover strictly less ground (no replay, no off-room surfaces) at strictly more cost (a second source of one fact, a second allowlist entry).
- ~~Does `RoomTurnWaiting` gain `sessionId` / `interactionId`?~~ **(RESOLVED — default chosen: no.)** **Answer:** its only consumer is the deliberately vague durable notice. **Rationale:** fields with no reader are the speculative widening this repo removes. The happy consequence is that the room half of the Ask is a **zero-change** on the rooms service.
- ~~Where does the fleet-wide pending store live — `entities/session` or `entities/attention`?~~ **(RESOLVED — default chosen: `entities/attention`.)** **Answer:** §4.1. **Rationale:** an entity may not import a sibling entity, and `entities/attention` is the consumer that matters; its twin `use-pending-approvals` already lives there.
- ~~Extend `ApprovalCard`, or generalize `ToolApproval`?~~ **(RESOLVED — default chosen: neither — a new `features/ask` owning the chrome, adopted by both.)** **Answer:** §4.3. **Rationale:** the two data models are genuinely different (persisted 2-hour grant vs in-memory 10-minute hold); only the chrome is shared, so only the chrome is extracted.
- ~~Which server module raises `interaction_pending`?~~ **(RESOLVED — default chosen: `SessionStateProjector`, through a listener seam, broadcast by `session-list-broadcaster`.)** **Answer:** §3.2. **Rationale:** the claude-code session map is one runtime's; the projector is the runtime-agnostic fold every runtime already feeds, so Codex and OpenCode inherit the Ask with no adapter work.
- ~~Does the Ask payload carry the agent's name and face?~~ **(RESOLVED — default chosen: no; ids plus `cwd`, joined client-side.)** **Answer:** §3.1. **Rationale:** every renderer already holds the session list off the same stream; a denormalized name would be the only identity on a hot event and would go stale on rename.
- ~~Can the peek offer a per-agent Stop?~~ **(RESOLVED — default chosen: no; one agent gets Stop, several get "Stop everything in this room".)** **Answer & rationale:** §5.3.4 — the measured 2026-08-15 race, and the fact that a per-author halt needs its own notice and buffer semantics.
- ~~Is `ChatStatusSection` folded into the lane, as `01-ideation.md` §3 implies?~~ **(RESOLVED — default chosen: no.)** **Answer:** it is the composer's model/mode/git status line built on `features/status`' `StatusLine`, not a busy indicator; it becomes `Conversation.Footer` content unchanged. **Rationale:** folding it would put a dozen chips into a 24 px single-line lane and delete a surface nobody asked to lose.
- ~~Exact lane height?~~ **(RESOLVED — default chosen: `h-6`, 24 px.)** **Answer:** §5.1. **Rationale:** the smallest step on the spacing scale that gives a 12 px line a 4 px optical gutter; the mockup's 22 px is off-scale and would be a one-off number.

---

## Related ADRs

- **Extracted by this spec** (draft, `extractedFrom: unified-conversation`): `260818-002803` (SDK interaction prompts become fleet-wide Asks), `260818-002805` (one Conversation compound, capability flags instead of surface switches), `260818-002806` (the reserved live lane replaces both the status strip and the under-composer presence line — `amends` `260729-145341`'s placement clause by way of `specs/room-presence` §5.1).
- ADR-0310 — runtime-owned sessions; why the projector, not a runtime, is the Ask's source.
- ADR-0264 — message POSTs are trigger-only; all delivery rides the durable stream.
- ADR 260805-041016 — the global stream is one WebSocket owned by `StreamManager`; why `GENERIC_EVENTS` is the gate.
- ADR 260726-170125 — a room is a membership-scoped durable stream; the boundary the Ask's detail must not cross.
- ADR 260728-022013 — a thread is a relation between entries, not a room; why the thread panel composes its own `Conversation.Root`.
- ADR-0273 — structured context injection; why no lane or Ask text enters a prompt.
- ADR-0312 — timestamp identifiers.

## References

- `specs/unified-conversation/01-ideation.md` (§3 map, §6 decisions), `design-decisions.md`, `design/01-messaging-exploration.html`, `design/picks.jsonl`.
- `specs/room-presence/02-specification.md` §5.1 (placement, superseded here), §5.3 (TTL), §5.4 (stalled), §6 (`room_presence`), §15 (the deferred in-flight session id, designed here).
- `specs/sidebar-now-today-library/` — `entities/attention`, the Heads up zone, `select-now-items.ts`.
- `specs/agent-trust/02-specification.md` §3.3 — the capability-approval pattern this copies; `specs/approvals-resume-inline/`; `specs/slack-tool-approval/`.
- `research/20260316_tool_approval_timeout_visibility_ux.md` (countdown thresholds), `research/20260320_unified_status_strip.md` (one morphing container), `research/20260729_buzz-presence-signals.md`, `research/20260729_platform-presence-patterns.md`.
- `contributing/design-system.md` (motion, identity grammar, zones, unread tiers), `contributing/state-management.md`, `contributing/architecture.md`, `.claude/rules/fsd-layers.md`, `.claude/rules/testing.md`, `.claude/skills/maintaining-dev-playground/SKILL.md`, `.claude/skills/writing-for-humans/SKILL.md`.
- `meta/agent-etiquette.md` §9 — over-participation is the failure mode; every damper and grace constant kept here cites it.
- Code anchors as cited throughout, read at `d7e4768e6`.
