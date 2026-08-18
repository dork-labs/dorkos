# Implementation Summary: Unified conversation surfaces — one tree, approvals anywhere, a live lane

**Created:** 2026-08-18
**Last Updated:** 2026-08-18 (session 3 — P2, the live lane)
**Spec:** specs/unified-conversation/02-specification.md
**Tracker:** DOR-1327 (umbrella) — phases DOR-1328 (P1) · DOR-1329 (P2) · DOR-1330 (P3) · DOR-1331 (P4) · DOR-1332 (P5)

## Progress

**Status:** In Progress
**Tasks Completed:** 18 / 48

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

- Task #1.5: Wire both hosts to Message.\* and delete the two old rows — worker: p1-builder
  - Deleted: `features/chat/ui/message/MessageItem.tsx` (228), `widgets/room-view/ui/RoomEntryRow.tsx` (400), `RoomEntryHeader.tsx` (171), `RoomEntryBody.tsx` (166), `RoomEntryActions.tsx` (149); `messageItem`'s export from `features/chat/index.ts`
  - Created: `features/chat/ui/message/SessionMessage.tsx` and `widgets/room-view/ui/RoomMessage.tsx` (188 and 389 lines against the 228 and 400 they replace — the layout, the grouping rhythm, the identity line, the capsule and the pills all left; what stays is the surface's own data resolution and its prop documentation, carried over verbatim); `features/chat/ui/render-session-body.tsx`; `widgets/room-view/ui/render-room-body.tsx`; `features/conversation/model/body-renderer.ts` (the `ConversationBodyRenderer` contract); `features/chat/config/session-capabilities.ts`; `features/onboarding/model/narration-capabilities.ts`
  - `Conversation.Root` is mounted by `ChatPanel` (the session surface the route, the Obsidian embed and the dev simulator all mount), by `RoomSurface` (room/DM, task 1.4) and by `OnboardingConversation` (the scripted narration, which declares its own all-off table because it is a third host of the row)
  - **Deviation, forced by the layer rule:** `SESSION_CAPABILITIES` lives in `features/chat/config/`, not `widgets/session/model/`, and `render-session-body.tsx` in `features/chat/ui/`, not `widgets/session/ui/`. `widgets/session` is a 20-line route wrapper; the session's real host is `ChatPanel`, and `MessageList`, the row and all their tests live in `features/chat` — which may not import a widget's model. ESLint refused it outright (`no-restricted-imports`, four test files). `config/` rather than `model/` because the repo's `dir-size` hook errors at 25 files in `features/chat/model` and a capability table is a constant. P4 moves both up when the composer host lands in `widgets/session`.
  - **Deviation, deliberate:** `capabilities.toolCards` is declared by both hosts and read by neither yet. Each host's body renderer is fixed in P1, so there is nothing for the flag to switch; inventing a branch no surface exercises would be a check that cannot discriminate. P4's renderer map is where it goes live.
  - Test harnesses that bench a row directly now mount the same `Conversation.Root` the app does (7 room-view suites, `message-list-test-helpers`, `SessionMessage`, `QuestionOutcome`, `chip-tray-survives-turn-end`, 5 dev showcases). No assertion was changed or weakened — the whole client suite is green, including every room a11y, action-surface, reaction, mention and right-click-a-link case.
  - Renames the greps in task 1.9 require: `MessageItem` → `SessionMessage`, `RoomEntryRow` → `RoomMessage`, and their test files with them.

- Task #1.6: Test the row — capability gating, data-slots, row kinds, and the surface-switch scan — worker: p1-builder
  - Created: `features/conversation/__tests__/Message.test.tsx` (9 cases), `features/conversation/__tests__/no-surface-switches.test.ts` (a source scan over `ui/`, plus a case proving the scan actually sees the tree), `features/conversation/lib/__tests__/row-kinds.test.ts` (6 cases)
  - Three seeded defects on the ROW, each run and each red: reactions rendered unconditionally → "draws no reactions at all…" red; `runWith` hard-coded in → "withholds run this with…" red; `surface === 'room'` added to `NoticeRow` → the scan red.
  - **The fourth defect certifies something else, and the record was wrong to list it beside the others.** `GROUP_GAP_MS` 5 min → 60 min → "breaks a group on silence" red proves `buildTimelineRows` — the surface-neutral grouping math that predates this programme and is untouched by it. It says nothing about `ConversationRow`, whose `notice`, `moment` and `thread-reply` members this file never reached: its local `kindOf` could only ever return `message | day-divider | unread-divider`, so those three could have been deleted from the union and the suite would have stayed green. Corrected in session 2 — see below.
  - One assertion the task named differently: `anchor` changes the ACTIONS slot, not the gutter (the gutter is identical under both anchors — the anchor holds the capsule, not the identity column), so the case pins the real difference rather than a claim the variant does not make.

- Task #1.7: Show the Message.\* matrix in the Dev Playground — worker: p1-builder
  - New `dev/showcases/MessageRowShowcases.tsx` (minted as `ConversationRowShowcases.tsx`, renamed in session 2) holds two sections, both rendering the REAL components: **Message.\* matrix** (the two shipped capability tables side by side, then anchor × role × position × density, then one capability flag at a time) and **Conversation dividers** (`DayDivider`, `UnreadDivider` — neither had a bench anywhere before). Rendered from `MessageShowcases` and registered on the existing `chat` page in `dev/sections/chat-sections.ts`; the page rename and the five-section restructure stay P5's.
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

### Session 2 - 2026-08-18 (P1 review fixes, DOR-1328)

**Workers:** `p1-fixer` (the original builder could not be resumed)

Two independent reviews — spec compliance, then adversarial per `REVIEW.md` — found four blocking items and nine nits. All thirteen fixed; one commit per item group.

- **The Prettier CI gate was red** (`.github/workflows/typecheck.yml`, `pnpm format:check` — not part of `pnpm verify`, which is why session 1's ladder missed it). `apps/e2e/manifest.json` carried test-runner churn a local Playwright run left behind: three reflowed `relatedCode` arrays, four run counters, a dropped `runHistory` entry, and no trailing newline. Restored to the base blob so the file's diff is three path fixes and nothing else. The branch also picked up `spec/unified-conversation`'s one newer commit, which is where the design mockup's own formatting fix lives.
- **Three `relatedCode` paths in the e2e manifest pointed at deleted files** — `MessageItem.tsx`, `RoomThreadReplyRow.tsx`, `RoomNoticeRow.tsx`. Repointed and each target verified on disk.
- **17 references outside `apps/client/src` still named the old components.** Repointed across four `contributing/` guides, the rooms self-test command, an e2e page object and two fixtures, and two server-side TSDoc comments. Three were more than a rename: `interactive-tools.md`'s Step 7 was rewritten against how `render-session-body.tsx` and `AssistantMessageContent` actually work, `keyboard-shortcuts.md`'s wiring diagram now shows the props travelling by `MessageContext`, and `link-dispatch-policy.md` credits `Message.Root` with the `ContextMenuTrigger`. Left alone on purpose: `RoomEntryBody` (the shared Zod type) and `RoomEntryRow` (the drizzle row type) are unrelated server names, and records of the past keep their own words.
- **`row-kinds.test.ts` could not discriminate** — see the correction under task 1.6. Fixed by giving the rule a name (`roomEntryRowKind` in `widgets/room-view/lib/room-timeline.ts`, a discriminated result `RoomMessage` now branches on) and moving the suite to `widgets/room-view/__tests__/conversation-row-kinds.test.ts`, the only layer that can see both the union and its producer. It puts one room log through the host's own `groupByThread` → `buildTimelineRows` → `roomEntryRowKind` pipeline and expects each of the six kinds exactly once. Two seeded defects, two different reds: dropping the `body.moment` branch turns two cases red; dropping `moment` from `ConversationRow` turns typecheck red in three files.
- **The reactions capability did not hold on all three ways in.** `Message.Root` handed `EntryActionMenu` its quick row ungated while `Message.Actions` gated the identical prop, so the right-click menu and the touch drawer would have offered what the hover capsule withholds. Gated, with two long-press cases.
- **`Message.Reactions` drew its `data-slot` wrapper on every message**, reacted to or not. It now draws nothing until the message has carried a pill — latched, not read fresh, because `EntryReactionRow` outlives its own emptiness to run the last pill's fade.
- **The surface scan read only `ui/` and only `surface ===`.** It now globs `{ui,lib,model}` and matches both a comparison in either direction and a `switch` on the surface.
- Nits: `room-capabilities.ts`'s TSDoc pointed at a path that does not exist; a `toBeGreaterThan(0)` where the fixture has exactly one; a new `react/display-name` warning in `render-room-body.tsx`; a deep import of `MessageGrouping`, two doubled imports, and a relative `vi.mock` path; `ConversationRowShowcases.tsx` renamed to `MessageRowShowcases.tsx` (the old name reads as a bench for `features/relay`'s `ConversationRow`).

**Verification:** `pnpm format:check` exit 0 · `pnpm --filter @dorkos/client typecheck` clean · `lint` 0 errors / 118 warnings (one fewer than the P1 gate) · `pnpm verify` exit 0 · the dangling-reference grep over the whole tree returns nothing but two unrelated server homonyms and one line of prose.

### Session 3 - 2026-08-18 (P2, DOR-1329)

**Worktree:** `~/.dork/workspaces/dorkos/DOR-1329` · branch `DOR-1329` (based on `DOR-1328`)
**Workers:** `p2-builder` (P2, DOR-1329)

- Task #2.1: Build `deriveLaneState`, absorbing the session's strip-state — worker: p2-builder
  - Created: `features/conversation/model/lane-state.ts` — the ten-rung stack, `LaneState` verbatim from §5.2, plus `laneElapsed` and `LANE_TIMER_FLOOR_MS`
  - **The elapsed reading is NOT a field on the state, and that is what keeps the timeline still.** The spec's `presence` rung carries the immutable `since`; `laneElapsed(since, now)` is a separate pure function the lane's own leaf calls once a second. Putting a formatted number in the state would have made the whole lane a function of the clock, and the state is derived by the host.
  - `LaneAsk` is the P2 placeholder for `InteractionPendingEvent`. Rung 1 is written, tested and unreachable: every host passes the shared `NO_ASKS`, and its TSDoc names task 3.8 as where it goes live.
  - `LaneTurn` declares `operationProgress` / `systemStatus` structurally rather than importing `features/chat`'s — a feature may not reach into another feature's model, and the session host maps onto them.

- Task #2.2: Build `Conversation.LiveLane` — worker: p2-builder
  - Created: `features/conversation/ui/LiveLane.tsx` (the container: `h-6`, the one live region, the crossfade, the peek's trigger) and `ui/LaneContent.tsx` (the ten renderings, `stalledSentence`, `laneAnnouncement`, `laneMotionKey`)
  - The split is `ChatStatusStrip`/`StripContent`'s, kept for the same reason: "the lane never changes height" is then a property of one small file.
  - `data-lane-motion="on"|"off"` mirrors the `useReducedMotion()` branch onto the DOM, because the test harness strips motion props.
  - **The peek's trigger prevents `onOpenAutoFocus`.** Radix pulls focus into a popover on open, which would take a reader out of a half-typed message to look at a status readout. Verified in the browser: the caret stayed in the composer.
  - **The presence testid covers the WORDS only.** A letter avatar contributes its letter to `textContent`, and the shipped presence suite reads that node as one exact sentence — faces inside it made every assertion read "KKai is working…". Caught by the ported unit suite before it reached a browser.

- Task #2.3: Add `GET /api/rooms/:id/sessions` and its client query — worker: p2-builder
  - Created: `RoomSessionBindingSchema` + `RoomSessionsResponseSchema` (`packages/shared/src/room-schemas.ts`), `RoomService.listRoomSessions`, the route in `routes/rooms.ts`, its `registry.registerPath`, `Transport.listRoomSessions` + the HTTP and embedded implementations + the mock, and `entities/room/api/use-room-sessions.ts`
  - **`docs/api/openapi.json` and the fumadocs MDX were regenerated here, not left to P5.** Task 2.3 permits either; `.github/workflows/docs-openapi-check.yml` does not — it regenerates both on any `apps/server/src/**` or `packages/shared/src/**` change and fails on drift. Leaving it would have been a red gate on this PR.
  - **Deviation, small and stated:** the query key is `roomKeys.sessions(roomId)` (`['rooms','sessions',id]`) rather than the spec's bare `['room-sessions', roomId]`. One key factory is how every other room read is spelled, and a second spelling is one more thing an invalidation has to remember exists.
  - Its `enabled` defaults to `false`, so a caller that forgets to pass the peek's open state fetches nothing rather than fetching always.

- Task #2.4: Build the LivePeek, with the honest Stop — worker: p2-builder
  - Created: `features/conversation/ui/LivePeek.tsx`. Modified `entities/room/model/use-room-presence.ts`: `RoomPresenceAuthor` gains `entryId` (the summarised row's own claim, which is what "replying to …" points at), and a third hook, `useRoomPresenceClaims`, answers who is working WITHOUT the clock.
  - **The third hook is the point, not a convenience.** The lane is mounted by `RoomSurface`, which also mounts the timeline; reading the ticking `useRoomPresence` up there would redraw every row in the room once a second — the exact regression `useRoomPresenceAuthorIds` was written to undo, one layer up.
  - **Deviation:** `onOpenSession` is a prop the host supplies rather than the peek navigating for itself. It keeps `@tanstack/react-router` out of a neutral slice and makes the showcase a no-op instead of a router harness.

- Task #2.5: Mount the lane on both surfaces and delete the two old status lines — worker: p2-builder
  - Created: `features/chat/model/use-session-lane-state.ts` (the strip's lifecycle half) and `widgets/room-view/ui/RoomLiveLane.tsx` (the room's wiring, used by both the room column and the thread panel)
  - Deleted: `features/chat/ui/status/{ChatStatusStrip,StripContent,strip-state,inference-themes}` (four files, not the two the task names — `StripContent` is the strip's renderer and `inference-themes` its theme, and both had no other reader), `widgets/room-view/ui/{RoomPresenceLine,RoomStalledNotice}.tsx`, and their barrel exports
  - `RoomTimeline` gained `scrollToEntryRow(entryId)` — the interim shape of P4's `ConversationTimelineHandle.scrollToRow`. **Focus IS the flash**: every room row is already a tab stop with a focus ring, so landing the caret marks the row, keeps it marked, and puts a keyboard reader where a mouse reader is.
  - **Three of the ten rungs are deliberately dark on the session**, each with a reason in `use-session-lane-state.ts`: `ask` (P3's input), `stalled` (`ChatStatusSection` already reports the connection inside the composer card and P2 does not fold it — a second line would be the duplication this programme removes), and `queued` (its source is `ConversationTarget.queueDepth`, which is P4's).
  - **The thread panel's lane takes `stalled` only on a phone**, which is the rule `RoomStalledNotice` carried: beside a room already saying it, the same sentence twice is noise.
  - `RoomPresenceLine.test.tsx` was moved to `RoomLiveLane.test.tsx` rather than deleted — every claim it made about the words, the announcer and the collapse to one row per agent is still made, and the three that changed subject say so in the file.
  - Two shipped suites were edited, both for a real behaviour change rather than to accommodate a refactor: `ChannelsPage.test.tsx` now reads the lane's single announcer (the stall no longer has one of its own — one live region is the design), and `room-presence.spec.ts` waits for the ten-second timer floor (see Known Issues).

- Task #2.6: Test the lane, the route and the two browser claims — worker: p2-builder
  - Created: `features/conversation/model/__tests__/lane-state.test.ts` (23 cases), `apps/server/src/routes/__tests__/rooms-sessions.test.ts` (6), `apps/e2e/tests/conversation/{lane-no-shift,peek}.spec.ts`
  - **Seven seeded defects, each run and each red.** Swapping rungs 2 and 3 → the stalled-beats-presence case; dropping the `turnStatus` gate → the five-rung capability case; `presence[length-1]` instead of `presence[0]` → the oldest-claim cases (two); dropping the ten-second floor → the young-claim case; dropping the route's person gate → both agent cases; dropping the room filter → the this-room-only case; dropping `requireVisibleRoom` → the 404 case.
  - `lane-state.test.ts` declares its own capability tables rather than importing the shipped ones: a feature may not import a widget's model, and ESLint refuses it. The shipped tables are exercised where they are mounted.
  - Both browser specs passed on their first run.

- Task #2.7: Show every LaneState and the peek in the Dev Playground — worker: p2-builder
  - Created: `dev/showcases/LiveLaneShowcases.tsx` — two sections (`live-lane`, `live-peek`) drawing the REAL components from `LaneState` fixtures. Deleted `dev/showcases/RoomPresenceShowcases.tsx` and the `ChatStatusStrip` section of `StatusShowcases.tsx`.
  - **The identity page BORROWS the lane rather than keeping a presence-only copy.** The playground already has a cross-listing mechanism for exactly this (`IDENTITY_CROSS_LISTED`), so the four presence demos live once, on the page that owns the component. That is P1's "retire the duplicate rather than keeping two" applied a layer up, and it is what task 2.7's permissive "may stay registered there" allows.
  - **The `ask` rung's benches already exist**, drawn from the P2 placeholder: `live-lane` holds "An Ask" and "An Ask, with more behind it". **P3 task 3.11 should re-point them at the real `InteractionPendingEvent` rather than adding a second pair.**
  - **One showcase was written wrong and then fixed rather than shipped.** The reduced-motion bench wrapped the lane in `MotionConfig reducedMotion="always"` — which `useReducedMotion()` does not read (framer-motion 12 reads the media query directly), so it drew the same thing as every other bench. It now says plainly that the branch follows the reader's own system setting and names `data-lane-motion` as the way to see which one was taken. A bench that cannot show what it claims is worse than none.

- Task #2.8: Write the phase 2 changelog fragment — worker: p2-builder
  - `changelog/unreleased/260818-053738-one-line-says-who-is-working.md`, id minted at execution time. Five bullets, none of which claims the Ask.
  - `python3 .claude/scripts/changelog_backfill.py --check` → every user-facing commit on this branch covered, 0 uncovered. The count moves with each commit, so the fragment's `covers:` is refreshed rather than pinned to a number.

- Task #2.9: Phase 2 acceptance — the reviewer's browser check — worker: p2-builder
  - Cockpit from this worktree: server `DORKOS_PORT=4268 DORK_HOME=~/.dork-verify-p2` (fresh), client on `:4418`. Onboarding dismissed over the API, model pinned to `sonnet`, a channel seeded with 30 entries and DorkBot added to it. **Four real turns were spent** — the presence signals below are the dispatcher's own, not injected.
  - **A quiet room**: the lane is mounted, exactly 24 px, empty, and sits above the composer (lane top 678, composer top 730). The announcer is present and empty.
  - **Scrolled to the middle** (scrollTop 655, watched row top 164). Two entries arrived and DorkBot picked the work up; the lane went `empty → "DorkBot is working on it" → "… · 14s"` and **scrollTop and the watched row's top were 655 / 164 at every reading**. The lane-only window was isolated deliberately: the entry counts are equal across the before/after pair.
  - **The peek**: opened over the composer with the caret still in it (`document.activeElement` = "Message #p2-check…"). One row — face, `DorkBot · working · 7s`, `Replying to "@DorkBot write a long, careful essay…"`, **Open its session**, and **Stop** (one agent, so the per-row Stop; no footer). Clicking "Replying to" took the scroller from 0 to 1603, focused `room-entry-01M09PJB…`, and left it in the viewport.
  - **The new route, live**: `GET /api/rooms/:id/sessions` → `{"bindings":[{"authorId":"01M09P90J8E…","sessionId":"f6a3cdd0-…"}]}`.
  - **The session**: the same lane carried `0m 07s · ~775 tokens` after a turn, then `Working… 0m 08s ~0 tokens → 0m 12s ~83 tokens` while one streamed, at 24 px in every one of 16 readings.
  - **Killing the server**: the lane became `stalled` — the sentence verbatim, the Reconnect button, the announcer carrying it, and **presence gone rather than frozen**.
  - **The playground** (`/dev/chat#live-lane`): 25 lanes, one distinct height (24), all ten states present, three peeks, the single-agent Stop and `Stop everything in this room · Stops all 3`. Nothing on the page says `ChatStatusStrip`.
  - Screenshots (session scratchpad): `p2-quiet-room.png`, `p2-lane-working.png`, `p2-peek-open.png`, `p2-session-lane.png`, `p2-lane-stalled.png`.
  - **Verification ladder:** `pnpm format:check` exit 0 · `pnpm --filter @dorkos/client typecheck` clean · `@dorkos/server typecheck` clean · client `lint` 0 errors / 118 warnings (P1's count) · server `lint` 0 errors / 48 warnings · `pnpm verify` **exit 0**, 29/29 turbo tasks, 940 files / 11 656 tests. The first `pnpm verify` run failed one unrelated case (`McpAppFrame` "renders a strict-sandbox iframe") which passes in isolation and passed on the re-run — a flake in a suite this phase never touched.
  - **knip: no new orphan, and the totals fell.** Unused exports 557 → 556, unused exported types 588 → 586, duplicate exports 2 → 2. Three items this phase introduced were fixed rather than accepted: `formatTokens` (exported with no reader outside its module), and `LiveLaneProps` / `LivePeekProps` (barrel types a host never names — TypeScript infers them from `<Conversation.LiveLane>`).
  - **The `room-reactions` flake left no trace, and the manifest says so honestly.** It failed once in a parallel full-set run and passed 7/7 in isolation immediately after; the manifest's counters for it read 6 runs / 6 passes / 0 fails because the failing run was reported with `--reporter=list`, which replaces the config's reporter list and therefore never wrote the file. The failure is recorded here instead, which is the only place it exists.
  - Servers stopped afterwards; ports 4268 and 4418 answer nothing and `pgrep -f DOR-1329` is empty.
  - **`origin/DOR-1328` gained two commits while this phase ran** (a merge of `origin/main`, and the spec landing through PR #1090). Merged in, never rebased, at the end of the phase — which is also what took `specs/manifest.json` back to `origin/main`'s reading of an unrelated spec's status.

### Session 4 - 2026-08-18 (P2 review fixes, DOR-1329)

**Workers:** `p2-builder` (resumed)

Two independent reviews — spec compliance, then adversarial per `REVIEW.md`, the second driving the real cockpit including the thread panel, a 375 px viewport and dark mode — found three important items and five nits beyond the spec pass. All fifteen fixed.

- **The peek re-opened itself on every later turn** (reproduced 3×). `peekOpen` was local state and the popover UNMOUNTS when the rung leaves `presence`; Radix fires no `onOpenChange` for an unmount, so the flag stayed `true` and the next claim mounted the peek already open over the composer. It also meant `onPeekOpenChange(false)` never reached the host, leaving `useRoomSessions` enabled for the life of the view. **The reset is a render-time adjustment, not an effect** — `if (peekOpen && !offersPeek) setPeekOpen(false)`, the shape `RoomPresenceLine` used for the same class of problem — because a `setState` inside an effect is the cascading render `react-hooks/set-state-in-effect` is right to flag. Telling the host stays in an effect, guarded by a ref so it fires once per transition. Pinned by `features/conversation/__tests__/LiveLane.test.tsx` (new); seeded defect: delete the adjustment → the re-open case and the focus case go red together, re-run and confirmed.
- **Focus dropped to `<body>` when the peek unmounted under the reader**, which restarts Tab at the top of the page. The lane's root is always mounted, sits one Tab from the composer, and now takes the caret — but only when the reader was actually inside the lane or already stranded on `<body>`, so a peek closing while somebody types into the composer leaves them alone. Both halves tested.
- **"Replying to …" was a dead control in the thread panel** and for any claim the room draws no row for. The link resolved `room-entry-<id>` unconditionally, and a reply is never in the room's flow (`groupByThread` keeps it out), thread-panel rows carried no ids at all, and a phone unmounts the room column entirely while a thread is open. Three changes: thread rows get their own id namespace (`threadPanelRowId` — a namespace of its own because a thread's root is drawn twice on a wide screen and one id on two elements resolves to whichever came first); `scrollToEntryRow` becomes `scrollToRow(rowId)`, taking a DOM id and RETURNING whether it landed; and `RoomLiveLane` resolves the target per claim — the panel aims inside the panel, the room aims at the flow for a top-level entry and at the thread's own "↳ N replies" row for a reply, and anything else gets **no link at all**. `replyingTo` now carries `rowId` beside the excerpt: both halves or neither, because a link with nothing to say and a link with nowhere to go are the same broken promise. Three tests, one per branch.
- **Nits, all fixed:** the stalled sentence gets a short true form under `sm:` (at 375 px the full one truncated at "New messages aren't coming thr…", dropping the half a person can act on behind a `title` no finger can open) while the announcer keeps the full one; `presenceListRow` deleted with its test, having lost its only caller; `data-slot="live-peek"`; the elapsed leaf sleeps until its number is DUE instead of ticking through the ten seconds it draws nothing for; `NO_PRESENCE` joins `NO_ASKS` as a frozen constant; the route checks visibility BEFORE the person gate; `peek.spec.ts` says where the positive "Open its session" proof lives and why it is not a browser test; the session lane stops drawing the ROOM's announcer name on `/session` (`session-lane-announcer`, `data-lane-scope="session"`); the reduced-motion bench draws the real branch through a TSDoc'd playground-only `reducedMotionOverride`.
- **The e2e manifest re-serialized the whole file** — `json.dumps` defaults to `ensure_ascii=True`, so every non-ASCII character in 63 unrelated rows became `\uXXXX`. Rewritten with literal characters, and every untouched test's counters restored to their base values: those moved only because a local run happened to include them, which is churn a reviewer reads past rather than anything this branch decided. The diff is now this branch's three new entries and the two history rows its own runs produced.

**Verification:** `pnpm format:check` exit 0 · client/server/e2e `typecheck` clean · client lint 0 errors / **118** warnings (the P1 baseline — a `set-state-in-effect` warning the first fix introduced is what sent the reset to render time) · server 0/48 · e2e 0/6 · `docs:export-api` + `generate:api-docs` produce no diff · the deleted-name grep over `apps/ packages/ contributing/ docs/ .claude/ scripts/` returns **12** hits, all of them prose inside the replacements' own TSDoc saying what they replaced, and **0** live references.

## Files Modified/Created

108 files against `spec/unified-conversation`, by area. Client paths are relative to `apps/client/src/`.

**The new slice — `layers/features/conversation/` (new, 22 files):**

- `model/`: `capabilities.ts`, `conversation-context.ts`, `target.ts`, `body-renderer.ts` — the contract P2–P4 consume
- `lib/`: `row-kinds.ts` (new), `format-entry-time.ts` (moved from `widgets/room-view/lib/entry-time.ts`)
- `ui/`: `ConversationRoot.tsx`
- `ui/message/`: `MessageRoot`, `MessageGutter`, `MessageAuthor`, `MessageBody`, `MessageReactions`, `MessageActions`, `message-styles-context` (new); `MessageAttachments.tsx` (from `widgets/room-view/ui/RoomEntryAttachments.tsx`), `MessageAuthorAvatar.tsx` + `message-variants.ts` (from `features/chat/ui/message/`)
- `ui/rows/`: `NoticeRow`, `MomentRow`, `ThreadReplyRow` (from `widgets/room-view/ui/Room*Row.tsx`), `DayDivider`, `UnreadDivider` (from `features/chat/ui/message/`)
- `__tests__/`: `Message.test.tsx`, `no-surface-switches.test.ts` (new); `MessageAttachments.test.tsx`, `MessageAuthorAvatar.test.tsx` (moved with their subjects)
- `index.ts` — the barrel, exporting only what a host names

**The session host — `layers/features/chat/` (16 files):**

- New: `config/session-capabilities.ts`, `ui/render-session-body.tsx`
- `ui/message/SessionMessage.tsx` (replaces `MessageItem.tsx`); deleted `ui/message/RunWithMenu.tsx`
- Repointed: `index.ts`, `ui/message/index.ts`, `ui/ChatPanel.tsx` (mounts `Conversation.Root`), `ui/MessageList.tsx`, `ui/message/UserMessageContent.tsx`, `ui/primitives/tool-status-icon.tsx`, `model/stream/project-session-turn.ts`
- Tests: `SessionMessage.test.tsx` (renamed), `MessageList*.test.tsx` ×4, `chip-tray-survives-turn-end.test.tsx`, `message-list-test-helpers.tsx`, `ui/tools/__tests__/QuestionOutcome.test.tsx`

**The room host — `layers/widgets/room-view/` (24 files):**

- New: `ui/RoomMessage.tsx` (replaces `RoomEntryRow.tsx`), `ui/render-room-body.tsx`, `model/room-capabilities.ts`, `__tests__/conversation-row-kinds.test.ts`
- Deleted: `ui/RoomEntryRow.tsx` (400), `ui/RoomEntryHeader.tsx` (171), `ui/RoomEntryBody.tsx` (166), `ui/RoomEntryActions.tsx` (149)
- Modified: `index.ts`, `ui/RoomSurface.tsx` (mounts `Conversation.Root`), `ui/RoomTimeline.tsx`, `ui/RoomThreadPanel.tsx`, `ui/MentionPillRenderer.tsx`, `lib/room-timeline.ts` (gains `roomEntryRowKind`), `lib/entry-row-article.ts`, `lib/mention-markup.ts`, `model/agent-info-context.tsx`, `model/mention-roster-context.tsx`
- Tests: five `RoomEntryRow.*` suites renamed to `RoomMessage.*`, plus `RoomMomentRow`, `RoomThreadPanel`, `RoomTimeline`, `RoomTimeline.mentions`, `room-agent-faces` rehomed under the `Conversation.Root` the widget mounts

**Hover actions — `layers/features/entry-actions/` (5 files):** `ui/EntryRunWithMenu.tsx` (new, from chat), `lib/entry-actions.ts` (the `run-with` slot), `ui/EntryActionBar.tsx`, `ui/EntryActionMenu.tsx`, `index.ts`, `__tests__/EntryRunWithMenu.test.tsx` (renamed)

**Third host — `layers/features/onboarding/` (5 files):** `model/narration-capabilities.ts` (new, an all-off table), `ui/OnboardingConversation.tsx`, `model/onboarding-script.ts`, two tests

**Elsewhere in the client (5 files):** `layers/entities/room/lib/thread.ts`, `layers/shared/ui/markdown-content.tsx`, `layers/shared/ui/markdown-link.tsx`, `layers/features/composer/__tests__/DispositionMenu.test.tsx`

**Dev Playground — `src/dev/` (13 files):** `showcases/MessageRowShowcases.tsx` (new — the row matrix and the dividers), `showcases/MessageShowcases.tsx`, `sections/chat-sections.ts`, `sections/rooms-sections.ts`, `mock-samples.ts`, `showcases/{EntryActions,Identity,RoomDelivery,RoomThread}Showcases.tsx`, `showcases/entry-actions-showcase-data.ts`, `showcases/room-thread-showcase-helpers.tsx`, `simulator/SimulatorChatPanel.tsx`

**Outside `apps/client` (10 files):** `apps/e2e/manifest.json` + `pages/RoomsPage.ts` + `fixtures/{rooms,team-room}-api.ts`; `apps/server/src/services/rooms/room-service.ts`; `packages/shared/src/room-schemas.ts`; `contributing/{interactive-tools,keyboard-shortcuts,link-dispatch-policy,animations}.md`; `.claude/commands/chat/rooms-test.md` — all TSDoc/prose repointed at the rows that exist

**Artifacts:** `changelog/unreleased/260818-023659-one-message-row-everywhere.md`, this file

### P2 (DOR-1329) — 40 files

**The lane — `layers/features/conversation/` (5 files):** `model/lane-state.ts`, `ui/LiveLane.tsx`, `ui/LaneContent.tsx`, `ui/LivePeek.tsx` (all new), `index.ts`; `model/__tests__/lane-state.test.ts`

**The session host — `layers/features/chat/` (5 files):** `model/use-session-lane-state.ts` (new); deleted `ui/status/{ChatStatusStrip,StripContent,strip-state,inference-themes}` and `__tests__/ChatStatusStrip.test.tsx`; modified `ui/ChatPanel.tsx`, `ui/status/index.ts`, `index.ts`, `__tests__/ChatPanel-dorkbot-seed.test.tsx`

**The room host — `layers/widgets/room-view/` (7 files):** `ui/RoomLiveLane.tsx` (new); deleted `ui/{RoomPresenceLine,RoomStalledNotice}.tsx`; modified `ui/RoomSurface.tsx`, `ui/RoomThreadPanel.tsx`, `ui/RoomTimeline.tsx` (`scrollToEntryRow`), `ui/RoomComposer.tsx` (a doc pointer), `index.ts`; `__tests__/RoomLiveLane.test.tsx` (from `RoomPresenceLine.test.tsx`), `__tests__/ChannelsPage.test.tsx`

**The presence entity — `layers/entities/room/` (4 files):** `model/use-room-presence.ts` (`entryId` on the row, `useRoomPresenceClaims`), `api/use-room-sessions.ts` (new), `api/query-keys.ts`, `index.ts`

**Server + shared (5 files):** `apps/server/src/routes/rooms.ts`, `services/rooms/room-service.ts`, `services/core/openapi-registry.ts`, `routes/__tests__/rooms-sessions.test.ts` (new); `packages/shared/src/{room-schemas,transport-rooms}.ts`; `packages/test-utils/src/mock-factories.ts`; `apps/client/src/layers/shared/lib/transport/room-methods.ts` and `lib/embedded-mode-stubs.ts`

**Browser (2 files):** `apps/e2e/tests/conversation/{lane-no-shift,peek}.spec.ts` (new)

**Dev Playground (7 files):** `showcases/LiveLaneShowcases.tsx` (new); deleted `showcases/RoomPresenceShowcases.tsx`; `showcases/StatusShowcases.tsx`, `showcases/RoomsShowcases.tsx`, `pages/{ChatPage,IdentityPage}.tsx`, `sections/{chat,identity}-sections.ts`, `playground-config.ts`, `__tests__/playground-registry.test.ts`

**Docs + artifacts:** `docs/api/openapi.json` + `docs/api/api/rooms/id/sessions/get.mdx` (regenerated), `changelog/unreleased/260818-053738-one-line-says-who-is-working.md`, this file

**Fixture-only edits (5 files):** the four presence fixtures that gained `entryId`, and the tool-label fixtures that named a file this phase deleted

## Known Issues

Six things this phase decided rather than finished. Each names who picks it up.

1. **`SESSION_CAPABILITIES` and `render-session-body.tsx` are in the wrong layer, deliberately — P4's to move.** The spec puts both in `widgets/session/`; ESLint refused it (`no-restricted-imports`, four test files), because `ChatPanel`, `MessageList`, the row and their tests are all in `features/chat` and a feature may not import a widget's model. They sit at `features/chat/config/session-capabilities.ts` and `features/chat/ui/render-session-body.tsx` until P4's composer host lands in `widgets/session`, at which point both move up with it. `config/` rather than `model/` only because the `dir-size` hook errors at 25 files in `features/chat/model`. Both files say this in their own TSDoc, and so does `widgets/room-view/model/room-capabilities.ts`.
2. **`capabilities.toolCards` is declared by both hosts and read by nothing — P4 owns proving it.** Each host's body renderer is fixed in P1, so there is no branch for the flag to switch and no check that can go red on it today. Inventing one would be a check that cannot discriminate. P4's renderer map is where it goes live, and P4 is where the first honest test of it can be written.
3. **`DM_CAPABILITIES` does not exist, and P5 task 5.1 names it.** It was dropped as a duplicate export of `ROOM_CAPABILITIES` — a second name for the identical object costs a reader the question "how do these two differ?" whose answer is "they do not". **What P5 should do instead: render the DM column from `ROOM_CAPABILITIES` with `surface="dm"`.** If DMs ever diverge, `room-capabilities.ts` splits into two tables at that point.
4. **Run-with is a bar SLOT, and is absent from the right-click menu and the long-press drawer.** It is reachable on hover and by keyboard only, which is what it was before this phase — `EntryActionMenu` has nowhere to put a menu that opens a second menu, and its own TSDoc says so. **P4 must not assume the menu path carries it.** Its trigger keeps its own tab stop for exactly this reason: a capsule holding only run-with is still reachable by every reader.
5. **The `showTimestamps` preference now governs channels, which it silently ignored before.** A behaviour unified rather than preserved twice — the same preference, one gutter. It defaults to `false`, so nothing changes for a reader who has not turned it on, and the changelog fragment says so. Flagged here because it is the one place P1 changed what a person sees rather than only how it is drawn.
6. **The Dev Playground row matrix lives on `/dev/chat`, not on a page of its own.** `dev/showcases/MessageRowShowcases.tsx` renders both sections (`message-matrix`, `conversation-dividers`), `MessageShowcases` draws it, and `dev/sections/chat-sections.ts` registers it. `NoticeRow`, `MomentRow` and `ThreadReplyRow` stay benched on `/dev/rooms` against real room fixtures rather than being drawn a second time here. **The page rename and the five-section restructure are P5's** — this phase deliberately added to the existing page rather than pre-empting that.

### P2 (DOR-1329)

Five things this phase decided rather than finished.

7. **`room-presence.spec.ts` was edited, and the spec's own testing strategy says it should not have been.** The design record's state table says a claim under ten seconds shows **no timer** ("a number starting at 0s draws the eye for nothing"), §5.2 repeats it, and the User Experience walkthrough says the lane "starts counting at ten seconds" — while the Testing Strategy lists that suite among the ones that must stay "green unchanged". The two cannot both hold: the shipped suite asserts `Kai is working on it · \d+s` within Playwright's 5 s default and then polls for ≥ 3 s. **The design won**, because it is stated three times and argued once, and the suite now waits for the floor with a comment saying why. If a reviewer prefers the regression net, reverting is one constant (`LANE_TIMER_FLOOR_MS`) and two assertions.
8. **The session lane has no `stalled` rung wired.** `ChatStatusSection` already reports the connection inside the composer card, and P2 deliberately does not fold that component. Wiring a second line here would be two places saying one thing. **P4 owns the decision** when `Conversation.Footer` lands and the two are finally in the same tree. The rung itself is built and tested — only the session's input is `false`.
9. **The new route refuses a RESOLVED agent, not an unresolved header.** `resolveCaller` treats a token it cannot verify as "no agent presented", so `curl -H 'X-DorkOS-Agent: garbage'` answers 200 as the operator. That is every existing room route's behaviour and this one follows it. **P3's `requirePersonToAnswer` is specified to be stricter** (§Security: "including a header that did not resolve"), so P3 should decide whether this route joins it — the two gates would then disagree, which is worth one line of thought rather than a silent divergence.
10. **`data-testid="room-stalled"` and `room-presence` live in a surface-neutral slice.** Both names say "room" inside `features/conversation`, which draws the same rung for a session. They are kept because the shipped browser suites resolve by them (`RoomsPage.stalledNotice`, `.presenceLine`) and renaming would be a rename with no reader. P5's docs pass is where they could be reconsidered.
11. **The peek's "Open its session" is a host prop, not a link.** `onOpenSession(sessionId)` is supplied by `RoomLiveLane`, which navigates. The spec writes the link as `/session?session={id}`, and that is exactly what the host builds — the indirection keeps the router out of a neutral slice and makes the playground bench a no-op rather than a router harness.

### P2 review fixes (session 4)

12. **The popover-reset invariant is now load-bearing, and P3/P4 must keep it.** `Conversation.LiveLane` closes its own peek when `offersPeek` falls, at render time, and reports the close to its host in an effect. A future rung that can also open a popover (P3's Ask card is the obvious one) needs the same treatment or it will inherit the same bug. Pinned by `features/conversation/__tests__/LiveLane.test.tsx` — "closes the peek when its trigger stops existing, and tells the host" and "hands the caret back rather than dropping it on the document".
13. **P4 follow-up — the session lane's `stalled` and `queued` rungs are hard-coded.** `apps/client/src/layers/features/chat/model/use-session-lane-state.ts:123-125` passes `stalled: false` and `queueDepth: 0`. `stalled` wants `syncConnectionState` (available on the same hook that feeds the lane, `use-chat-session.ts`) once P4 decides whether the lane or `ChatStatusSection` owns the connection; `queued` wants `ConversationTarget.queueDepth`, which P4 introduces. The rungs themselves are built and tested — only the session's inputs are constants.
14. **`GET /api/rooms/:id/sessions` now checks visibility before the person gate**, which is the order §5.3.3 writes and the OPPOSITE of `POST /:id/attachments` (that one refuses an agent before multer reads a byte, which is a different concern). The reason is in the route's own TSDoc: with the person gate first, an outsider learned 403 (this room exists) where a person learned 404, which is a difference in answers where there should be none. **The unresolved-header divergence in item 9 above still stands** and is P3's to reconcile.

## Implementation Notes

### Session 1

Orchestration model (operator override of the per-task batching in `executing-specs`, logged as an assumption): one named, resumable builder agent per phase in that phase's worktree, executing the phase's tasks in dependency order and committing per task; then a two-stage review (spec compliance, then adversarial code quality per `REVIEW.md`) by separate agents; fixes return to the builder (resume ladder rung 1); the PR opens only after the review converges. Model tiers per `.dork/plugins/flow/config/config.json`: implementation/review = opus, mechanical = sonnet.
