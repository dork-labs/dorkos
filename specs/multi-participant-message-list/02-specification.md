---
slug: multi-participant-message-list
id: 260725-014841
created: 2026-07-25
status: specified
---

# Multi-Participant Message List — Phase 1: Identity + Separators

**Status:** Approved
**Author:** Claude (directed by Dorian)
**Date:** 2026-07-25
**Tracker:** DOR-455

## Overview

Restructure the chat message list around **author identity** and **list-level separators**, adopting Slack's message-list grammar: a left identity gutter with avatar and name, hanging-indent continuations, full-bleed day dividers, and an unread rule. Every current capability is preserved (tool cards, thinking blocks, subagent blocks, approvals, questions, widget fences, streaming, virtualization, presentation mode).

Phase 1 is **client-only**. No server routes, no wire schema, no runtime adapters, no migrations.

## Background / Problem Statement

`MessageItem` branches on `ChatMessage.role`, which is `'user' | 'assistant'` — binary. Consequences today:

- Nothing in the message list says _who_ is speaking. There is no avatar and no name anywhere.
- `computeGrouping` (`MessageList.tsx:42`) keys on **consecutive same role**, so two different agents' messages would merge into a single visual group. The multi-agent room is unrepresentable.
- Separators are message decoration, not list structure: the `divider` slot is an `absolute inset-x-0 top-0 h-px` inside a message (`message-variants.ts:22`). A full-bleed rule between groups is not expressible, and there is no day boundary or unread marker at all.
- User messages are right-aligned bubbles (`message-variants.ts:27`). Right-alignment encodes "me vs them" and cannot express three or more participants.

## Goals

- Every message displays its author (avatar + name) using Slack's gutter grammar; continuations hang-indent with no repeated identity.
- Grouping keys on author, plus a time gap and a day boundary — not role.
- Day dividers and an unread ("New messages") rule render as full-bleed, virtualized list rows.
- The author model is a typed seam whose _source_ can move from client-derived to server-provided in a later phase without touching any UI component.
- Zero capability regressions across the message surface.

## Non-Goals (phase 1)

- Emoji reactions (phase 2) and threads (phase 3) — separate specs.
- Any server, wire-schema, or runtime-adapter change.
- Multi-human identity or accounts (there is one human today).
- Auto-threading subagent blocks; they stay inline collapsible cards.

## Decisions

These were open questions in `01-ideation.md`; resolved here.

**D1 — The right-aligned user bubble is removed.** Every author renders in the left gutter. Right-alignment cannot express N participants, and maintaining two layouts would double the surface for every later feature (reactions, thread affordances, hover actions all need positioning in both). Identity now comes from avatar + name, which is a stronger signal than alignment and scales. The existing hover background is retained as the row affordance.

**D2 — `author` is a client-derived view-model in phase 1, NOT a wire-schema field.** `ChatMessage` is unchanged. A pure resolver computes `MessageAuthor` from `(role, session, agents, runtime)`. Rationale: adding an author to the wire means touching the history and live paths of all three runtime adapters plus back-compat for existing transcripts, for zero additional user-visible value today — while the _right_ shape of a wire-level author is determined by the room model that phase 3 introduces. Committing the schema now risks a migration we would have to undo. The resolver is the seam: phase 3 swaps its source and no UI component changes.

**D3 — Assistant identity resolves agent-first, runtime-second.** If the session's `cwd` matches a registered agent's directory, use that agent's `displayName` + `icon` + color. Otherwise fall back to the runtime's brand identity (Claude / Codex / OpenCode), which already has assets. Never render a bare "Assistant".

**D4 — The unread cursor is client-local.** `lastSeenMessageId` per session in `localStorage`. For a single-operator local cockpit the "new messages" rule is genuinely about _this browser's_ last view, so a server round-trip buys nothing. It migrates to server-side per-identity when accounts land.

**D5 — Grouping breaks on author change, a >5-minute gap, or a day boundary.** Slack's rule set. The gap threshold is a named constant.

**D6 — `RunWithMenu` moves into a hover action toolbar at the row's top-right.** It currently sits at `absolute top-2 -left-9` (`MessageItem.tsx:156`), which is exactly where the new avatar gutter goes. The toolbar is also the natural home for the react and reply-in-thread affordances in later phases.

## Detailed Design

### Layout

```
──────────────────  Today  ──────────────────      day divider (full-bleed rule, centered pill)

[av]  Dorian            10:42                      group start: avatar, name, time
      Can you fix the flaky test?

[av]  DorkBot           10:42
      I'll take a look.
      ▸ Read src/foo.test.ts                       tool card, inside the content column
      Found it — the timer isn't mocked.           continuation: no avatar, no name

───────────────  New messages  ───────────────      unread rule (accent-colored)
```

- **Gutter:** avatar at `size-7` (28px) in a fixed-width gutter; continuations pad-left by the same width so content is flush.
- **Group start** renders avatar, `displayName`, and the timestamp inline after the name.
- **Continuations** render neither avatar nor name; the timestamp appears in the gutter on row hover (Slack's behavior), gated by the existing `showTimestamps` preference for the always-on case.
- **Dividers** are full-bleed rules with a centered label chip; the unread rule uses an accent color and a right-aligned "New messages" label.

### `MessageAuthor` and the resolver

New type in `apps/client/src/layers/shared/model/chat-message-types.ts` (alongside `ChatMessage`, same module, so entities and features can both read it):

```ts
export interface MessageAuthor {
  kind: 'human' | 'agent' | 'system';
  /** Stable identity key — drives grouping and avatar color. */
  id: string;
  displayName: string;
  /** Emoji glyph for the avatar, when the identity has one. */
  emoji?: string;
  /** CSS color string for the avatar background. */
  color?: string;
  /** Runtime brand key, when the identity falls back to a runtime. */
  runtime?: string;
}
```

A pure resolver in the chat feature's `lib/`:

```ts
resolveMessageAuthor(message, ctx: { session?, agent?, runtime?, humanName }): MessageAuthor
```

Rules, in order: `messageType === 'local_command_output'` or a system-ish message → `system`; `role === 'user'` → `human`; `role === 'assistant'` → the resolved agent (D3), else the runtime brand. The resolver is pure and fully unit-tested; it never fetches.

Agent resolution for D3 uses the existing agents query in the entity layer, matched on the session's `cwd`. When no agent matches — the common case for an ad-hoc project session — the runtime brand is used, which is honest and requires no lookup.

### `ListRow` and `buildListRows`

`MessageList` currently virtualizes `ChatMessage[]` directly. It will virtualize a derived row list instead.

```ts
export type ListRow =
  | {
      kind: 'message';
      key: string;
      messageIndex: number;
      message: ChatMessage;
      grouping: MessageGrouping;
      author: MessageAuthor;
    }
  | { kind: 'day-divider'; key: string; label: string }
  | { kind: 'unread-divider'; key: string };
```

`buildListRows(messages, opts)` is a pure function in the chat feature's `lib/`, computing rows, author-based grouping, day boundaries, and the unread position in one pass. It replaces `computeGrouping`.

**`messageIndex` is load-bearing.** Two existing behaviors are message-index-based and must keep message semantics, not row semantics:

- `findLastWidgetFenceIndex` / `isLatestWidgetMessage` — the DOR-302 fence supersede rule.
- `historyCount` / `isNew` — the entry-animation gate.

Both read `row.messageIndex`, never the virtual row index.

### Virtualizer

The virtualizer's configuration is preserved verbatim — `anchorTo: 'end'`, `followOnAppend`, `scrollEndThreshold`, and especially the `measureElement` zero-guard cache fallback (`MessageList.tsx:133-140`), which exists for hidden-container measurement (Obsidian sidebar) and must not be touched. Only `count` and the row render body change. Divider rows are real virtualized rows so their heights participate in measurement.

### Unread cursor

A small hook in the chat feature's `model/`:

- Reads `lastSeenMessageId` for the session from `localStorage` on mount; that value fixes the divider position for the lifetime of the view (it does not chase new messages, matching Slack).
- Writes the newest message id when the list is pinned to the bottom and on unmount.
- A session with no stored cursor renders no divider.

### Verified integration points

Traced 2026-07-25; implementers should not re-derive these.

**Why D2 is right, concretely.** A wire-level `author` on `HistoryMessageSchema` (`packages/shared/src/schemas.ts:1590-1604`) would have to be threaded through every `HistoryMessage` literal builder — `transcript-parser.ts` (6 sites: L249, L345, L393, L417, L529, L580), `event-log-history.ts` (L123, L159), `opencode/session-mapper.ts` (L236, L240) — plus the hand-maintained client `ChatMessage` interface (which does **not** derive from the shared schema), `mapHistoryMessage()`, and the two client-side constructors that fabricate messages with no server round-trip. That is a large, three-runtime change for zero additional phase-1 value.

**Where rendered messages come from.** Two paths converge before the list:

- Legacy: `use-session-history.ts:105` → `mapHistoryMessage()` (`stream-history-helpers.ts:14-55`) → `session-chat-store`.
- Stream: `session-stream-store.applySnapshot()` → `projectSessionMessages()` (`project-session-turn.ts:707-722`), which also appends `buildOptimisticUserMessage()` (L38-47) and `buildInProgressMessage()` (L668-680).

Both are selected by `selectRenderedMessages()` (`derive-rendered-state.ts:45-58`) and surface as `useChatSession().messages` (`use-chat-session.ts:85-88`). **The resolver therefore belongs at render time in the list**, not in either producer — one insertion point covers both paths, including the two optimistic constructors that have no server identity to carry.

**Callers of `computeGrouping`** — currently exported from `MessageList.tsx:42`; `buildListRows` replaces it. Check for test imports before deleting.

**Do not break `presentation` mode.** `layers/features/onboarding/model/onboarding-script.ts:101-102` runs its own role-adjacency grouping and renders `MessageItem` with `presentation`. The onboarding conversation must still read as narration (no hover chrome, no timestamps). Its scripted lines have no agent, so the resolver's fallback path is what renders them.

**Playground mocks** live at `apps/client/src/dev/mock-factories.ts:28,42`.

### Files

| File                                                                                  | Change                                                           |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/client/src/layers/shared/model/chat-message-types.ts`                           | add `MessageAuthor`                                              |
| `apps/client/src/layers/features/chat/lib/resolve-message-author.ts`                  | **new** — pure resolver                                          |
| `apps/client/src/layers/features/chat/lib/build-list-rows.ts`                         | **new** — `ListRow`, `buildListRows`; replaces `computeGrouping` |
| `apps/client/src/layers/features/chat/model/use-unread-cursor.ts`                     | **new** — localStorage read cursor                               |
| `apps/client/src/layers/features/chat/ui/MessageList.tsx`                             | virtualize rows; render dividers; keep virtualizer config        |
| `apps/client/src/layers/features/chat/ui/message/MessageItem.tsx`                     | gutter layout, group-start header, hover toolbar                 |
| `apps/client/src/layers/features/chat/ui/message/MessageAuthorAvatar.tsx`             | **new** — avatar + name header                                   |
| `apps/client/src/layers/features/chat/ui/message/message-variants.ts`                 | drop user-bubble variants; gutter/indent slots                   |
| `apps/client/src/layers/features/chat/ui/message/DayDivider.tsx`, `UnreadDivider.tsx` | **new**                                                          |
| `apps/client/src/layers/features/chat/ui/message/UserMessageContent.tsx`              | drop bubble-specific styling                                     |
| `apps/client/src/dev/…`                                                               | playground showcase for the new list                             |

## Testing Strategy

- **Unit (pure, fast):** `resolveMessageAuthor` — every branch of D3 including both fallbacks; `buildListRows` — author change, 5-minute gap, day boundary, unread position, empty list, single message, unread cursor pointing at a message no longer present.
- **RTL:** group start renders avatar + name + time; continuation renders neither; day and unread dividers appear as rows; `presentation` mode still suppresses hover chrome; command output still renders full-width.
- **Regression pins:** widget fence supersede still keyed to message index; `isNew` animation still fires only for post-history messages.
- **Browser verification (required):** virtualized scrolling with mixed row heights, streaming pinned-to-bottom behavior, and the hover toolbar. Per `.claude/rules/testing.md` and prior art, jsdom cannot verify the virtualizer or Radix-driven hover/focus interactions.

## Performance Considerations

`buildListRows` is O(n) over messages and memoized on the messages array, replacing the existing O(n) `computeGrouping` — no added cost. Row count grows by the number of dividers (small). Author resolution is memoized per session, not per message.

## Security Considerations

None. No new data crosses a trust boundary; `displayName` values are rendered as text, never as markup.

## Open Questions

None blocking. Phase 2 (reactions) and phase 3 (threads) carry their own decisions, recorded in `01-ideation.md`.

## Related

- `specs/multi-participant-message-list/01-ideation.md` — research and the thread/reaction design
- ADR-0302 (widget fence supersede), ADR-0310 (runtime-owned sessions), spec `channel-sender-identity`
