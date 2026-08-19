# Implementation Summary: Unified conversation surfaces — one tree, approvals anywhere, a live lane

**Created:** 2026-08-18
**Last Updated:** 2026-08-18 (session 8 — P5, Dev Playground and docs)
**Spec:** specs/unified-conversation/02-specification.md
**Tracker:** DOR-1327 (umbrella) — phases DOR-1328 (P1) · DOR-1329 (P2) · DOR-1330 (P3) · DOR-1331 (P4) · DOR-1332 (P5)

## Progress

**Status:** Complete
**Tasks Completed:** 48 / 48

**Pull requests, by phase:** P1 `#1091` · P2 `#1092` · P3 `#1093` · P4 `#1102` · P5 `#1108`.

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

### Session 4 - 2026-08-18 (P3, DOR-1330)

**Worktree:** `~/.dork/workspaces/dorkos/DOR-1330` · branch `DOR-1330` (based on `DOR-1329`, merged again at the task-7 boundary once P2's review fixes landed)
**Workers:** `p3-builder` (P3, DOR-1330)

- Task #3.1: The interaction-events wire module — worker: p3-builder
  - Created `packages/shared/src/interaction-events.ts` + the `exports` subpath. `InteractionPendingEvent` carries the `PendingInteractionDTO` verbatim plus `sessionId`, `cwd` and the optional room pair; `InteractionResolvedEvent` carries the id, the outcome and a timestamp.
  - **Deviation, deliberate:** `Transport.listPendingInteractions` and both implementations landed in 3.5's commit rather than here. The task itself names the problem ("adding the interface method here will red the two implementations until then"), and the repo's `pre-commit` hook runs a whole-monorepo typecheck — so a commit carrying the interface alone could not exist. Nothing about the end state changed.

- Task #3.2: The projector's interaction seam — worker: p3-builder
  - `onProjectorInteractionChange` beside `onProjectorStatusChange`, throw-isolated the same way, plus `listPendingInteractionsAcrossSessions` beside `listProjectorStatuses`. The projector still imports no transport.
  - **The three fire points are two in the code, and the spec's table is why.** `interaction_cancelled` does not exist as an event type: cancellation and expiry both ride `interaction_resolved` with a `resolution`, so `askOutcomeOf` maps the stream's five resolutions onto the three a receipt can say. The third point is `markInterrupted`, which announces `cancelled` for everything a torn-down turn was parked on — it deliberately does NOT clear the map, because `hasPendingInteractions` bounds a stranded entry by expiry and clearing it here would change the watchdog and lock semantics that path documents.
  - **A prompt from a session with no `cwd` is dropped, loudly.** `cwd` is the deep link and the identity fallback, and there is nothing honest to put on the wire without one; every turn that can raise a prompt was started with one, so it logs a warning rather than dropping into silence.

- Task #3.3: The broadcast, with the room joined on — worker: p3-builder
  - One more subscription in `SessionListBroadcaster.start()`, `.parse()` on both payloads, unsubscribed in `stop()`. `RoomSessionLedger.bindingForSession` is one indexed read plus — only on a miss — the `successorFor` chase, so the id a turn started under still resolves after a rekey.
  - **Deviation, and the module's own history is the reason:** the port is injected by `setRoomBindings()`, not as a `start()` argument. `setOriginResolvers` two methods up documents exactly why — a live Claude account switch restarts discovery, so anything passed only to `start()` has to be re-passed by every caller that ever restarts it, and missing it here would read as an Ask that stopped naming its room after an account switch.
  - `resolvedBy` is never set on a single-identity install: the broadcaster has no HTTP caller to name, and inventing one would be the denormalization the wire shape exists to avoid. The receipt says "Already answered at 2:01" instead.

- Task #3.4: The list route and the answer guard — worker: p3-builder
  - `GET /api/sessions/pending-interactions` above `/:id`, joined per row with the ledger through `app.locals.roomSessionBindings` (the same indirection the origin overlays already use). `requirePersonToAnswer` on all six answer routes, composed from `readCallerAuthority` → `resolveDecisionAuthority` + `requireOperatorCookieUnderLogin`, with no new predicate.
  - The refusal keeps the resolver's own `AGENT_CANNOT_DECIDE` sentence and supplies its own for the cookie bar, which is the split `routes/config.ts` already makes.

- Task #3.5: Both ends of the allowlist, and the transport — worker: p3-builder
  - `sse-event-allowlist.test.ts` caught the first attempt: an apostrophe in the new comment read as an event name to its single-quote scan, exactly as the rooms block above it warns. Fixed by writing the comment without one.
  - `DirectTransport` gets a REAL implementation: a required `pendingInteractions` seam on `DirectTransportServices`, wired in `CopilotView` to the same `listPendingInteractionsAcrossSessions` the HTTP route reads. The embed answers prompts for real, so it lists them for real.
  - Also the passing fix the spec asks for: `stream-manager.ts`'s "two durable streams" docstring now says three.

- Task #3.6: The fleet-wide store, and Heads up stops guessing — worker: p3-builder
  - `entities/attention/model/use-pending-interactions.ts` (list-on-mount + two subscriptions, upsert by id, dedupe against the per-session store), plus `ask-receipt-store.ts` and `describe-interaction.ts`.
  - The degradation branch and its comment are gone: a background agent's question is a `question` on every session now, and the row says what the agent asked for.
  - **`describeInteraction` lives in the entity, not in `features/ask`.** Both the sidebar row and the card's headline need the same half-sentence, and a feature may not read another feature's lib — so the phrasing is in the layer both can reach, and `askHeadline` is the agent's name in front of it.

- Task #3.7: `features/ask` — worker: p3-builder
  - New slice: `AskCard.{Root,Face,Headline,Detail,Countdown,Actions,Receipt}`, `InteractionAsk`, `AskStack`, `AskList`, `AskReceiptLine`, the four moved prompts and two moved receipts, `use-answer-ask`, `use-ask-shortcut`, `ask-tray-store`, `ask-headline`, `group-asks`, and the two moved libs.
  - **Three primitives moved DOWN rather than sideways.** `OptionRow`, `CompactResultRow` and `TruncatedOutput` are now `shared/ui`: the moved prompts need them and so does the transcript, and `features/ask` importing `features/chat`'s internals is the barrel cycle P1 already refused once. `InteractiveCard` is deleted — `AskCard.Root` is what it was, and the playground bench follows.
  - `decision-refusal.ts` moved to `shared/lib` for the same reason: two card families now surface a refusal, and one of them would otherwise reach into the other's lib.
  - **`A`/`D` are additive, not a replacement.** They are React key handlers on the card, so they fire only while focus is inside one; the active card in the input zone still answers to bare Enter and Esc through `useInteractiveShortcuts`, and the `Kbd` hints still advertise those because those are the keys that work without focusing the card first.
  - **The countdown changed on purpose:** the bar is `aria-hidden` decoration and the words are the accessible reading, so the words are present from the start instead of appearing at two minutes. Five shipped assertions were rewritten to the new contract rather than deleted.

- Task #3.8: Five surfaces, and the lane's amber rung — worker: p3-builder
  - Header pill and home triage count prompts and capability approvals together and draw both lists (prompts first — ten minutes against two hours, which IS time-left order). The room lane filters by `roomId`, the session lane by `sessionId`.
  - **The lane grows into the card through the peek's own popover**, not by growing the lane: the 24 px promise is the reason the lane exists, so the card is drawn OVER the composer. It takes focus on open (a person opened it to answer something) where the peek deliberately does not.
  - **`⌘⇧A` was already taken, and the spec did not know.** `SHORTCUTS.AGENT_PROFILE` has owned it since the profile panel shipped. Rather than take a key from a working feature or invent a chord nobody would guess, `useAskShortcut` claims it in the CAPTURE phase and only while something is actually waiting; with nothing pending it registers nothing and Profile opens exactly as before. Both are listed in the `?` panel, the registry test carries the new one in `DECLARED`, and `contributing/keyboard-shortcuts.md` states the rule.

- Task #3.9 / #3.10: The tests — worker: p3-builder
  - Server: `sessions-pending-interactions.test.ts` (29 cases — the list, the route ordering, and the six-routes × three-callers table written out), the projector seam exercised directly, `session-list-broadcaster-asks.test.ts` for the join and the ordering, `room-session-ledger.test.ts` for the rename chase.
  - Client: `ask-headline`, `use-answer-ask`, `use-pending-interactions`, `AskCard.test.tsx`, and the attention derivation extended.
  - Browser: `apps/e2e/tests/conversation/ask-anywhere.ts`, registered by `chat-mock.spec.ts` under the lock `interactive-prompts.ts` documents.
  - **The browser test found a real defect before a person could.** An answered card left the list in the same frame it was answered, so the receipt had nothing to render into and the header pill unmounted around it. Answered prompts now SETTLE — out of what is waiting immediately, held on screen for 1.2 s saying how they ended — and `AskCard.Root` finally spends the shipped `RESOLVE_HOLD_S`/`MELT_S` exit it had been given a helper for and never used.
  - Seeded defects run and confirmed red, then reverted: notify before `this.interactions.set` (11 projector cases red, including the ordering one); the guard removed from `batch-deny` (exactly that route's two refusal rows red); the key handler moved off the card (both focus cases red).

- Task #3.11 / #3.12: Playground and changelog — worker: p3-builder
  - Five sections on `/dev/chat` drawing the real components over fixture events, each ask measured against a `now` read once at module load rather than per render. (P5's review found the constant had been written out as a fixed date instead, which made every deadline a past one — see Known Issues → P5.)
  - One fragment for the phase, plus P1's squash subject claimed on P1's own fragment — `main` landed P1 as one commit no fragment named, so the gate read it as uncovered on every branch downstream.

- Task #3.13: Phase 3 acceptance — the reviewer's browser check — worker: p3-builder
  - Cockpit from this worktree: server `DORKOS_PORT=4277 DORK_HOME=~/.dork-verify-p3` (fresh), client on `:4427`, onboarding dismissed over the API, model pinned to `sonnet`. **Two real turns were spent** — DorkBot in `#team`, asked to write a file outside its working directory, which raises a genuine permission prompt.
  - **The room**: the lane went amber within a second — `data-lane-state="ask"`, exactly 24 px, "DorkBot wants to write · Answer". The sidebar's Heads up row read "DorkBot wants to write" (it would have said "Waiting on you" before this phase).
  - **Every route**: the header pill read "1 waiting on you" on `/channels` and on `/tasks`.
  - **`⌘⇧A` on `/tasks`** opened the tray and landed focus inside the card (`focusInsideCard: true`) — and did NOT open the Profile panel. Answering there wrote `/tmp/p3-check.md`: the agent carried on, which is the half a vanished card cannot fake.
  - **Typing**: with a second prompt live in the room, `half typed note` went into the composer and `a` typed the letter — composer value `half typed notea`, caret at the end, focus still the composer, the Ask still waiting.
  - **Answering from the room**: clicking the lane grew it into the card over the composer (the composer's draft untouched), Allow wrote `/tmp/p3-check-two.md`, the pill cleared and the lane returned to `empty`.
  - **The refusal**: all six answer routes answered **403 `AGENT_CANNOT_DECIDE`** to `curl` with an `X-DorkOS-Agent` header that resolves to no agent at all.
  - **No leak into the room**: both durable notices read "DorkBot is waiting for you to approve something before it can carry on…" — word for word the shipped sentence, with no tool name, no path and no countdown.
  - Screenshots (session scratchpad): `p3-room-lane-amber.png`, `p3-tasks-tray-card.png`, `p3-room-card-grown.png`.
  - **Verification ladder:** `pnpm format:check` exit 0 · `pnpm verify` **exit 0** (29/29 turbo tasks; client 944 files / 11 692 tests, server 720 files / 11 985 tests) · client lint 0 errors / 118 warnings, server 0/48 · `docs:export-api` + `generate:api-docs` produce no diff · `chat-mock.spec.ts` 54 passed · `tests/conversation` + `tests/rooms` 76 passed (one unrelated room read-state flake under parallel load, green in isolation).
  - **knip: totals fell.** Unused exports 556 → 555, unused exported types 586 → 585, duplicates 2 → 2. Eleven barrel exports and four types this phase introduced were trimmed rather than accepted: the `AskCard.*` parts are reached through the namespace, and `askHeadline`, `groupAsks`, `useAnswerAsk`, `requestAskTray` and friends have no reader outside the slice.
  - Servers stopped afterwards; 4277 and 4427 answer nothing, `pgrep -f DOR-1330` is empty, `~/.dork-verify-p3` removed.

### Session 5 - 2026-08-18 (P3 review fixes, DOR-1330)

**Workers:** `p3-builder` (resumed)

Two independent reviews — spec compliance, then adversarial, the second driving
four real prompts through DorkBot, curling all six routes as an agent, forging
ids, pressing Stop mid-prompt and watching two windows. The server spine came
back exact. Nine blocking items and eight nits, all fixed:

- **The fleet card never said WHAT it was approving.** Two causes, one symptom.
  The SDK's `displayName` for a `Write` is the bare word "Write", so the label
  ladder took it and the headline read "wants to write" with no file in it — the
  same `label === toolName` test the tool label already got now applies to it.
  And `InteractionAsk` drew no `AskCard.Detail` at all, so the `description`,
  the `blockedPath` and the `decisionReason` the inline transcript card has
  always shown were invisible on every fleet surface. Both fixed and tested
  against the real payload shape.
- **The countdown was wrong for every listed question and elicitation.** It
  anchored to `startedAt + remainingMs`, and `remainingMs` is the budget MINUS
  the time already spent — so anything past half way was born expired. The fix
  is the honest one the spec asks for: `timeoutMs` now rides every kind of DTO,
  stamped by the one selector that measures the remainder, and the card anchors
  to `startedAt + timeoutMs`. The tray sorts by that deadline too.
- **A refused answer stranded the card.** The optimistic receipt was written
  before `run()` and nothing took it back, so a 403 left "You allowed this" over
  a request still waiting, with no buttons. `forgetAskReceipt` drops the receipt
  and the settling hold together.
- **The two trays did not join the roster and offered no way into the session.**
  One shared hook (`useAskAgentNames`), both surfaces pass it and `onOpenSession`.
- **Home triage tore its own receipt away** (no settling term in `showsWaiting`),
  and the **header pill printed "0 waiting on you"** for the second it stayed up
  saying so. Both fixed and tested.
- **The pill called every prompt an approval request.** A question is not one;
  the accessible name and the panel summary now depend on what is queued.
- **The room lane's `roomId` filter was untested** — `filter(() => true)` left
  23/23 green. Two rooms' prompts now go in and only one comes out.
- **The chord moved to `⌘⇧Y`** (item 15) and is PROVED in the shortcuts gate.
- **The changelog's privacy claim was not implemented** (item 23), and its prose
  lost two em dashes and glossed "API keys".
- Nits: the lane showcase's Answer opened an empty panel and its clock was live;
  `AskCard.Root` defaulted to inactive and dimmed every tray card; the burst card
  re-implemented answering with raw transport calls and swallowed refusals into
  `console.error`; the session drew one prompt three times; the store's docstring
  contradicted its own import; `InteractionResolvedEvent`'s name collision is now
  stated; two guides still named `ToolApproval`; `AGENTS.md`'s subpath count was
  stale; the e2e manifest gained an `ask-anywhere` row.

**Verification:** `pnpm verify` exit 0 · client 944 files / 11 702 tests · server
720 / 12 002 · `pnpm format:check` clean on all tracked files · `docs:export-api`

- `generate:api-docs` no diff · the browser check re-run for the two visible
  fixes (see the screenshots below).

### Session 6 - 2026-08-18 (P4, DOR-1331)

**Worktree:** `~/.dork/workspaces/dorkos/DOR-1331` · branch `DOR-1331` (based on `DOR-1330`, merged again at the task-6 boundary once P3's review fixes landed)
**Workers:** `p4-builder` (P4, DOR-1331)

- Task #4.1: One scroll hook for every conversation — worker: p4-builder
  - Created `features/conversation/model/use-timeline-scroll.ts`. Moved `use-unread-cursor.ts` (`features/chat/model/view/` → `features/conversation/model/`) and `ScrollThumb.tsx` (`features/chat/ui/` → `features/conversation/ui/`), both with `git mv`.
  - **The merged hook does NOT follow the tail, and that is the one place the spec's plan met the tree.** §2.4 says the contract is `use-stick-to-bottom`'s. Most of it is: the near-bottom slack is the room's 64px verbatim, the settle-frames rule and the "a scroller with nothing to scroll has not landed" guard came over whole. But the FOLLOW half is the virtualizer's — `MessageList` retired its own copy for `anchorTo: 'end'` + `followOnAppend` long before this phase, and the merged list is virtualized, so writing `scrollTop` on every arrival would fight it one frame apart on every streamed token. What the hook keeps is what the virtualizer cannot answer: where the reader is, whether anything arrived while they were away, and where they were standing the last time this scroller existed.
  - **The position memory is module-level**, keyed by conversation, because the component holding it is exactly what disappears: on a phone the thread panel is a full-screen push that unmounts the room column, timeline and all. The retired hook survived that by living in the page above.
  - Three seeded defects, each run and each red: slack 64 → 0 (the part-rendered-row case); dropping the forget-on-switch (the room-switch case); pinning on a first landing (the unread-rule case).

- Task #4.2: `Conversation.Timeline` — worker: p4-builder
  - Created `features/conversation/ui/Timeline.tsx`; moved `RoomPendingRow.tsx` → `ui/rows/PendingRow.tsx` (the LIST is gone — the timeline takes `pending` and draws one row per message).
  - **Deviation, recorded: the prop is `renderRow`, not `renderBody`.** §2.4 gives the timeline a `ConversationBodyRenderer`, which would mean the timeline composed `Message.*` itself. It cannot: the two row wrappers are where each surface's own knowledge lives — a session's `MessageProvider` and its run-with action, a room's reactions, roster join, article summary and its notice/moment branches — and P1 deliberately kept them as host components. So the timeline draws the scroller, the virtualizer, the feed, the thumb, the affordances and the pending rows, and calls the host back for every row. `ConversationBodyRenderer` is untouched and still the §2.6 seam INSIDE those rows.
  - **`ConversationRow` gained a `label` and lost two fields it could not be given.** `day-divider` now carries the label rather than `at` (the shared `buildTimelineRows` phrases it once, against the `now` it was handed, so both surfaces say the same words on the same day), and `unread-divider` lost `count`, which neither producer computes and `UnreadDivider` does not draw.
  - Two seeded defects, run and red: handing `onOpenThread` down ungated (a session grows a reply row); mounting both live regions unconditionally (a channel gains two silent ones, and the lane's single announcer stops being single).

- Task #4.3: Both surfaces mount it; `MessageList`, `RoomTimeline` and both scroll hooks deleted — worker: p4-builder
  - Deleted: `features/chat/ui/MessageList.tsx` (531), `features/chat/model/view/use-scroll-overlay.ts` (49), `widgets/room-view/ui/RoomTimeline.tsx` (339), `widgets/room-view/model/use-stick-to-bottom.ts` (223) + its suite, `features/chat/ui/ChatMessageArea.tsx`.
  - Created `widgets/room-view/ui/RoomFlow.tsx` (what is left of `RoomTimeline` once the list is shared) and `widgets/session/ui/SessionTranscript.tsx` (what is left of `MessageList` + `ChatMessageArea`).
  - **The session HOST moved to `widgets/session`** — `ChatPanel.tsx`, the transcript, `session-capabilities.ts` and `use-session-lane-state.ts`, plus eleven suites. `features/chat`'s barrel widened to what the widget composes; `App.tsx` and `SessionPage` import it from the widget now.
  - **P1's Known Issue 1 is half done, and the other half is answered rather than deferred.** `SESSION_CAPABILITIES` moved. `render-session-body.tsx` did NOT, and cannot: the row that calls it is `SessionMessage`, which `features/onboarding` renders for its scripted narration (`OnboardingConversation.tsx:378`) — a feature, which may not import a widget. So the row stays a feature export and its renderer stays beside it. Both files say so.
  - **The virtualizer is stood in for globally, in `apps/client/src/test-setup.ts`.** jsdom lays nothing out, so a real one measures every row at 0 and answers with an empty window — every room and chat assertion about WHICH rows are drawn would have gone vacuous at once. Same reasoning and same place as the `motion/react` stand-in above it.
  - The peek's `scrollToRow` is `ConversationTimelineHandle`'s now: `RoomLiveLane` takes an `onScrollToRow` prop, both hosts hand it the timeline's handle, and the handle scrolls a row into existence before landing on it — which virtualization made necessary. `entryRowId` / `threadPanelRowId` / `threadRowId` are unchanged, so P2's tests still resolve.

- Task #4.4: The two `ConversationTarget` adapters — worker: p4-builder
  - `widgets/session/model/session-target.ts` (has `queue`), `widgets/room-view/model/room-target.ts` (does not, and `canSend: false` for an archived room, with the sentence saying why).
  - **`ConversationAttachmentPort` was reshaped and `ConversationMentionPort` was removed.** P1 declared `upload(file): Promise<string>`; neither surface works that way and neither could — a room mints its attachment ids in the same breath as the post, a session rewrites the message text with saved PATHS at submit. Both stage at the keystroke, so the port is the staging state `Composer.Attachments` already renders from. The mention port went because the `@` picker is a keyboard controller over the field, not a data source; `capabilities.mentions` stays the single fact. `target.ts` carries both arguments in full.

- Task #4.5: `Conversation.Composer` + `Conversation.Footer`; both hosts deleted — worker: p4-builder
  - Created `features/conversation/ui/ComposerHost.tsx` and `ui/ConversationFooter.tsx`. `ChatInputContainer.tsx` (536) → `widgets/session/ui/SessionComposer.tsx`, `RoomComposer.tsx` (604) → `widgets/room-view/ui/ChannelComposer.tsx`, `InteractiveInputPanel.tsx` → `widgets/session/ui/SessionAsks.tsx`. All three names are gone from the tree.
  - **What the card owns and what the surface owns.** The card owns the arrangement (head, overlay lane, chip bar, queue chrome, above-input, field, footer) and three rules read off the target: no queue chrome at all when `target.queue` is undefined; `canSend: false` drawn with the target's own sentence; the chip bar and paperclip from the attachment port. Each surface keeps its own palettes, its own Enter, its own draft store, and its own `Composer.Input` wiring through one `input` prop.
  - **The DOM baselines held, and they are the evidence.** `session-composer.*.json` (9 trees) and `ChannelComposer-chrome-delta.test.tsx` compare the two cards node for node against the pre-migration recordings; both pass unchanged. Two things came out of that: `Conversation.Footer` takes `asChild` (a wrapper would be a node the baseline does not have), and the card invents NO refusal sentence for a failed upload — the two surfaces answer that state differently on purpose and each keeps its own answer.
  - The takeover slot distinguishes `undefined` (this surface is never taken over — a channel draws its Asks in the lane) from `null` (it can be and is not right now), which is what keeps the exit animation able to play.
  - Three seeded defects, run and red: gating the queue slot on depth alone; rendering the takeover branch on `capabilities.asks`; passing `canSubmit` through without reading `canSend`.

- Task #4.6: `AssistantMessageContent` split — worker: p4-builder
  - 594 → 386 lines, split BY PART KIND rather than at a line count: `ui/message/auto-hiding-parts.tsx` (187 — the tool card and the thinking block, which are the same shape with a different inside) and `ui/message/CollapsibleRun.tsx` (54 — the run of them). Behaviour identical; its own suite and `approval-receipts.test.tsx` pass unchanged.

- Task #4.7: Tests, knip and the browser suites — worker: p4-builder
  - Created `features/conversation/__tests__/Timeline.test.tsx` (14) and `__tests__/ComposerHost.test.tsx` (11); extended `no-surface-switches.test.ts`'s guard to name `ui/Timeline.tsx` and `ui/ComposerHost.tsx` (the glob already covered them — read, not assumed).
  - **knip: totals fell.** Unused exports 558 → 552, unused exported types 585 → 580, unused files 3 (all pre-existing and unrelated). Eleven exports this phase introduced or widened were trimmed rather than accepted.
  - **The room's browser suites needed one honest change, and it is the port's finding rather than a test being bent.** `expect(entries).toHaveCount(30)` is a claim virtualization makes impossible — the room draws about nineteen of them and always will. `RoomsPage.waitForHistory(total)` replaces it: the virtualizer sizes the scroller for every row it knows about, so "the history has landed" is a question about the scroller. Three specs use it. `RoomsPage.replyRow` steps up to the virtual row box before looking for its sibling, for the same reason.
  - **Two real regressions the suites caught, both fixed here.** The timeline moved every row with its own `position: absolute` + `transform`, which made each row a containing block: a message's sticky action rail stopped riding the viewport edge (measured 66px low) and a row's reply line stopped being its DOM sibling. It now moves ONE box holding the drawn window, and the rows are in ordinary flow.

- Task #4.8: The phase changelog fragment — worker: p4-builder
  - `changelog/unreleased/260818-121139-long-channels-scroll-smoothly.md`, covering all eight commits. Two bullets, both things a person sees: long channels scroll smoothly, and a message arriving while you read back gives you a button instead of taking the view.

- Task #4.9: Phase acceptance — worker: p4-builder
  - **The third and largest bug of the phase, found only in the browser, and it took three attempts to fix.** On a phone, coming back from a thread landed the room at `scrollTop: 0` — 900px before, 0px after, the exact defect the room's retired hook existed to prevent. The route to the fix is worth recording because each stage was wrong for a different reason:
    1. A remembered `scrollTop`, re-applied when the scroller re-attached (the retired hook's own mechanism). It cannot work under a virtualizer: the total height starts as an estimate for every row — measured 16 000px — and settles to the truth — 4 159px — over the next few frames, and `anchorTo: 'end'` holds the reader's distance from the END while it does. It carried 900 down past zero.
    2. A remembered ROW, in a module-level map. The right unit, the wrong home: nothing in the timeline can be sure when to forget it, and the map was empty by the time the room came back. `data-landed-on` — a `data-` attribute the timeline publishes saying which of `remembered` / `unread` / `end` its landing took — is what turned that from a guess into a reading, and it is kept because `room-entry-actions.spec.ts` now asserts it.
    3. A remembered row held by the HOST. `RoomSurface` is what survives the push, so it holds the row (a ref, written from the timeline's `onTopRow`, cleared on a room switch) and hands it back through `resumeRow` at landing time. The timeline also had to wait for a measured commit before landing at all — a `scrollToIndex` issued from the first commit is aimed at a list with no geometry.
    - **Measured after, on a 390x844 viewport: left at "resume line 186", returned at "resume line 186".** The FIRST VISIBLE row rather than the first drawn one, which is a second small fix: the virtualizer keeps a few rows of overscan above the viewport, and remembering one of those put a returning reader five messages higher than they had been.
  - **P2's Known Issue 13 closed: both session lane rungs are wired.** `stalled` from `syncConnectionState` (`disconnected` or `reconnecting`; `connecting` is the opening handshake and says nothing), `queued` from `ConversationTarget.queueDepth`. P2 asked P4 to decide whether the lane or `ChatStatusSection` owns the connection, now that P4's footer puts them in one tree: they are not the same sentence — the status line says what the CONNECTION is doing as one chip among the model, the mode and the branch, and the lane says the conversation has stopped hearing, in the one place a reader looks before pressing Enter. A room draws exactly that from the same rung. Seven cases, and P2's two constants seeded back in go red on four of them.
  - **The browser check, as the spec words it.** In a busy channel (211 entries, seeded over the API): scrolled fast — the thumb tracked (height 149px, offset 16.8px at `scrollTop` 60); the unread rule stayed where it was; opening a thread kept the position on both shapes (desktop: room `scrollTop` 700 unchanged with the panel open; phone: the row-exact return above); a message posted while the reader was 30 messages up raised the **"New messages" pill** and moved the view by exactly 0px. In a room: `@dork` opened the picker over the roster, Enter inserted `@dorkbot`, a file staged as a `notes.txt` chip above the box, and the send landed with `attachments: 1` and the resolved mention id — the room target's whole path.
  - **The session half, walked on a live Sonnet turn.** Two messages queued mid-turn: the card drew `Queued (2) · Sending one at a time as the agent finishes` with both rows, the field read `Compose another — 2 queued`, and the footer (`ChatStatusSection`, through `Conversation.Footer asChild`) sat under it unchanged — one card, both surfaces' shape, the session's own wiring. Then the server was killed: the lane went `stalled` within twelve seconds and said _"New messages aren't coming through right now. You can still send — anything that doesn't get through will say so."_
  - **Two findings from that walk, both recorded rather than quietly accepted:**
    - **The lane's `queued` rung is unreachable on a session in practice.** It is rung 9, below every `turn-*` rung, and a session only HAS a queue while a turn is open — so `turn-streaming` always wins. The queue is still visible, in the composer's own panel (the screenshot), which is where P2's ordering intends it. The rung is not dead: it is the surface with `turnStatus: false` — a channel — that would draw it. **What would make it reachable on a session** is moving `queued` above `turn-streaming`, which is a change to a priority table P2 argued three orderings of.
    - **The `stalled` rung and `ChatStatusSection`'s "Live updates lost" chip now say the same thing six pixels apart** — visible in the same screenshot. P2 raised exactly this (Known Issue 13) and left the decision to P4; P4 wired the rung on the argument that the two are different sentences, and the browser weakens that argument. **The follow-up is one of two lines: drop the chip from the status line, or dark the rung on `turnStatus` surfaces.** Flagged with the evidence rather than settled here, because it is a decision about a component the spec says moves unchanged.
  - Screenshots: `p4-new-messages-pill.png`, `p4-thread-keeps-position.png`, `p4-thread-return-phone.png`, `p4-mention-picker.png`, `p4-attach-and-mention.png`, `p4-session-queue.png`, `p4-session-stalled.png`.
  - **Browser suites, run from this worktree on moved ports:** `tests/rooms` + `tests/conversation` **74 passed / 0 failed**; `chromium-mock` (the chat suites) **54 passed / 0 failed**. The mock leg failed its `global-setup` three times first, twice under heavy load and once at load 7, always the same way: the Vite dev server's `/api` proxy answers 500 with `AggregateError [ETIMEDOUT]` reaching an express leg that has already logged `server running`. **It is a cold-start race, not a code failure** — `webServer.url` only proves the port answers, and `global-setup` PATCHes `/api/config` through the proxy immediately afterwards. Worth a follow-up (probe the API leg directly, or retry the PATCH) because it will flake in CI the same way.

### Session 7 - 2026-08-18 (P4 review fixes, DOR-1331)

**Worktree:** `~/.dork/workspaces/dorkos/DOR-1331` · branch `DOR-1331` (merged `origin/DOR-1330` again first — it carried `main` plus P1/P2's squashes and a CI gate fix)
**Workers:** `p4-fixer` (P4 review fixes, DOR-1331)

Two independent reviews (spec compliance, then adversarial) found two must-fixes and a long tail. Everything below is fixed; the decisions the reviews asked for are recorded here rather than deferred.

- **The sticky action rail was inert under virtualization, and the fix the phase claimed was not the fix.** Task 4.9 collapsed the per-row transforms into one box, which was right and necessary — but the box still moved by `transform: translateY(...)`, and a transform on an ancestor is the reference `position: sticky` clamps against. Measured in Chromium on a 1528px message: the capsule sat 125px BELOW the scrollport; the identical offset written as `top` put it at +4px, which is what `sticky top-1` asks for. The window wrapper is `position: absolute; top: <start>px` now.
  - **The pin could not see it, and that is the more important half.** `room-entry-actions.spec.ts` posted ONE message, so the drawn window's offset was 0 — the only value at which `transform` and `top` behave the same. It posts thirty filler entries first and asserts the offset really is non-zero, which is what makes the assertion able to fail.

- **The channel composer had inherited two session-only keyboard rungs.** `ComposerHost` handed `Composer.Input` its `isUploading` and `onCancelUpload` whenever an attachment port existed — which for a room is always. Two consequences a person hits: Enter mid-upload went silently nowhere (`use-input-keyboard.ts:391`), and Escape — which in a channel only ever closed the `@` picker — aborted the upload, which rejected the send and (with the old restore rule) took the typed words with it. `ConversationAttachmentPort.holdsSendWhileUploading` is the fact the field is now told from: true on a session, whose send rewrites the message with the saved PATHS and therefore cannot go out until the files land; false on a room, which awaits its own upload inside `send`. Four new cases in `ComposerHost.test.tsx`; removing the gate turns two red.
  - **A refused send now always gives the words back.** The old rule restored the draft only into an empty box, so somebody who kept typing while the send failed lost the first sentence outright with nothing on screen to say so. It goes back above whatever was typed since — DOR-783's lesson was that a refusal must not OVERWRITE a sentence in progress, and this does not. One new case in `ChannelComposer.test.tsx`; the old rule turns it red.

- **The conversation's target held no still, and the transcript paid for it every token.** `useRoomAttachments` returns a fresh literal every render and each `useMutation` mints a fresh result object, so both adapters rebuilt their whole port on every render — and the target IS the context value `Conversation.Root` publishes, so every row re-rendered on every render of its host. What each adapter reads at CALL time comes off a ref now, and the memos depend only on facts that change. `session-target.test.ts` and `room-target.test.tsx` pin it in BOTH directions, because a memo that never changed would pass the first half alone.

- **Decision (review question 1): the lane's `stalled` rung goes dark on a session, and the status chip stays.** A dropped connection was announced twice — the lane's sentence and, six pixels below, `ChatStatusSection`'s "Live updates lost". `contributing/design-system.md` ("two voices for one fact") already settles the shape, and the chip is the app-wide severity-ranked home for connection health (`status-labels.ts` ranks it at 100) while the lane's sentence is a room's vocabulary: a session has a turn, not new messages that stopped coming through. `ConversationCapabilities.streamHealth` is the gate — true for a room, false for a session and for onboarding — and `useSessionLaneState` no longer takes a `connection` at all. This closes Known Issue 24 and reverses the direction P2's Known Issue 13 was closed in; the reasoning is in `capabilities.ts` and `use-session-lane-state.ts`.

- **Decision (review question 2): the `queued` rung is deleted, not reordered.** It sat below every `turn-*` rung while a queue only ever exists BECAUSE a turn is running, so neither shipped surface could reach it — a session's turn always won, and `RoomLiveLane` passes `queueDepth: 0` by construction. Reordering it above the turn would be worse: hiding what the agent is doing in order to report a number. Held drafts live in the composer's queue panel, which is where they stay. `LaneState`'s `queued` member, `LaneStateInput.queueDepth`, `SessionLaneInput.queueDepth`, `ConversationTarget.queueDepth` (its only consumer) and the playground's showcase all go with it. `use-session-lane-state.test.ts` asserted the unreachable state; it now asserts the honest one. Closes Known Issue 25.

- **Decision: `capabilities.toolCards` is deleted; `capabilities.mentions` is read.** `toolCards` had no reader and no place a gate could discriminate — which body a row draws is settled by `renderSessionBody` vs `renderRoomBody`, and that IS §2.6's gate. `mentions` earned its keep instead: the `@` picker rides its own `mentionPicker` slot on the composer card, drawn only where the capability says so, the same shape the paperclip has with `attachments`. Two new cases. Closes Known Issue 22.

- **Task 4.9's own 500-line gate is met where the phase crossed it.** `Timeline.tsx` 684 → 481, by taking out the four things that are not about drawing a list: `model/use-timeline-virtualizer.ts` (the measurement contract), `model/use-timeline-landing.ts` (where a conversation opens, plus the top-row report), `model/use-feed-edge-focus.ts` (the feed's edge hand-back) and `ui/TimelineAffordances.tsx` (the pill and the jump button); the row-renderer types moved next to the row they render. `RoomThreadPanel.tsx` 527 → 490, by way of `ui/ThreadNotice.tsx`. `ChatPanel.tsx` (571), `ChannelComposer.tsx` (527) and `SessionComposer.tsx` (503) are still over — see Known Issue 27.

- **The landing has unit pins now.** The adversarial review's revert-the-fix run found that ignoring `resumeRow` — the whole phone thread-return fix — turned **0 of 77** tests red. Three cases in `Timeline.test.tsx` read `data-landed-on` for `end`, `remembered` and `end-row-gone`; the same revert turns two of them red.

- **The mock browser leg's cold start is fixed, not logged.** `global-setup`'s first `GET /api/config` is a bounded retry (30s, 500ms apart) rather than a single shot: `webServer.url` proves the Vite port answers, not that the express leg behind its proxy can serve, and the failure took the whole run with it because it is global setup. Closes Known Issue 26.

- **The tail, each verified rather than assumed.** `ScrollThumb`'s track started 48px down on every surface — inherited from the session's own `pt-12`, which a room does not have, so a room's thumb read ~8% low across its range; the offset is a `--conversation-thumb-top` variable the host sets. The "New messages" pill carried `role="status"` on the button itself, which replaces the button role — the announcement rides an `sr-only` sibling now. A room that has not loaded said "You left this channel"; it says it is still opening. The card no longer passes the field's unrelated refusal line while a failed attachment is the actual refusal. `RoomSurface` clears its resume memory in a LAYOUT effect, because the landing is one too and a passive clear ran after it (which is why a room switch reported `end-row-gone`). `loading` renders on `!= null`. `data-slot` on the timeline, its scroller, the pending row and both affordances. TSDoc drift: a hook pointing at a file that never existed, a contradiction about putting a reader back, "message 12 of 30" promised on a surface that does not number its rows (moved to `use-feed-edge-focus`, which is what depends on it), and the half-replaced block in the session lane. `meta/chat-capabilities.md` names tests that exist; ADR 260808-180001 carries a dated note for the two composers it named. `room-conversation.spec.ts` names the count the scroller was sized for instead of "the height grew". `ConversationRowContext` is off the barrel.
  - **Checked and found already correct:** the channel's textarea sets `aria-controls` and `aria-activedescendant` whenever its picker is open (`ChannelComposer.tsx` passes `isPaletteOpen` / `paletteListboxId`), so `aria-expanded="false"` with no `aria-controls` is the closed state, which is valid ARIA 1.2. Nothing changed.
  - **`Conversation.Composer` stamps no `data-slot`, and that is why:** it renders no element of its own. `Composer.Root` is the element, and it already carries `data-composer-card`, which is the hook both shipped browser suites resolve by. Threading a second attribute through `features/composer`'s public props for a test hook that exists would be API churn.

### Session 8 - 2026-08-18 (P5, DOR-1332)

**Worktree:** `~/.dork/workspaces/dorkos/DOR-1332` · branch `DOR-1332` (based on `DOR-1331`, PR #1102, still open at review as this phase ran)
**Workers:** `p5-builder` on the **fast tier (sonnet)**, then `p5-fixer` on **opus** for the review fixes. A deliberate deviation from the orchestration model recorded under Session 1 (implementation = opus), forced rather than chosen: the opus workhorse was killed by API 529s four times before committing anything, so the phase was built on sonnet and the two reviews' findings were fixed by an opus worker afterwards. The builder inventoried the worktree first (empty, confirmed) rather than trusting a stale progress file. Two of the four blocking review findings — an inert composer and a picker under the wrong label — are the kind a fast-tier builder ships and a browser pass catches, which is the argument for keeping the browser pass a gate rather than a formality.

- Task #5.1: Rename the playground page — worker: p5-builder
  - Seven touch points, all confirmed against the tree rather than assumed from the task brief: the `Page` union member, the named re-export + aliased import spread in `playground-registry.ts`, the `PageConfig` in `playground-config.ts` (`label: 'Conversation'`, `group` stays `session`), the `PAGE_COMPONENTS` key in `playground-pages.ts`, `chat-sections.ts` → `conversation-sections.ts` (51 entries, `page: 'chat'` → `'conversation'`), `ChatPage.tsx` → `ConversationPage.tsx`, and the hardcoded union in `playground-registry.test.ts`. Also repointed the one e2e spec that navigated to `/dev/chat` (`status-line-fit.spec.ts`) and two test assertions that named the old label (`PlaygroundSearch.test.tsx`, `ChipShowcases.test.tsx`).
  - Fixed the skill's stale line: `.claude/skills/maintaining-dev-playground/SKILL.md:233` named `dev/DevPlayground.tsx` for `PAGE_COMPONENTS`, which moved to `dev/playground-pages.ts` in DOR-1117. Corrected the numbered step and the Files-to-Know table row. No `.agents/skills/` mirror exists for this skill, so nothing else to sync.
  - `getPageFromPath()` needed no edit — it matches `path` generically, exactly as the spec said.

- Tasks #5.2–#5.4: The five sections — worker: p5-builder
  - **Surfaces (new):** `dev/showcases/SurfacesShowcases.tsx`. Session, room and DM side by side from **one** fixture (four turns of a conversation), each column a genuine `Conversation.Root` holding a genuine `Timeline`, `LiveLane` and `Composer` — never a recreation of any of the four. The DM column reads `ROOM_CAPABILITIES` with `surface="dm"`, exactly what P4's Known Issue 3 recommended once `DM_CAPABILITIES` was dropped as a duplicate export.
  - **Message row:** verified, not rewritten. `MessageRowShowcases.tsx` already carried the full anchor × role × density × capability matrix from task 1.7, benched against the real `Message.*` parts. `threads` and `tool cards` are deliberately absent from the row-level capability toggle — the file's own doc comment already explains why (threads shows as the reply line, benched on Rooms; there is no `toolCards` flag, per P4's Known Issue 22 closure) — so "checked for completeness" meant confirming that absence is documented, not adding toggles that would misrepresent the API.
  - **Timeline (new):** `dev/showcases/TimelineShowcases.tsx`. There was no Timeline showcase before this phase — the compound shipped in P4 with no bench of its own. Loading (the real `Feed` + `TypingDots`), empty (the real `ChatEmptyState`), grouped history with day/unread dividers, thread grouping (the real `ThreadReplyRow`), the pending list (a real `PendingPost[]` through the real `RoomMessage`), and a 400-row virtualized run.
  - **Composer:** `InputShowcases.tsx` deleted; `dev/showcases/ComposerShowcases.tsx` rewrites it against the real `Conversation.Composer` and two fixture `ConversationTarget` adapters (`buildSessionTarget`/`buildRoomTarget`, exported so Surfaces could reuse them) — idle, typing, attachments, mentions, queue depth (labelled: a room target has no `queue` method, so it draws no queue chrome at all), an Ask takeover through the `asks` slot, and the archived/`canSend: false` refusal. `CommandPalette` and `QuestionPrompt` stayed their own sections in the same file rather than folding into the one "Composer" section, since neither is part of the target/adapter matrix the spec's "Shows" column names.
  - **Asks:** `AskShowcases.tsx` → `AsksShowcases.tsx`, consolidating what were five separate registry entries (the card's three kinds, its countdown, a burst, five receipt endings, the tray) into **one** "Asks" section, plus the inline `ApprovalPrompt` (moved out of `ToolShowcases.tsx`, which drew it as a tool-call-adjacent section but it is an Ask surface) and the transcript `AskReceipt` (`AskReceiptShowcases.tsx` deleted, folded in). The capability-approval `ApprovalCard` — a different question (may this agent do X at all, not answer this one interaction) — was extracted into its own exported `ApprovalCardShowcase`, stays registered on Subsystems (`features` page, id `approvalcard`), and is cross-listed onto Conversation by rendering, via a new `CONVERSATION_CROSS_LISTED` array in `playground-config.ts` that mirrors `IDENTITY_CROSS_LISTED`'s established pattern — never re-registered.
  - **Identity page loses its borrowed presence content:** removed `'live-lane'` from `IDENTITY_CROSS_LISTED` (and its render call, and the `CROSS_LISTED_RENDERERS` test map entry) — the identity page's task-2.7-era borrow of the lane as a presence-only bench is redundant now that Conversation's own Live lane section is the one comprehensive bench for every `LaneState`.
  - **Deliberately not moved:** `StatusLineShowcases`, `TrustDialShowcases`, `SessionInspectorShowcases`, `ChipShowcases`, `MiscShowcases` stay their own sections, per the spec's own table (`StatusLineShowcases` is `ChatStatusSection`'s line, not the lane — §1.1). `RoomsShowcases.tsx` and `RoomDeliveryShowcases.tsx` stay on Rooms. `LiveLaneShowcases.tsx` (`LiveLaneShowcase`, `LivePeekShowcase`) already carried every `LaneState` from tasks 2.7/3.11 — presence at 1/2/3/4+, `working_late`, `stalled`, every `turn-*` state, the Ask (single and stacked), reduced motion, and the peek. **P5's review found the one thing spec §6.1 asks for that it did not have: the receipt set**, so the section now benches the three endings the lane's own grown card settles into (answered here, answered in another window, answered by the clock) through the real `AskReceiptLine` inside a real resolved `AskCard.Root` — the exact pair `InteractionAsk` renders once a receipt exists. The transcript's separate one-line `AskReceipt` stays benched on Asks, beside the prompts it records.
  - **Scope trims, stated rather than hidden:** the standalone `FilePalette` section was retired (the same real component now renders inside Composer's mentions demo, a more realistic context); the `QuestionPrompt` multi-select and arrow-key-interactive sub-demos were dropped to control scope; `RoomThreadShowcases.tsx`'s "row-rendering demos" retirement named by the task brief was investigated and not found — the file holds `ThreadReplyRow`, `RoomThreadPanel` and arrival-animation sections, none of which duplicate what Surfaces now shows, so nothing was removed there.
  - `showcase-no-replicas.test.ts` was updated for the file rename (its "composer disposition" describe block now reads `ComposerShowcases.tsx` and asserts `<Conversation.Composer` / `<QueuePanel` inside `ComposerDemo`, carrying forward the same DOR-1186 guarantee against a hand-rolled `<textarea>` replica).

- Task #5.5: Docs — worker: p5-builder
  - `contributing/design-system.md`: new **Live lane** subsection under Components — the reserved `h-6` height (never `min-h`), the nine-rung priority stack as the one status vocabulary (with the three ordering decisions that may not be collapsed), the announcer rule (one live region, counts not verbs; Asks announced separately through the approval announcer, echoing the same principle §Zones already states for the Heads up badge), and the lane crossfade added to the Animation Catalog. No `RoomPresenceLine` prose existed anywhere in `contributing/` or `docs/` to amend — grepped and confirmed empty, so that sub-instruction was moot.
  - `contributing/architecture.md`: new **Namespace compounds (Composer, Conversation)** section — neither compound had prior documentation there (grepped and confirmed), so this is the first write-up of the pattern, not an amendment. States the capability-flag rule once and points at the spec.
  - `contributing/state-management.md`: `interaction_pending` / `interaction_resolved` added to the `KnownEvent` list, verified present in `GENERIC_EVENTS` (`stream-manager.ts`) before documenting them.
  - `contributing/keyboard-shortcuts.md`: `Cmd+Shift+Y` was already documented in full; added the `A`/`D` focused-card allow/deny keys, which were not (verified against `AskCard.tsx`'s own `onKeyDown` before writing it up).
  - `docs/concepts/answering-agents.mdx` (new): "Answer your agents from anywhere" for a non-developer, per `writing-for-humans` — what an Ask is, the four places it shows up, answering with a click or the keyboard, the ten-minute window, and who can answer for a shared room. An honesty callout states plainly that nothing reaches you while the cockpit is closed and there is no scope-widening control yet. Registered in `docs/concepts/meta.json` and both `contributing/INDEX.md` tables; `docs-coverage-map.json` regenerated to match. **The regeneration picked up a second entry, `docs/concepts/sidebar.mdx`** — not this phase's page, but a row that had been in `contributing/INDEX.md` since 2026-08-11 while the generated JSON lagged behind it. It is a correction of pre-existing drift rather than scope creep, and dropping it would fail `docs-coverage-map.mjs --check`, so it stays.
  - `docs/concepts/rooms.mdx`: "a line under the message box" corrected to "above," and the click-to-open-the-peek behaviour added.
  - `pnpm docs:export-api` produced no diff — the two routes and three schemas the task names were already exported in P2/P3. `pnpm --filter @dorkos/site build` prerendered the new page cleanly.
  - The three draft ADRs were confirmed against the shipped tree and moved to `accepted`: `260818-002803` (fleet-wide Asks — confirmed, with its own known gaps named rather than hidden), `260818-002805` (the Conversation compound — confirmed exactly as decided), `260818-002806` (the reserved live lane — confirmed, but its Decision prose still says "ten states" and names a queue rung; P4's session 7 deleted the `queued` rung outright rather than reordering it, so the shipped stack is **nine**. Left uncorrected in the Decision section itself — an ADR records the reasoning at the time, not a living spec — with a note added to the Status section pointing at the accurate count in `design-system.md` and `lane-state.ts`). `node .claude/scripts/adr-drift-check.mjs` clean afterward.

- Task #5.6: This record, and the manifest — worker: p5-builder
  - Progress → Complete, 48/48. PR numbers named per phase. This section.
  - `specs/unified-conversation/manifest.json` promoted to `implemented` via `.claude/scripts/spec-manifest-ops.ts`.

- Task #5.7: The changelog fragment — worker: p5-builder
  - This phase is a Dev Playground restructure plus docs; per `writing-changelogs`' audience test, none of it is something an operator notices except the new docs page. One fragment, `changelog/unreleased/260818-191049-answer-your-agents-from-anywhere-guide.md`, `covers:` naming every P5 commit subject so `changelog_backfill.py --check` accounts for the phase without inventing prose for a playground rename. Two hook-auto-generated fragments from the 5.1 and 5.2–5.4 commits were deleted first (session note: neither was user-facing), as were the six the review-fix commits generated.

- Task #5.8: Phase 5 acceptance — worker: p5-builder
  - **The builder's own ladder:** `pnpm --filter @dorkos/client typecheck` clean, `lint` 0 errors / 119 warnings (P1's baseline, unchanged), `pnpm format:check` clean, `pnpm vitest run apps/client/src/dev` green (139 tests, all drift gates). Neither `pnpm knip` nor `pnpm verify` was run, though task 5.8 asks for both; both were run at the review-fix session below.
  - **The builder's browser pass claimed more than the tree did.** Its "Live lane shows every state including the Ask stack and receipts" was not true: the section had no receipt bench at all, which is the first thing the spec-compliance review found. Recorded here rather than quietly repaired, because a browser-pass claim that survives into a closing record is worse than a missing one — the next reader believes it.

### Session 9 - 2026-08-18 (P5 review fixes, DOR-1332)

**Workers:** `p5-fixer` on opus (the builder could not be resumed)

Two independent reviews — spec compliance, then adversarial per `REVIEW.md` — found five blocking items and six nits. All fixed, one commit per item group. The five blocking ones, because each is a shape worth recognising:

- **Every Asks countdown read `expired`.** `NOW` was a date written out in the source, and the card's deadline is `startedAt + timeoutMs`, so all eight cards were past their deadline before the page opened — the three colour bands the section exists to show were unreachable, while Allow and Deny stayed live beside the word. Now read once at module load. The same constant was in `LiveLaneShowcases.tsx`, so the lane's grown card had it too; both fixed.
- **The Live lane had no receipts** while spec §6.1, task 5.4 and this record all said it did. Three endings benched now, through the real `AskReceiptLine` inside a real resolved `AskCard.Root`.
- **The "Mentions" demo drew `FilePalette`.** A real component under a label promising a different one — the no-replicas failure one step sideways, invisible to a render test. `MentionPalette` now, with a source assertion beside the `QueuePanel` one (seeded defect run: swapping it back is red). `FilePalette` kept a bench in the place it actually ships, the `overlays` slot of a session composer.
- **All three Surfaces composers were inert** — controlled fields pinned to `''` with a noop `onChange`, in the section whose own copy promises "never a recreation". Each column holds its own draft now. The one-fixture claim was also half true: the two row builders each fell back to their own default timestamp, so the session column printed an afternoon and the room and DM columns a morning. Each turn carries its own time now.
- **`answering-agents.mdx` promised two things this tree does not do** — a per-agent approver list, and a receipt naming who else answered (`resolvedBy` is never populated). Both cut to what ships.
  Nits: the `/dev/chat` → `/dev/conversation` alias (a saved link landed silently on Overview); the `Message.* matrix` section renamed to the spec's **Message row**; the cross-listed approval card hoisted from inside the Asks section to page level; `initialValue` so the two "Typing" demos are not pixel-identical to the two "Idle" ones; `specs/manifest.json` restored to a one-line diff after the manifest-ops writer re-serialized 103 unrelated entries; ADR `260818-002806`'s Status stopped saying the stale count was left uncorrected while correcting it; plus four stale prose references.

  **Verification:** `pnpm format:check` exit 0 · `pnpm --filter @dorkos/client typecheck` clean · `lint` 0 errors / 119 warnings (the bar, unchanged) · `pnpm vitest run apps/client/src/dev` green (141 tests, +2 for the new drift gates) · `pnpm verify` exit 0 · `adr-drift-check.mjs` clean · **knip: unused exports 554, unused exported types 579, duplicates 2** (P4: 552 / 580 / 2 — two more exports and one fewer type, all of them the fixture builders and the new demo components this phase's showcases needed).

  `pnpm verify` failed once on the way there, and it is worth naming so nobody chases it: `apps/server/src/routes/__tests__/read-cursors.test.ts` timed out at 5 s under load while a dev server and a browser were running beside it. That file passes in isolation (23/23) and this branch does not touch `apps/server`. The clean re-run is the exit 0 above. `pnpm verify --concurrency=1` is **not** the fallback it looks like — the flag reaches the test command rather than turbo, and `@dorkos/e2e`'s vitest rejects it outright.

  **Browser pass, cockpit from this worktree (client `:4542`, server `:4392`, `DORK_HOME=~/.dork-verify-p5b`), driving the real page and reading the DOM back:**
  - **The three Surfaces composers accept typing.** Thirteen characters into each of the three `textarea`s, read back: `["typed in column 0", "typed in column 1", "typed in column 2"]`. The three columns now print one clock (`09:02 AM` / `09:03 AM` / `09:04 AM`, the four turns' own times) instead of an afternoon in one column and a morning in the other two.
  - **The Asks countdowns reach all three bands.** Thirteen live cards, none reading `expired`; the class on the reading is what proves the band rather than the colour being described: `text-muted-foreground` at 6/8/9 min, `text-status-warning` at 1 min, `text-status-error` at 39 s.
  - **The Mentions demo draws the mention picker.** `[role="listbox"][aria-label="Mentions"]` reads `People · Ana Ruiz @ana · Aurora Vance @aurora · Agents · 🔍 Audit Bot @audit-bot · 📓 August No @name`. No file paths.
  - **The Live lane shows its receipts:** `You allowed this`, `Already answered at 3:24 PM`, `Nobody answered in time`.
  - **`/dev/chat` lands on Conversation** — `h1` reads "Conversation" with the URL left as the reader typed it.
  - Console: four `ERR_FILE_NOT_FOUND` from the attachment fixtures' `blob:` URLs, pre-existing and not this phase's.
  - Screenshots in the session scratchpad: `p5fix-01-surfaces-typed.png`, `p5fix-02-asks-countdown.png`, `p5fix-03-composer-mentions.png`, `p5fix-04-lane-receipts.png`, `p5fix-05-dev-chat-alias.png`. Servers stopped afterwards; 4542 and 4392 answer nothing, `pgrep -f DOR-1332` empty, `~/.dork-verify-p5b` removed.

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

### P3 (DOR-1330) — 138 files against `DOR-1329`

**The wire (2 files):** `packages/shared/src/interaction-events.ts` (new), `packages/shared/package.json` (the subpath), `packages/shared/src/transport.ts` (`listPendingInteractions`)

**Server (8 files):** `services/session/session-state-projector.ts` (the seam, three fire points, the fleet list), `services/session/session-list-broadcaster.ts` (the subscription, the port, the broadcast), `services/session/index.ts`, `services/rooms/room-session-ledger.ts` (`bindingForSession`), `routes/sessions.ts` (the list route + the guard on six routes), `services/core/openapi-registry.ts`, `index.ts` (the wiring), `services/runtimes/test-mode/interactive-scenarios.ts` (a comment naming the card that replaced the bar)

**Server tests (4 files):** `routes/__tests__/sessions-pending-interactions.test.ts` (new), `services/session/__tests__/session-list-broadcaster-asks.test.ts` (new), `services/rooms/__tests__/room-session-ledger.test.ts` (new), `services/session/__tests__/session-state-projector.test.ts` (extended)

**The new slice — `layers/features/ask/` (new, 17 files):** `ui/AskCard.tsx`, `ui/InteractionAsk.tsx`, `ui/AskStack.tsx`, `ui/AskList.tsx`, `ui/AskReceiptLine.tsx` (new); `ui/ApprovalPrompt.tsx`, `ui/QuestionPrompt.tsx`, `ui/ElicitationPrompt.tsx`, `ui/AskReceipt.tsx`, `ui/AskReceiptRow.tsx`, `ui/QuestionAnswerSummary.tsx` (moved from `features/chat/ui/tools/`); `model/use-answer-ask.ts`, `model/use-ask-shortcut.ts`, `model/ask-tray-store.ts` (new), `model/ask-exit-transition.ts` + `lib/format-time-left.ts` (moved from `features/approvals/lib/`), `lib/ask-headline.ts`, `lib/group-asks.ts` (new), `index.ts`; `__tests__/` — `AskCard.test.tsx`, `ask-headline.test.ts`, `use-answer-ask.test.tsx` (new) and four moved suites

**The attention entity (5 files):** `model/use-pending-interactions.ts`, `model/ask-receipt-store.ts`, `model/describe-interaction.ts` (new), `model/derive-attention-signals.ts` + `model/use-attention-signals.ts` (the degradation gone), `index.ts`; `__tests__/use-pending-interactions.test.tsx` (new), `__tests__/derive-attention-signals.test.ts` (extended)

**Deleted:** `features/chat/ui/tools/BatchApprovalBar.tsx`, `features/chat/ui/primitives/InteractiveCard.tsx` (+ its test)

**Moved down to `shared/` (5 files):** `ui/option-row.tsx`, `ui/compact-result-row.tsx`, `ui/truncated-output.tsx`, `lib/decision-refusal.ts` (+ its test), and the two barrels

**The surfaces (8 files):** `widgets/approvals-indicator/ui/ApprovalsIndicator.tsx`, `widgets/home/ui/PinnedTriageHeader.tsx` + `PinnedTriageHeaderView.tsx`, `widgets/room-view/ui/RoomLiveLane.tsx`, `features/chat/ui/ChatPanel.tsx`, `features/chat/model/use-session-lane-state.ts`, `features/conversation/model/lane-state.ts`, `features/conversation/ui/{LiveLane,LaneContent}.tsx`

**Client plumbing (6 files):** `shared/lib/transport/stream-manager.ts` (both allowlist entries + the stale docstring), `shared/lib/transport/session-methods.ts`, `shared/lib/direct/{services,session-methods}.ts`, `shared/lib/shortcuts.ts`, `apps/obsidian-plugin/src/views/CopilotView.tsx`

**Dev Playground (4 files):** `showcases/AskShowcases.tsx` (new), `showcases/AskReceiptShowcases.tsx` (renamed), `showcases/{ChatPrimitives,Tool,Input}Showcases.tsx`, `pages/ChatPage.tsx`, `sections/{chat,components}-sections.ts`

**Browser (3 files):** `apps/e2e/tests/conversation/ask-anywhere.ts` (new), `tests/chat-mock.spec.ts`, `tests/chat/interactive-prompts.ts` + `tests/dashboard-sidebar/now-survives-reload.ts` (two assertions follow the behaviour)

**Docs + artifacts:** `contributing/keyboard-shortcuts.md`, `contributing/interactive-tools.md`, `changelog/unreleased/260818-083627-answer-your-agents-from-anywhere.md`, this file

### P4 (DOR-1331)

Not written up by session 6/7 — a gap in this record rather than in the work; the files are enumerated in PR `#1102`'s own diff.

### P5 (DOR-1332)

**Dev Playground — `apps/client/src/dev/` (new: 4 files):** `showcases/SurfacesShowcases.tsx`, `showcases/TimelineShowcases.tsx`, `showcases/ComposerShowcases.tsx` (replaces `InputShowcases.tsx`), `showcases/AsksShowcases.tsx` (renamed from `AskShowcases.tsx`, absorbing `AskReceiptShowcases.tsx` and the approval half of `ToolShowcases.tsx`)

**Deleted:** `showcases/InputShowcases.tsx`, `showcases/AskReceiptShowcases.tsx`

**Modified:** `playground-registry.ts` (`Page` union, exports), `playground-config.ts` (the `conversation` `PageConfig`, `CONVERSATION_CROSS_LISTED`), `playground-pages.ts`, `sections/chat-sections.ts` → `sections/conversation-sections.ts` (renamed + restructured), `pages/ChatPage.tsx` → `pages/ConversationPage.tsx` (renamed), `pages/IdentityPage.tsx` (drops the borrowed `live-lane` section), `showcases/ApprovalsShowcases.tsx` (extracts `ApprovalCardShowcase`), `showcases/ToolShowcases.tsx` (drops the approval section, moved to Asks)

**Tests:** `__tests__/playground-registry.test.ts`, `__tests__/PlaygroundSearch.test.tsx`, `__tests__/ChipShowcases.test.tsx`, `__tests__/showcase-no-replicas.test.ts`

**Browser:** `apps/e2e/tests/chat/status-line-fit.spec.ts` (repointed at `/dev/conversation`)

**Docs:** `contributing/design-system.md`, `contributing/architecture.md`, `contributing/state-management.md`, `contributing/keyboard-shortcuts.md`, `contributing/INDEX.md`, `docs/concepts/answering-agents.mdx` (new), `docs/concepts/meta.json`, `docs/concepts/rooms.mdx`, `.claude/scripts/docs-coverage-map.json` (regenerated)

**Skill:** `.claude/skills/maintaining-dev-playground/SKILL.md`

**ADRs:** `decisions/260818-002803-interaction-prompts-are-fleet-wide-asks.md`, `decisions/260818-002805-one-conversation-compound-with-capability-flags.md`, `decisions/260818-002806-a-reserved-live-lane-above-every-composer.md` (all `draft` → `accepted`), `decisions/manifest.json`

**Artifacts:** `changelog/unreleased/260818-191049-answer-your-agents-from-anywhere-guide.md`, `specs/unified-conversation/manifest.json` (`implemented`), this file

## Known Issues

Six things this phase decided rather than finished. Each names who picks it up.

1. **`SESSION_CAPABILITIES` and `render-session-body.tsx` are in the wrong layer, deliberately — P4's to move.** The spec puts both in `widgets/session/`; ESLint refused it (`no-restricted-imports`, four test files), because `ChatPanel`, `MessageList`, the row and their tests are all in `features/chat` and a feature may not import a widget's model. They sit at `features/chat/config/session-capabilities.ts` and `features/chat/ui/render-session-body.tsx` until P4's composer host lands in `widgets/session`, at which point both move up with it. `config/` rather than `model/` only because the `dir-size` hook errors at 25 files in `features/chat/model`. Both files say this in their own TSDoc, and so does `widgets/room-view/model/room-capabilities.ts`.
2. **`capabilities.toolCards` is declared by both hosts and read by nothing — P4 owns proving it.** Each host's body renderer is fixed in P1, so there is no branch for the flag to switch and no check that can go red on it today. Inventing one would be a check that cannot discriminate. P4's renderer map is where it goes live, and P4 is where the first honest test of it can be written.
3. ~~**`DM_CAPABILITIES` does not exist, and P5 task 5.1 names it.**~~ **CLOSED (P5, session 8): the Surfaces section's DM column renders `ROOM_CAPABILITIES` with `surface="dm"`**, exactly as this issue recommended. `room-capabilities.ts` is untouched — DMs have not diverged from channels.
4. **Run-with is a bar SLOT, and is absent from the right-click menu and the long-press drawer.** It is reachable on hover and by keyboard only, which is what it was before this phase — `EntryActionMenu` has nowhere to put a menu that opens a second menu, and its own TSDoc says so. **P4 must not assume the menu path carries it.** Its trigger keeps its own tab stop for exactly this reason: a capsule holding only run-with is still reachable by every reader.
5. **The `showTimestamps` preference now governs channels, which it silently ignored before.** A behaviour unified rather than preserved twice — the same preference, one gutter. It defaults to `false`, so nothing changes for a reader who has not turned it on, and the changelog fragment says so. Flagged here because it is the one place P1 changed what a person sees rather than only how it is drawn.
6. ~~**The Dev Playground row matrix lives on `/dev/chat`, not on a page of its own.**~~ **CLOSED (P5, session 8): the page is `/dev/conversation` now, restructured into five sections** (Surfaces, Message row, Timeline, Live lane, Composer, plus Asks as the card-family section). `NoticeRow`, `MomentRow` and `ThreadReplyRow` stayed benched on `/dev/rooms` as this issue anticipated.

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
14. **`GET /api/rooms/:id/sessions` now checks visibility before the person gate**, which is the order §5.3.3 writes and the OPPOSITE of `POST /:id/attachments` (that one refuses an agent before multer reads a byte, which is a different concern). The reason is in the route's own TSDoc: with the person gate first, an outsider learned 403 (this room exists) where a person learned 404, which is a difference in answers where there should be none. **The unresolved-header divergence in item 9 above still stands**; P3 decided it — see item 19.

### P3 (DOR-1330)

Ten things this phase decided rather than finished. Numbered from 15 because P2
owns 12–14 above.

15. **`⌘⇧Y`, not `⌘⇧A`, and the spec says `⌘⇧A`.** `SHORTCUTS.AGENT_PROFILE` has
    owned that chord since the profile panel shipped. Sharing it by condition —
    Answer while something waits, Profile otherwise — was built and then
    rejected in review: the `?` panel would list one combo with two labels, the
    Profile became unreachable by keyboard exactly while an agent was parked,
    and a reader learned which meaning they got by watching the screen. `Y` is
    free in the registry and unbound in Chrome, Firefox and Safari, the listener
    installs unconditionally, and the shortcuts gate PROVES it with a real
    keystroke rather than declaring it.
16. **The lane's Ask grows into a POPOVER, where §5.5 writes "height + opacity,
    300 ms, no detached menu".** Deliberate, and the reason is the promise one
    section earlier: the lane is exactly 24 px so that nothing it ever shows can
    move the conversation, and a card that grew inside it would break that on
    every prompt. It reuses the peek's own `ResponsivePopover`, so the two
    things the lane can open behave identically, become a bottom sheet on a
    phone through one implementation, and close on Escape with the caret handed
    back. **What is lost is the growth gesture**, which the design record asks
    for by name; if a future phase wants it, the honest shape is an overlay
    anchored to the lane that animates height from 24 px, not a lane that grows.
17. **The session surface does not draw the lane's Ask rung.** It already shows
    every prompt twice — the live card in the input zone, where a person answers
    it, and the receipt row in the transcript where it was asked — and a third
    line six pixels above the first was noise that also pushed the elapsed and
    token reading this lane exists for. `ChatPanel` passes `NO_ASKS`. The rung is
    live on the room lane, which has no inline card, and the header tray covers
    this session from every other route. **P4 owns revisiting it** when the
    composer host lands and the input zone's card may move.
18. **The header tray and home triage now join the roster; the SIDEBAR row still
    does not.** `useAskAgentNames` gives both trays the agent's real name and
    "Open session". `derive-attention-signals` names the agent from the session
    list it already reads, which is a different join and was already correct.
19. **`GET /api/rooms/:id/sessions` and the answer routes disagree about an
    unresolved agent header, and the divergence is now decided rather than
    noted.** P2 raised it (issue 9): `resolveCaller` treats a token it cannot
    verify as "no agent presented", so that route answers 200 to
    `curl -H 'X-DorkOS-Agent: garbage'`; `requirePersonToAnswer` refuses it,
    because `readCallerAuthority` reports the RAW header. **P3's rule is the one
    that should win long-term**: a header that did not resolve still means a
    machine is calling, and "may this caller decide something irreversible" is
    not a question to answer leniently. Aligning the room route means changing
    every room route's caller model, which is a rooms-domain decision with its
    own review — filed as the follow-up, not done here. **Closed post-programme
    by DOR-1357 for this one route** (the siblings keep the lenient reading, and
    the reasons are stated) — see Post-programme follow-ups.
20. **The browser suite covers the fleet half of the Ask, not the room half.**
    `ask-anywhere.ts` parks a session, leaves for `/tasks`, answers there and
    watches the agent carry on. A room-bound prompt on a room's lane needs a
    room, an agent bound into it and a turn dispatched by the room runner, none
    of which the mock leg seeds. The filter is unit-tested (`RoomLiveLane` —
    two rooms in, one room named), the join is server-tested
    (`session-list-broadcaster-asks`), and the path was walked against a real
    room for the acceptance check. The manifest row says the same.
21. **"Never steals a keystroke" is browser-verified by hand, not by the mock
    leg.** The session that raises a prompt replaces its composer with it, so
    there is nothing to type into there; the room's composer stays, and rooms
    are not seeded on that leg. The unit suite pins the rule against
    `document.body`, the e2e pins that a focused card genuinely answers, and the
    acceptance check typed into a real room composer with a real prompt live.
22. **`resolvedBy` is never populated.** The broadcaster has no HTTP caller to
    name, so "Already allowed by Dorian at 2:01" is unreachable on a
    single-identity install and every cross-window receipt reads "Already
    answered at 2:01". The schema keeps the field because a bridged approver is
    what it is for; wiring it means carrying the deciding caller from the route
    into the resolution, which belongs with the bridged-approver work.
23. **Nobody checks who may SEE a prompt, and the changelog now says so.** The
    detail rides the per-caller global stream and the list route, both of which
    answer this cockpit's operator — the person who can answer. That is true and
    sufficient on a single-identity install (ADR 260727-184933 D6), and it is
    NOT the same claim as "only eligible approvers see the detail", which is
    what the fragment said before review. A bridged approver's entitlement is
    still `mayApprove`'s, untouched and unwidened. **The follow-up, if DorkOS
    ever has more than one person: the list route and the fan-out both need a
    per-caller filter**, which is a change to `eventFanOut`'s addressing model.
24. **Task 3.9's `collectDurableEvents` case is not written, and the substitute
    is named.** The spec asks for an SSE-integration proof that
    `interaction_pending` reaches the global fan-out before the per-session
    event reaches a late subscriber. `session-list-broadcaster-asks.test.ts`
    makes exactly that claim one layer down — it asserts, inside the broadcast
    itself, that the session's own replay buffer does not yet hold the event —
    which is the same ordering without standing up two live streams. The
    projector-level ordering case pins the other half.

### P4 (DOR-1331)

Four things this phase decided rather than finished. Issues 22, 24, 25 and 26 are **closed by session 7** and kept below with their resolutions, because the reasoning is what a later reader needs.

19. **`render-session-body.tsx` did not move, and P4 proved it cannot.** P1's Known Issue 1 asked for both it and `SESSION_CAPABILITIES` to come up to `widgets/session` with the host. The host moved; the table moved; the renderer stayed. The row that calls it (`SessionMessage`) is rendered by `features/onboarding` for its scripted narration, and a feature may not import a widget — so the row is a feature export and its renderer lives beside it. Both files say so. **What would free it** is onboarding composing `Message.*` directly instead of a session row, which is a change to a surface P4 has no business touching.
20. **The prop the timeline takes is `renderRow`, not the spec's `renderBody`.** §2.4 gives the list a `ConversationBodyRenderer`, which would mean the list composed `Message.*` itself — and it cannot, because the two row wrappers hold what only each surface knows. `ConversationBodyRenderer` is untouched and is still the §2.6 seam inside those rows. **If a reviewer prefers the spec's shape**, the change is to move `SessionMessage` and `RoomMessage`'s knowledge into props, which is a bigger merge than this phase's and would undo P1's own seam.
21. **`ConversationTarget` lost its mention port and reshaped its attachment one.** Both were declared in P1 against a model neither surface has: an `upload(file) → id` chip, and a mention picker as a data source. `target.ts` carries the argument in full. **The consequence to watch:** `capabilities.mentions` is now the only fact about the `@` picker in the neutral tree, and the picker itself rides the host's overlay slot.
22. ~~**`capabilities.toolCards` is still read by nothing.**~~ **CLOSED (session 7): the flag is deleted.** P1's Known Issue 2 gave P4's renderer map the job of making it live; the renderer map landed and the flag found no honest consumer, because which body a row draws is already settled by `renderSessionBody` vs `renderRoomBody` — and that IS §2.6's gate. A declaration two capability tables had to keep in step while nothing read it is exactly the check that cannot discriminate. Re-add it when a room gets tool cards.
23. **The virtualizer is stood in for in every client test.** `test-setup.ts` mocks `@tanstack/react-virtual` globally, so every suite draws every row. It is the only way the room and chat suites could keep asserting what they assert (jsdom lays nothing out, so a real virtualizer answers with an empty window), and it is the same shape as the `motion/react` stand-in above it — but it does mean **no unit test can see a virtualization bug**. **The net that does see them, named so the next reader can find it:** the sticky action rail is measured in the browser at `apps/e2e/tests/rooms/room-entry-actions.spec.ts:267-274` (and, since session 7, at a non-zero window offset, which is the only offset where the bug exists), and the reply row's DOM relation is `apps/e2e/pages/RoomsPage.ts:547-551`'s `ancestor::*[@data-index][1]/following-sibling::*[1]` xpath, which breaks the moment rows stop being siblings. Both are the suites that caught the two regressions in the first place.
24. ~~**The session lane now says the same thing as the status line under it.**~~ **CLOSED (session 7): the lane's rung goes dark on a session, and the chip stays.** Gated on the new `ConversationCapabilities.streamHealth`, which a room sets and a session does not. The chip is the app-wide, severity-ranked home for connection health (`status-labels.ts` ranks it at 100) and every other surface already reads it there; the lane's sentence is written in a room's vocabulary, and a session has a turn rather than new messages that stopped coming through. `useSessionLaneState` no longer takes a `connection`. This reverses the direction P2's Known Issue 13 was closed in, deliberately and with the browser evidence that prompted it.
25. ~~**The lane's `queued` rung cannot light on a session.**~~ **CLOSED (session 7): the rung is deleted.** Neither shipped surface could reach it — a session's turn always outranked it, and `RoomLiveLane` passes `queueDepth: 0` by construction — and reordering it above the turn would hide what the agent is doing in order to report a number. Held drafts live in the composer's queue panel. `ConversationTarget.queueDepth`, its only consumer, went with it.
26. ~~**The mock browser leg has a cold-start race in `global-setup`.**~~ **CLOSED (session 7):** the first `GET /api/config` is a bounded retry (30s, 500ms apart) instead of a single shot. A genuinely dead API still fails the run, and says what it last saw.
27. **Three files are still over 500 lines, each for the same reason and none of them a hiding place.** `ChatPanel.tsx` (571) is the session's whole composition root — every hook the surface reads, wired once, with the `Conversation.Root` declaration at the bottom; `ChannelComposer.tsx` (527) and `SessionComposer.tsx` (503) are what is LEFT of the two 536/604-line composers after the card came out, and what is left is each surface's own keyboard, palettes and draft wiring, which is the part the programme deliberately did not merge. Splitting any of the three would mean cutting a wiring block in half rather than lifting a decision out, which is the split that makes a file harder to read. `Timeline.tsx` and `RoomThreadPanel.tsx` had genuine decisions to lift, and both are under the bar. **Revisit when one of them next grows**, not before.
28. **A session's `ConversationTarget.send` and `.queue` are not the session's live path.** A channel presses Enter and lands in `target.send`; a session still funnels through `SessionComposer`'s own `handleSubmit` (which rewrites the message with saved attachment paths and dismisses its palettes on the way) and through `useChatQueue`, so the card reads only the PRESENCE of `queue` off the object. Both functions are real and covered — they are what the session routes through when that funnel moves down — but until it does, one port has two send paths behind it. `session-target.ts` says so at the call site. **Named "P5" here, and P5 did not do it.** P5 (DOR-1332) is the Dev Playground and docs phase — its own task list is explicit that no new product code is written in it. This is real client wiring work and stays open for whatever phase picks it up next; see the follow-up list below.
29. **`render-session-body.tsx` is freed by one change, and it is not this programme's.** (P4) Issue 19 records why it cannot move: `SessionMessage`, the row that calls it, is rendered by `features/onboarding` for its scripted narration, and a feature may not import a widget. **What frees it:** onboarding composing `Message.*` directly (features ← features is legal), after which both the row and its renderer come up to `widgets/session` with the rest of the host. **P5 follow-up**; do not touch onboarding from inside this phase.

### P5 (DOR-1332)

Two things this phase decided rather than finished. Everything else its two reviews found was fixed in session 9 and needs no entry here.

30. **A pinned showcase clock is a trap, and the guard against it is a browser pass.** The Asks and Live lane fixtures both measured their countdowns against a date written out in the source, which the card turns into a deadline permanently in the past — so every card read `expired` and the three colour bands were unreachable. Nothing red: typecheck, lint and 139 unit tests were all green over it, because the defect is what a component _says_ once mounted, and the drift gates read source rather than pixels. Both now read the clock once at module load. **What still has no gate** is the general case: any future fixture that computes a time can make the same mistake, and the only thing that catches it is somebody opening the page. Worth remembering before trusting a green ladder on a showcase change.
31. **`/dev/conversation#message-row` replaces `#message-matrix`, and no alias covers it.** `PATH_ALIASES` in `playground-config.ts` keeps the retired `/dev/chat` **path** working; anchors have no such map, and the section rename (to the spec's own vocabulary, §6.1) moved this one. Only one section is affected and the playground is a dev surface, so the rename won over the anchor. **If anchors start being linked from outside the playground**, they need the same treatment paths just got.

## Implementation Notes

### Session 1

Orchestration model (operator override of the per-task batching in `executing-specs`, logged as an assumption): one named, resumable builder agent per phase in that phase's worktree, executing the phase's tasks in dependency order and committing per task; then a two-stage review (spec compliance, then adversarial code quality per `REVIEW.md`) by separate agents; fixes return to the builder (resume ladder rung 1); the PR opens only after the review converges. Model tiers per `.dork/plugins/flow/config/config.json`: implementation/review = opus, mechanical = sonnet.

---

## What Shipped, By Phase

| Phase         | What it built                                                                                                                                                                                                                                                     | PR                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| P1 (DOR-1328) | The `features/conversation` slice; `Message.*` as the one row family for a session and a room; both hosts wired to it; the two old rows deleted                                                                                                                   | `#1091`                            |
| P2 (DOR-1329) | `deriveLaneState` and `Conversation.LiveLane`; the `GET /api/rooms/:id/sessions` route and `LivePeek`; both surfaces mounted on the lane; `ChatStatusStrip`, `RoomPresenceLine` and `RoomStalledNotice` deleted                                                   | `#1092`                            |
| P3 (DOR-1330) | The interaction-events wire (`interaction_pending`/`interaction_resolved`); the projector's interaction seam; the fleet-wide pending-interactions route and store; `features/ask` (the Ask card family); the Ask live on five surfaces plus the lane's amber rung | `#1093`                            |
| P4 (DOR-1331) | `Conversation.Timeline` (one virtualized list); the two `ConversationTarget` adapters; `Conversation.Composer` + `Conversation.Footer`; `MessageList`, `RoomTimeline` and both old composers deleted                                                              | `#1102` (open at review as P5 ran) |
| P5 (DOR-1332) | The Dev Playground's Conversation page, five sections, restructured from the P1–P4 showcases; the docs the whole programme owed; this record finalized; the manifest promoted to `implemented`; the three draft ADRs confirmed and accepted                       | `#1108`                            |

## What Was Deliberately Not Done

Carried forward verbatim from the spec's own "What is not done" (§ same name), with each item's status as of P5. None of these are P5's to close — they are named here so a cold reader of this closing record sees them without re-opening the spec.

1. **The ten-minute timeout still auto-denies.** Unchanged. Park-instead-of-deny is approvals tier C and remains the single most valuable follow-on (`design-decisions.md` §2).
2. **No notification actions.** Unchanged. Nothing reaches you when the cockpit is closed; desktop/Telegram/Slack Allow-Deny buttons are tier C.
3. **No scope options.** Unchanged. "Allow & don't ask again" still does nothing; tier C.
4. **No verb glimpse in a room.** Unchanged. The lane says "is working on it," never "is reading `standup.md`" — presence tier 3, deferred with tier C.
5. **No per-agent Stop in a room.** Unchanged, and P4's Known Issue 27's file-size note is adjacent context, not a fix: a per-author halt still needs its own notice copy and a scoped gather-buffer drop.
6. **Bridged DMs still drop the waiting notice.** Unchanged. `services/relay/chat-bridge/deliver.ts:78` delivers only `turn_failed` and `halted`.
7. **Codex and OpenCode timeout parity is DOR-803.** Unchanged; that item's question, not this programme's.
8. **Human typing indicators do not exist.** Unchanged; `specs/room-presence` §5.2 keeps it a separate question, if ever.
9. **The room's durable waiting notice is unchanged, on purpose.** Still vague, late and damped.
10. **`RoomTurnWaiting` gains no fields.** Still true; `sessionId`/`interactionId` were the two candidates considered and declined in the spec's Open Questions.

## What The Spec Got Wrong

Line anchors in the spec and its P5 tasks were read at `d7e4768e6`. What P5 found, verifying rather than assuming:

- **`RoomPresenceShowcases.tsx` and a `RoomPresenceLine` section on the identity page do not exist.** Task 5.4 named both, with a line anchor (`identity-sections.ts:95`). Neither ever existed under those names in this tree — the actual borrowed content was the `'live-lane'` id, cross-listed from the chat/Conversation page via `IDENTITY_CROSS_LISTED`, which P5 removed instead (see Known Issue closures above). The design intent behind the task item was correct even though its file names were not.
- **"`StatusShowcases.tsx`'s strip half also lands here" names content that is not in that file.** Grepped for "strip" in `StatusShowcases.tsx`: zero hits. `StatusShowcases` covers status dots, `StreamingText`, `UsageStatusItem` and the transport-error banner — none of it a "strip." Not acted on; treated as brief drift rather than a real instruction.
- **"`RoomThreadShowcases.tsx`'s row-rendering demos are retired" does not match what is in the file.** It holds `ThreadReplyRow`, `RoomThreadPanel` and a "Thread arrival animations" section — none of them a duplicate of what the Surfaces section now shows. Nothing was removed there; the claim may describe an earlier draft of the file or a different one entirely.
- **ADR `260818-002806`'s own Decision prose says "ten states" and names a queue rung as the lowest.** P4's session 7 deleted the `queued` rung outright (Known Issue 25's closure) rather than reordering it, so the shipped stack is nine rungs. The ADR's Status section now flags this rather than silently leaving a wrong number in an accepted record.
- **What held up:** every other line-numbered file reference in task 5.1 (`playground-registry.ts:7`, `playground-config.ts:173-182`, `playground-pages.ts:59`, the SKILL.md stale line at :233) matched the tree exactly.

## Follow-ups Worth Filing

In Linear-ready form — one bullet each, owner named where the record above already settled it.

- **Approvals tier C: park-instead-of-deny for the ten-minute timeout.** The single most valuable follow-on named in the spec's "What is not done" #1. Owner: whoever picks up `design-decisions.md` §2.
- **The per-author room halt (spec §5.3.4).** The peek's Stop is single-agent-or-everyone today because a per-author halt needs its own notice copy and a scoped gather-buffer drop without re-opening the 2026-08-15 interrupt race. Owner: a future room-lane phase.
- **`render-session-body.tsx` stays a feature export because `features/onboarding` renders `SessionMessage` for its scripted narration.** Frees only if onboarding is changed to compose `Message.*` directly (Known Issue 29). Owner: whoever next touches onboarding's narration renderer.
- ~~**A session's `ConversationTarget.send`/`.queue` are not the session's live send path** (Known Issue 28) — `SessionComposer`'s own `handleSubmit` and `useChatQueue` are what a session actually routes through; the target's two methods are real but unused by the shipped surface. Owner: whoever moves that funnel down into the target.~~ **Resolved 2026-08-18 (DOR-1354)** — see the note below.
- **Three files still exceed the 500-line guideline** — `ChatPanel.tsx` (571), `ChannelComposer.tsx` (527), `SessionComposer.tsx` (503) — each for a stated reason (Known Issue 27). Revisit when one of them next grows, not before.
- **`resolvedBy` is never populated on a receipt.** Unreachable on a single-identity install; every cross-window receipt reads "Already answered at 2:01" rather than naming who. Wiring it belongs with the bridged-approver work (P3 Known Issue 22).
- **No multi-person Ask entitlement filter.** The list route and the global fan-out both answer this cockpit's one operator; if DorkOS ever has more than one person, both need a per-caller filter, which is a change to `eventFanOut`'s addressing model (P3 Known Issue 23).
- ~~**`GET /api/rooms/:id/sessions` and `requirePersonToAnswer` disagree about an unresolved agent header.**~~ **CLOSED (DOR-1357, 2026-08-18): the room route now refuses it too**, on the same predicate the answer routes read. The siblings keep the lenient reading, deliberately — see Post-programme follow-ups below.
- **The `room-row-menu` e2e spec has an order-dependent flake** (`apps/e2e/manifest.json`'s own run history: 2 passed / 1 failed of 3 runs). Unrelated to this programme's own suites, which are all green; worth its own investigation rather than being carried silently.

- **Codex/OpenCode timeout parity is DOR-803**, unchanged by this programme.
- **Presence tier 3 (the verb glimpse) and the remaining approvals tiers** are the two open "What is not done" items with the clearest next shape, per the spec's own §Not Done.
- **`data-testid="room-stalled"` and `room-presence` name a room inside a surface-neutral slice** (P2 Known Issue 10, which named this phase's docs pass as where it could be reconsidered). **Closed here, deliberately: they stay.** They are the hooks two shipped browser suites resolve by (`RoomsPage.stalledNotice`, `.presenceLine`), so renaming them is a rename with no reader plus a suite edit, and the docs pass turned up nothing that reads them. Revisit only if a session-side browser test ever needs to resolve the same rung, at which point one hook serving two surfaces under a room's name is a real problem rather than a cosmetic one.
- **The timeline's prop is `renderRow`, not the spec's `renderBody`** (P4 Known Issue 20). The spec's shape would need `SessionMessage` and `RoomMessage`'s surface knowledge lifted into props, undoing P1's own seam. Owner: whoever revisits `ConversationBodyRenderer`, if anybody does — otherwise the spec is what is wrong, not the code.
- **`ConversationTarget` has no mention port** (P4 Known Issue 21), so `capabilities.mentions` is the only fact about the `@` picker in the neutral tree and the picker itself rides the host's slot. The consequence to watch is a third surface wanting mentions and finding nothing shared to reuse. Owner: whoever adds that surface.
- **No unit test can see a virtualization bug** (P4 Known Issue 23): `@tanstack/react-virtual` is mocked globally in `test-setup.ts`, without which the room and chat suites could assert nothing. The nets that do see them are named in the issue, both in `apps/e2e`. Owner: a testing-infrastructure pass, not a feature phase — and not worth opening until a virtualization regression actually escapes.

## Post-programme follow-ups

Work done after the programme closed, against the follow-ups filed above. Newest
last.

### 2026-08-18 — Known Issues 9/19 resolved for the sessions route (DOR-1357)

**`GET /api/rooms/:id/sessions` now refuses an unresolved `X-DorkOS-Agent`
header**, which is the stricter reading P3 argued for and P2 raised. The gate was
`caller.kind !== 'human'` — who the caller resolved TO — and `resolveCaller`
treats an unverifiable token as "no agent presented", so
`curl -H 'X-DorkOS-Agent: garbage'` read the route as the operator. It is now
`presentsAgentIdentity(req, res)`: the same fact `readCallerAuthority` feeds
`resolveDecisionAuthority` as `agentIdentityPresented`, lifted into
`middleware/agent-identity.ts` so the rooms route and the Ask's answer routes
read one predicate rather than two copies of one sentence. The new gate is
strictly wider than the old one — `resolveCaller` returns an agent only when
`getRequestAgentIdentity` resolved, which is the predicate's first disjunct — so
nothing that was refused before is allowed now.

Three things this deliberately did NOT do:

- **The sibling room routes are unchanged.** Attachments, handles, halt and every
  route that only takes `resolveCaller` still read an unverifiable token as "no
  agent presented". Changing them is a change to every room route's caller model,
  which is what issue 19 said needs its own review; this route is the one the
  record singled out.
- **It did not adopt the rest of `requirePersonToAnswer`.** That guard also runs
  `requireOperatorCookieUnderLogin`, which under login-on refuses a person
  holding a per-user API key. Right for deciding whether a tool runs; wrong for a
  read whose whole body is two ids, where it would cost a person the "Open its
  session" link for no gain a machine could not already get by omitting a header.
  So `person-proof-conformance.test.ts` gains no seam here.
- **Visibility still comes first.** A room the caller cannot see answers 404
  before the person gate runs, for both the resolved and the unresolved header —
  the ordering P2's review settled (issue 14), now pinned for the widened gate
  too.

Not user-facing: the cockpit has never sent `X-DorkOS-Agent`, so no person's
request changes shape. Tests: `routes/__tests__/rooms-sessions.test.ts` (the
unresolved-header 403, the resolved-agent 403, the person 200, and 404-before-403
for an unknown room) and `middleware/__tests__/agent-identity.test.ts` (the
predicate's three cases).

### 2026-08-18 — DOR-1358: the `room-row-menu` flake was a real client bug

**Root cause (a): the product.** `applyReadCursor` (`entities/room/model/use-room-list-stream.ts`) cancels
every in-flight room-list fetch before it patches an unread badge in place. The cancel is right — a list
GET computed before the cursor moved would land on top of the patch — but a cancelled TanStack fetch is
**reverted, and nothing schedules a replacement**. So the cancel does not postpone that response, it drops
it, along with every other fact it was carrying. The room list then keeps whatever it had until the next
room event.

The path a person can see: rejoin a channel, and the rejoin's own list invalidation is in flight when a
`read_cursor` event lands — from a second device, or from any other room at all, since a cursor in a room
this client has never opened reaches the same handler (`movedByReader` answers yes when the room detail is
absent). The list reverts to the copy where the reader is still not a member, and the sidebar row goes on
saying "Left" in a channel they are back in. Proven in jsdom before the fix: the invalidation's refetch ran,
its answer (`unreadCount: 0`) was discarded, and the cache still read `unreadCount: null` with the query
idle.

**Fix:** re-ask for the list when — and only when — the cancel actually interrupted a fetch
(`queryClient.isFetching` read before the cancel, `invalidateQueries` after the patch). The badge still goes
out on the event with no round trip in the ordinary case; the replacement GET is computed after the cursor
moved, so it agrees with the patch. Pinned by two tests in `use-room-list-stream.test.tsx` — one that the
re-ask happens, one that it is never paid for by an event alone.

**Also done, and honestly a second cause rather than a proof:** the spec's two sidebar assertions were the
only waits in the file left on Playwright's bare 5s default. The row's membership comes from the room LIST,
a round trip distinct from the roster one the composer assertion above it already waits for, so both now
carry the file's own `SERVER_ROUND_TRIP_MS` ceiling like every other server wait in it.

**Not reproduced.** Four runs before the fix — the reported sequence at one worker and at three, and the full serial
`chromium` project (229 tests, the CI shape) — were all green on `room-row-menu`; the manifest's +8 runs are those four plus the reported sequence three more times and `tests/rooms` alone, all after the fix. The brief's literal
command was also malformed (`--project` takes a list, so the paths were parsed as project names), and
`tests/streams/**` is `testIgnore`d from `chromium` entirely: it runs in `chromium-streams` against the
test-mode leg, a different server and a different database, so it cannot have shared state with the rooms
specs. The failure named in the P4 review is therefore diagnosed from the code rather than from a
reproduction.

### Known Issue 28 — resolved (2026-08-18, DOR-1354)

**A session's Enter now ends in `ConversationTarget.send`, and Enter mid-turn in `.queue`.** The
port declared two send methods and only the room half used them; the session composed through a
`handleSubmit` prop and an `enqueueContent` prop passed down from `ChatPanel`, so both methods
were real, covered and unreachable — the exact shape where "the composer sends through the
target" was true of one surface and false of the other.

What moved, and what deliberately did not:

- **`SessionComposer.submitAndDismiss` calls `target.send({ text })`.** The `handleSubmit` prop
  is gone. `ChatPanel` hands the target a `sendMessage` seam instead
  (`submitContent(content, { clearInput: true })`).
- **`useChatQueue`'s `onEnqueue` is `target.queue`**, wired in `SessionComposer` as `holdForTurn`
  — which turns the port's rejection back into the boolean the funnel is built on, because the
  composer holds the words until the server confirms it has them (DOR-480).
- **`useChatQueue` itself stayed in `features/chat`, and that is the point rather than a
  shortcut.** It is the session's own funnel — native-command intercept, duplicate-press latch,
  keystroke record, clear-on-confirmed, and every queue-editing verb the panel needs — and it
  plays exactly the role `ChannelComposer.handleSubmit` plays for a room, which also does work
  before reaching `target.send`. The port is where a surface's funnel ENDS, not the whole of it.
  Pulling the funnel into `session-target.ts` would have moved queue editing into a model file
  that has no business with it and left a second copy of `deliver` for steer and stage.
- **Steer and Add context stay props.** The port has two verbs because those are the two every
  surface could have; steering is one runtime's capability on one surface.
- **`canSend` became a real answer, and it fixes a real bug.** There is no "gone session" notion
  anywhere in the client — the spec's own example was aspirational — so the case it covers is the
  one that genuinely exists and is genuinely reachable: `sessionId === ''`, which is the Obsidian
  embed's first load. `app-store` seeds `sessionId: null`, nothing auto-mints one (`EmbedSidebar`
  mints on a row click or New), switching agents resets it to null again
  (`use-directory-state.ts`), and `App.tsx` keeps a composer on screen throughout.

  What happened there before was checked rather than assumed: Enter reached
  `postMessage(null, …)`, and `POST /api/sessions/:id/messages` validates its id with
  `parseSessionId`, which is a **uuid** check — so `/api/sessions/null/messages` is a
  `400 INVALID_SESSION_ID`. The composer had already been emptied by then (`clearInput` runs
  before the POST), so the words were gone and all that came back was "Could not send message".
  Refusing up front is strictly better than that.

  The sentence is its **own** — "Pick a conversation, or start a new one." — deliberately not the
  room target's "Still opening this conversation…". Nothing is opening in that state; telling
  somebody to wait for something that will never arrive is the dishonest half of refusing, and
  the honest version names the way out.

- **`useSessionSubmit.handleSubmit` folded into `submitContent`**, which now takes
  `{ clearInput }`. `handleSubmit` survives as the zero-argument form `useLaunchPrompt` sends
  through, so the `?prompt=&send=1` link still takes the composer's own path and no other.

The net is one new cross-surface test rather than one more per surface:
`test-helpers/__tests__/composer-target-contract.test.tsx` mounts each host composer over a spy
target and presses Enter. It lives beside the two benches because no widget may import another
and the case is about the pair.

Two more tests came out of review, both pinning things the refactor made possible to get wrong
silently:

- `widgets/session/__tests__/ChatPanel-send-clears.test.tsx`. Emptying the composer used to be
  structural — `handleSubmit` hard-coded the `clearInput` argument — and is now one line of
  wiring in `ChatPanel`. Dropping `{ clearInput: true }` left all 954 client test files green
  while the box stopped emptying on every send. This mounts the real panel over the real submit
  path and asserts both halves: the draft is `''` after an accepted trigger, and it is untouched
  when the attachment transform throws (DOR-480).
- Two cases in `SessionComposer.test.tsx` for the no-conversation state — that the box is closed
  with its own sentence, and that Enter reaches neither `send` nor `queue`. A reason drawn over a
  live box would be a label, not a refusal.

One thing this did NOT fix, said out loud because it touched it: `ChatPanel.tsx` and
`SessionComposer.tsx` both grew (571 → 583 and 503 → 534 raw lines), which is the trigger
Known Issue 27 named for revisiting the 500-line guideline. Neither trips `max-lines`, which
counts code rather than the comments most of the growth is, so no gate moved — but the item is
now genuinely due rather than merely open.
