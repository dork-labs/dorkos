# Implementation Summary: Unified conversation surfaces — one tree, approvals anywhere, a live lane

**Created:** 2026-08-18
**Last Updated:** 2026-08-18
**Spec:** specs/unified-conversation/02-specification.md
**Tracker:** DOR-1327 (umbrella) — phases DOR-1328 (P1) · DOR-1329 (P2) · DOR-1330 (P3) · DOR-1331 (P4) · DOR-1332 (P5)

## Progress

**Status:** In Progress
**Tasks Completed:** 2 / 48

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

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/features/conversation/**` (new slice)

**Test files:**

- `apps/client/src/layers/features/conversation/__tests__/MessageAuthorAvatar.test.tsx` (moved)

## Known Issues

_(None yet)_

## Implementation Notes

### Session 1

Orchestration model (operator override of the per-task batching in `executing-specs`, logged as an assumption): one named, resumable builder agent per phase in that phase's worktree, executing the phase's tasks in dependency order and committing per task; then a two-stage review (spec compliance, then adversarial code quality per `REVIEW.md`) by separate agents; fixes return to the builder (resume ladder rung 1); the PR opens only after the review converges. Model tiers per `.dork/plugins/flow/config/config.json`: implementation/review = opus, mechanical = sonnet.
