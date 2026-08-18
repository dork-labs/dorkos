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

- Task #1.5: Wire both hosts to Message.* and delete the two old rows — worker: p1-builder
  - Deleted: `features/chat/ui/message/MessageItem.tsx` (228), `widgets/room-view/ui/RoomEntryRow.tsx` (400), `RoomEntryHeader.tsx` (171), `RoomEntryBody.tsx` (166), `RoomEntryActions.tsx` (149); `messageItem`'s export from `features/chat/index.ts`
  - Created: `features/chat/ui/message/SessionMessage.tsx` and `widgets/room-view/ui/RoomMessage.tsx` — each keeps only what its own surface knows and composes `Message.*` for the rest; `features/chat/ui/render-session-body.tsx`; `widgets/room-view/ui/render-room-body.tsx`; `features/conversation/model/body-renderer.ts` (the `ConversationBodyRenderer` contract); `features/chat/config/session-capabilities.ts`; `features/onboarding/model/narration-capabilities.ts`
  - `Conversation.Root` is mounted by `ChatPanel` (the session surface the route, the Obsidian embed and the dev simulator all mount), by `RoomSurface` (room/DM, task 1.4) and by `OnboardingConversation` (the scripted narration, which declares its own all-off table because it is a third host of the row)
  - **Deviation, forced by the layer rule:** `SESSION_CAPABILITIES` lives in `features/chat/config/`, not `widgets/session/model/`, and `render-session-body.tsx` in `features/chat/ui/`, not `widgets/session/ui/`. `widgets/session` is a 20-line route wrapper; the session's real host is `ChatPanel`, and `MessageList`, the row and all their tests live in `features/chat` — which may not import a widget's model. ESLint refused it outright (`no-restricted-imports`, four test files). `config/` rather than `model/` because the repo's `dir-size` hook errors at 25 files in `features/chat/model` and a capability table is a constant. P4 moves both up when the composer host lands in `widgets/session`.
  - **Deviation, deliberate:** `capabilities.toolCards` is declared by both hosts and read by neither yet. Each host's body renderer is fixed in P1, so there is nothing for the flag to switch; inventing a branch no surface exercises would be a check that cannot discriminate. P4's renderer map is where it goes live.
  - Test harnesses that bench a row directly now mount the same `Conversation.Root` the app does (7 room-view suites, `message-list-test-helpers`, `SessionMessage`, `QuestionOutcome`, `chip-tray-survives-turn-end`, 5 dev showcases). No assertion was changed or weakened — the whole client suite is green, including every room a11y, action-surface, reaction, mention and right-click-a-link case.
  - Renames the greps in task 1.9 require: `MessageItem` → `SessionMessage`, `RoomEntryRow` → `RoomMessage`, and their test files with them.

- Task #1.6: Test the row — capability gating, data-slots, row kinds, and the surface-switch scan — worker: p1-builder
  - Created: `features/conversation/__tests__/Message.test.tsx` (9 cases), `features/conversation/__tests__/no-surface-switches.test.ts` (a source scan over `ui/`, plus a case proving the scan actually sees the tree), `features/conversation/lib/__tests__/row-kinds.test.ts` (6 cases)
  - Four seeded defects, each run and each red: reactions rendered unconditionally → "draws no reactions at all…" red; `runWith` hard-coded in → "withholds run this with…" red; `surface === 'room'` added to `NoticeRow` → the scan red; `GROUP_GAP_MS` 5 min → 60 min → "breaks a group on silence" red.
  - One assertion the task named differently: `anchor` changes the ACTIONS slot, not the gutter (the gutter is identical under both anchors — the anchor holds the capsule, not the identity column), so the case pins the real difference rather than a claim the variant does not make.

- Task #1.7: Show the Message.* matrix in the Dev Playground — worker: p1-builder
  - New `dev/showcases/ConversationRowShowcases.tsx` holds two sections, both rendering the REAL components: **Message.\* matrix** (the two shipped capability tables side by side, then anchor × role × position × density, then one capability flag at a time) and **Conversation dividers** (`DayDivider`, `UnreadDivider` — neither had a bench anywhere before). Rendered from `MessageShowcases` and registered on the existing `chat` page in `dev/sections/chat-sections.ts`; the page rename and the five-section restructure stay P5's.
  - No duplicates added: `NoticeRow`, `MomentRow` and `ThreadReplyRow` are already benched on `/dev/rooms` against real room fixtures ("Room notices", "Room moments", "ThreadReplyRow"), and those benches now render the moved components. Drawing them a second time on Chat is the duplicate the task tells us to retire.
  - The two authors the benches share moved into `dev/mock-samples.ts` rather than being declared twice; the bench names `Message.Root`'s `role` variant `voice` on its own props, because `jsx-a11y` reads a literal `role=` on any JSX element as an ARIA role and this one is typography (the DOM role is `article` either way).
  - Two capability flags are shown as having nothing to show on the row, and the section says so rather than implying coverage: `threads` surfaces as the reply line (benched on Rooms) and `toolCards` inside the host's body renderer.
  - `playground-registry.test.ts` green: every rendered section registered, every registered section rendered, each id equal to `slugify(title)`.

- Task #1.8: Write the phase 1 changelog fragment — worker: p1-builder
  - `changelog/unreleased/260818-023659-one-message-row-everywhere.md`, id minted with `.claude/scripts/id.ts` at execution time. It replaces the per-commit fragments the `post-commit` hook mints — one fragment per phase, with `covers:` naming every commit subject.
  - **Not `skip-changelog`, and the reason is two real user-visible changes** rather than the refactor itself: the `showTimestamps` preference now governs channels as well as sessions (it silently ignored channels before), and a session's message times gained the full-date tooltip and the keyboard-focus reveal a channel already had. Both fall out of the two rows becoming one. Nothing else a person can see changed, and the fragment claims nothing else.
  - `python3 .claude/scripts/changelog_backfill.py --check` → all commits covered, 0 uncovered.

- Task #1.9: Phase 1 acceptance — the reviewer's browser check — worker: p1-builder
  - Cockpit stood up from this worktree: server `DORKOS_PORT=4250 DORK_HOME=~/.dork-verify-p1` (fresh), client on `:4400`. Onboarding dismissed over the API; a channel and three entries seeded over the API; a session read from this machine's own transcripts (no turn was spent).
  - **The room** (`/channels`): rows draw through `Message.*` — `message-root · gutter · author · body · content · reactions · actions`, `[data-slot="message-content"]`'s parent is the body column, and the hovered capsule's bottom edge lands exactly on the body's top (261px / 261px) while straddling the row's top (bar 231, row 245) — the geometry `room-entry-actions.spec.ts` pins. The capsule holds 3 quick emoji + picker + reply + copy + profile, and **no run-with**. Clicking 👍 landed a real reaction ("You reacted 👍", count 1). Clicking reply opened the thread panel with the same row drawn again inside it. Right-click a link → **no** DorkOS menu (the browser's own wins); right-click the row → Reply in thread / Copy text / View profile; left-click the link → the "Open external link?" confirmation.
  - **The session** (`/session`): rows draw through the same parts, **no reactions slot anywhere**, and the Run with trigger pinned to the row's top right (absolute, top 4 / right 8, wrapper `display: contents`), tabbable, labelled "Run this prompt with another runtime". Clicking it opened "Run this with… Codex / OpenCode (Connect)". A slash-command row correctly offers no Run with, as before. Right-click a session row opens no menu — it has no commands, exactly as before.
  - **The playground** (`/dev/chat`): the Message.\* matrix renders 14 real rows, 9 reaction slots, 4 run-with triggers; Conversation dividers renders below it. Both are in the page's table of contents.
  - Screenshots (session scratchpad): `p1-room-hover.png`, `p1-room-thread-and-reaction.png`, `p1-session-hover.png`, `p1-session-runwith-menu.png`, `p1-playground-matrix.png`.
  - **Verification ladder:** `pnpm --filter @dorkos/client typecheck` clean · `lint` 0 errors / 119 warnings (all pre-existing shapes) · `pnpm vitest run apps/client` 940 files, 11 651 tests green · `pnpm verify` **exit 0**, 32/32 turbo tasks · `changelog_backfill.py --check` all covered · the three room Playwright suites green (31 tests, 1.4m).
  - **`pnpm verify` caught a real defect the targeted runs could not.** `no-surface-switches.test.ts` resolved its directory from `process.cwd()`, which is the repo root under `pnpm vitest run <path>` and `apps/client` under turbo — so the scan found nothing and read exactly like a pass. It now globs its sources through Vite, resolved against its own location, and the seeded `surface === 'room'` defect was re-run and re-confirmed red under both runners.
  - **knip:** four findings this phase introduced were fixed rather than accepted — `DM_CAPABILITIES` (a duplicate export of one object), `formatAbsoluteTime` and `EntryRunWithMenu` (barrel exports with no reader outside their slice), and `ConversationRoot` (a second spelling of `Conversation.Root`), plus the nine part prop-types nothing names. Totals fell rather than rose: unused exports 560 → 557, duplicate exports 3 → 2. What remains from this phase is the model contract task 1.1 mandates declaring now — `ConversationTarget` and its two ports, `ConversationRow`, `BodyRenderContext` — which P2–P4 consume, in a 602-item bucket knip already reports on `main`.
  - Servers stopped afterwards; ports 4250 and 4400 answer nothing.

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
