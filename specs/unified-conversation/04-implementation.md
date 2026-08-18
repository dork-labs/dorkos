# Implementation Summary: Unified conversation surfaces — one tree, approvals anywhere, a live lane

**Created:** 2026-08-18
**Last Updated:** 2026-08-18
**Spec:** specs/unified-conversation/02-specification.md
**Tracker:** DOR-1327 (umbrella) — phases DOR-1328 (P1) · DOR-1329 (P2) · DOR-1330 (P3) · DOR-1331 (P4) · DOR-1332 (P5)

## Progress

**Status:** In Progress
**Tasks Completed:** 9 / 48

## Tasks Completed

### Session 1 - 2026-08-18 (P1, DOR-1328)

**Worktree:** `~/.dork/workspaces/dorkos/DOR-1328` · branch `DOR-1328` (based on `spec/unified-conversation` → `origin/main`)
**Workers:** `p1-builder` (P1, DOR-1328)

- Task #1.1: Create the features/conversation slice and its model contract — worker: p1-builder
  - Created: `features/conversation/model/{capabilities,target,conversation-context}.ts`, `features/conversation/lib/row-kinds.ts`, `features/conversation/ui/ConversationRoot.tsx`, `features/conversation/ui/message/message-styles-context.tsx`, `features/conversation/index.ts`
  - Moved (git mv, history preserved): `features/chat/ui/message/message-variants.ts` → `features/conversation/ui/message/message-variants.ts`; `features/chat/ui/message/MessageAuthorAvatar.tsx` → `features/conversation/ui/message/MessageAuthorAvatar.tsx` (+ its test → `features/conversation/__tests__/`)
  - Modified: `features/chat/index.ts`, `features/chat/ui/message/index.ts`, `features/chat/ui/message/MessageItem.tsx`, `features/chat/ui/primitives/tool-status-icon.tsx`, `widgets/room-view/ui/{RoomEntryRow,RoomEntryHeader,RoomMomentRow}.tsx`, `dev/showcases/{EntryActionsShowcases,MessageShowcases}.tsx` — all repointed at the new home
  - Deviations, both deliberate: (1) `MessageAuthorAvatar` moved with the variants although the task did not name it — `Message.Gutter` draws it, and leaving it in `features/chat` would make the conversation barrel import the chat barrel while `MessageList` imports the conversation barrel, a module cycle between two barrels. (2) `ConversationContextValue.target` is `ConversationTarget | null` rather than required: the composer host lands in P4, and a host with no composer says so rather than passing a stub whose `send` throws.

- Task #1.3: Merge the two hover-action systems into features/entry-actions — worker: p1-builder
  - Created: `features/entry-actions/ui/EntryRunWithMenu.tsx` (RunWithMenu's markup and handlers, moved unchanged)
  - Deleted: `features/chat/ui/message/RunWithMenu.tsx`
  - Moved: `features/chat/__tests__/RunWithMenu.test.tsx` → `features/entry-actions/__tests__/EntryRunWithMenu.test.tsx`
  - Modified: `features/entry-actions/lib/entry-actions.ts` (`run-with` slot, excluded from `EntryActionId`, third in `ENTRY_ACTION_ORDER`), `ui/EntryActionBar.tsx` (`runWith` prop → the slot), `ui/EntryActionMenu.tsx` (doc: why the two menu-opening slots are not list items), `index.ts`; five chat suites' `vi.mock` paths
  - Design note: `run-with` is a bar SLOT like `react-more`, not an `EntryAction` command — it opens a menu rather than running, so `EntryAction`'s shape (and every existing assertion on it) is untouched. Its trigger keeps the tab stop it has today; every other capsule button stays roving. Reasons are in both files' TSDoc.
  - Seeded defect verified: making `barButtons` always emit the slot turned "draws nothing at all when it does not" red.

- Task #1.4: Move the non-message rows and the one time formatter into the slice — worker: p1-builder
  - Moved (git mv): `widgets/room-view/lib/entry-time.ts` → `features/conversation/lib/format-entry-time.ts`; `features/chat/ui/message/{DayDivider,UnreadDivider}.tsx` → `features/conversation/ui/rows/`; `widgets/room-view/ui/{RoomNoticeRow,RoomMomentRow,RoomThreadReplyRow}.tsx` → `features/conversation/ui/rows/{NoticeRow,MomentRow,ThreadReplyRow}.tsx`
  - Created: `widgets/room-view/model/room-capabilities.ts` (`ROOM_CAPABILITIES` / `DM_CAPABILITIES`) — nominally task 1.5's, brought forward because `ThreadReplyRow` now gates on `capabilities.threads` and both the widget and the playground bench need the table to mount a Root
  - Modified: `widgets/room-view/ui/RoomSurface.tsx` mounts `Conversation.Root` (surface from `room.kind`, `anchor="rail"`); `RoomTimeline.tsx` renders `ThreadReplyRow` with the host's `threadRowId`; both chat barrels; `MessageList.tsx`; the room-view barrel; `dev/showcases/RoomThreadShowcases.tsx` + `dev/sections/rooms-sections.ts` (the section's id and title follow the rename)
  - Each row's root gained `data-slot` (`day-divider`, `unread-divider`, `notice-row`, `moment-row`, `thread-reply-row`); every `data-testid` is byte-identical to before
  - Two rows lost a widget-level dependency they could not keep across the layer boundary: `MomentRow` takes its resolved `subject` + `subjectIdentity` as props (only the host can join a room's roster to the fleet — the rule `MessageAuthorAvatar` already states for its own destination), and `ThreadReplyRow` takes its DOM `id` from the host, which owns the id scheme. Markup and copy are unchanged, word for word.
  - Three room test harnesses gained the `Conversation.Root` the widget now mounts (`RoomTimeline`, `RoomTimeline.mentions`, `room-agent-faces`). No assertion changed; a bench without a Root is testing a state the app never puts the component in.

- Task #1.2: Build the Message.\* parts as the one row — worker: p1-builder
  - Created: `features/conversation/ui/message/{MessageRoot,MessageGutter,MessageAuthor,MessageBody,MessageReactions,MessageActions}.tsx`; moved `widgets/room-view/ui/RoomEntryAttachments.tsx` → `ui/message/MessageAttachments.tsx` (+ its test)
  - Exported as `Message = { Root, Gutter, Author, Body, Content, Attachments, Reactions, Actions }`
  - **Eight parts, not seven.** `Message.Body` is the content COLUMN (`data-slot="message-body"`) and `Message.Content` is the words inside it (`data-slot="message-content"`). Both rows already drew exactly these two elements, and `apps/e2e/tests/rooms/room-entry-actions.spec.ts:186` measures the capsule against `[data-slot="message-content"]`'s **parent** — so collapsing them would either break that shipped test or leave the capsule nothing to straddle. All seven slots the spec names exist.
  - Capability gates, no surface checks: `Message.Reactions` returns `null` unless `capabilities.reactions`; `Message.Actions` passes the quick row only under `reactions` and the run-with slot only under `runWith`. `grep -rn "surface ===" features/conversation/ui/` is empty.
  - Anchor, not surface, decides the capsule's holder: a small `cva` (`corner` → `contents`, `rail` → the sticky band moved from `RoomEntryActions`).
  - One behaviour unified rather than preserved twice: the `showTimestamps` preference now governs the continuation gutter on BOTH surfaces (a room ignored it before). It defaults to `false`, so nothing changes for a reader who has not turned it on. The session's gutter and author line also gained `<time dateTime title>` semantics the room already had.

**Source files:**

- `apps/client/src/layers/features/conversation/**` (new slice)

**Test files:**

- `apps/client/src/layers/features/conversation/__tests__/MessageAuthorAvatar.test.tsx` (moved)

## Known Issues

_(None yet)_

## Implementation Notes

### Session 1

Orchestration model (operator override of the per-task batching in `executing-specs`, logged as an assumption): one named, resumable builder agent per phase in that phase's worktree, executing the phase's tasks in dependency order and committing per task; then a two-stage review (spec compliance, then adversarial code quality per `REVIEW.md`) by separate agents; fixes return to the builder (resume ladder rung 1); the PR opens only after the review converges. Model tiers per `.dork/plugins/flow/config/config.json`: implementation/review = opus, mechanical = sonnet.
