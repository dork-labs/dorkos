# Task Breakdown: The home is a room (#team room home, tabs IA, jump back in)

Spec: [02-specification.md](02-specification.md) · Decisions: [design-decisions.md](design-decisions.md)

Generated 2026-08-08T14:17:53Z · mode `full` · 31 tasks across 5 phases.

**Phase dependencies.** Phases 0 and 1 are independent and can run in parallel worktrees. Phase 2 depends on both. Phase 3 is independent of Phase 2 (parallelizable). Phase 4 depends on Phase 2.

**Critical path:** 0.1 → 2.1 → 2.2 → 2.5 → 4.1 → 4.2 → 4.7

## Summary

| Phase | Name                   | Tasks |
| ----- | ---------------------- | ----- |
| 0     | Foundations            | 4     |
| 1     | Home surface shell     | 7     |
| 2     | #team room home        | 7     |
| 3     | Read-state unification | 6     |
| 4     | Moments + welcome-back | 7     |

---

## Phase 0 — Foundations

### Task 0.1: Land RP3 ambient pending context (DOR-665) — joinedSeq, ambientMaxEntries, cursor advance on claim

- **Size:** large · **Priority:** high
- **Depends on:** nothing
- **Can run alongside:** 0.2, 0.3, 0.4, 1.1, 1.3
- **Active form:** Landing RP3 ambient pending context (DOR-665)

Execute Linear DOR-665 (room-participation RP3) exactly as its validation criteria state; this program consumes RP3's cursor mechanics and builds nothing parallel. Do not widen scope: live-ambient mode stays out if DOR-665 defers it.

WHAT TO BUILD

1. `room_members.joinedSeq` (integer) in `packages/db/src/schema/rooms.ts`, backfilled in the SAME migration from each membership's `joinedAt` matched against `room_entries.createdAt`. Rationale to preserve: comparing integers on the primary key is cheaper and less ambiguous than comparing ISO strings, and it makes the clamp a `WHERE seq > ?`.
2. `rooms.ambientMaxEntries` per-room column, default 30, in the same schema file. It replaces the hardcoded `PENDING_MAX_ENTRIES` constant in `apps/server/src/services/rooms/room-context.ts` — that file's own comment names this handoff, so remove the constant and the comment together (no dead code).
3. Pending-window math in `room-context.ts`: the window is `max(lastReadSeq, joinedSeq, latestSeq - ambientMaxEntries)` EXCLUSIVE through `latestSeq` INCLUSIVE, oldest dropped first, and `pendingTruncated: true` on the emitted room_context block whenever anything was dropped. Without the cap the first ambient turn after RP3 ships replays every entry in the room, because every agent cursor is currently `0`.
4. The missing write half: **the agent's cursor advances when the turn is CLAIMED, not when the reply posts.** A turn that errors still saw the pending entries, and replaying them on the next turn would show the agent the same messages twice. Today `RoomService.setReadCursor` (`apps/server/src/services/rooms/room-service.ts:1334`) is called only from the client mark-read route (`apps/server/src/routes/rooms.ts:330`, `PUT /:id/read-cursor`) and the dormant community adapter. Wire the advance into the claim path — see `apps/server/src/services/rooms/room-claims.ts` and `room-turn-runner.ts`.

BACKGROUND (why this exists): `room_members.lastReadSeq` is the `(member, room)` read cursor, present for every member including agents. Its complete set of readers today is `room-service.ts:419,434` (the sidebar's unread count, scoped to the resolved caller) and the client's unread divider. Nothing reads an agent's cursor and nothing advances it — it is written to `0` at join (`room-store.ts:62,243`) and stays there forever: dead state. RP3 turns that into the mechanism. Silence must stay free: ambient does NOT run a model turn by default.

VALIDATION CRITERIA (DOR-665 §8.4, verbatim — every one of these must be a passing test):

- A `mention-only` agent joined at seq 40 and mentioned at seq 50 sees entries 41 to 49 in `pending`, and nothing at or below 40.
- With `ambientMaxEntries: 5` and a cursor of `0` in a 100-entry room, `pending` holds 5 entries and `pendingTruncated` is true.
- A post that triggers nobody runs no `sendMessage`. Assert on the runtime double, not on a log line: this is the `E7` guarantee and a log assertion would not catch a turn.
- Two turns in a row do not show the same entry twice.

ADDITIONAL ACCEPTANCE

- Migration is idempotent and backfills existing rows; run it against a populated dev `~/.dork` database and confirm no membership ends with a `joinedSeq` newer than its first visible entry.
- Server integration tests use `FakeAgentRuntime` + scenarios from `@dorkos/test-utils` (see `apps/server/src/services/rooms/__tests__/`).
- `pnpm --filter @dorkos/server typecheck && pnpm --filter @dorkos/server lint` clean; `pnpm vitest run apps/server/src/services/rooms/__tests__` green.
- Changelog fragment in `changelog/unreleased/`.

### Task 0.2: Write and accept the thread-over-sessions ADR

- **Size:** small · **Priority:** high
- **Depends on:** nothing
- **Can run alongside:** 0.1, 0.3, 0.4, 1.1, 1.3
- **Active form:** Writing the thread-over-sessions ADR

Write a new ADR in `decisions/<id>-thread-over-sessions.md` (id from `.claude/scripts/id.ts`, format `YYMMDD-HHMMSS`) and register it in `decisions/manifest.json`. Status goes straight to `accepted` — this ADR DOCUMENTS AND BLESSES a split that already exists in code. There is no migration and no code change in this task.

WHAT THE ADR MUST SAY

1. **Two conversation models, both kept.**
   - Direct agent chat (the `/session` surface): the SESSION is the durable thing — runtime-owned transcript (ADR-0310), resumed directly. Unchanged, kept deliberately.
   - DMs and rooms: the THREAD (the append-only room log, `room_entries`) is the durable thing; the sessions underneath are disposable engine runs. A fresh session may start under the same thread when context goes stale; agents rebuild context from the log (RP3 push today, RP7 pull later). Users never see the word "sessions" on room surfaces.
2. **The where-you-reply rule**: the place you reply from decides what continues. Home composer → #team. A triage card about a session → that session. A DM → that DM thread. Task-triggered and Telegram-originated sessions never hijack the home composer.
3. **Constraints it must respect and name**: ADR-0310 (runtime-owned session storage) — threads never replace direct-chat session durability; ADR 260728-022013 (a thread is a relation between entries); ADR-0273 (runtime-neutral context injection) — the `room_context` push channel; ADR 260726-170125 (a room is a membership-scoped durable stream).
4. **Consequences**: room↔session identity plumbing (`room_sessions` placeholder ids) stays structurally as-is; the durable cursor lives on the membership row, not the session, which is exactly why it survives session swaps.

ACCEPTANCE

- ADR follows the `writing-adrs` skill's shape (Context / Decision / Consequences), no hype, no filler.
- `decisions/manifest.json` updated with the new id, slug, status `accepted`, and date.
- Spec `specs/team-room-home/02-specification.md` "Related ADRs" line for thread-over-sessions can be read as satisfied (draft → accepted).
- Changelog fragment not required for a docs-only ADR if the PR carries the `skip-changelog` label; otherwise add one.

### Task 0.3: Broadcast read-cursor writes on eventFanOut so a second device updates on push

- **Size:** medium · **Priority:** high
- **Depends on:** nothing
- **Can run alongside:** 0.1, 0.2, 0.4, 1.1, 1.3
- **Active form:** Broadcasting read-cursor writes on eventFanOut

Close most of the cross-device read-state gap for rooms at trivial cost, ahead of the fuller unification in Phase 3. Today `RoomService.setReadCursor` (`apps/server/src/services/rooms/room-service.ts:1334`) writes the cursor and tells nobody — a second browser or device only catches up on the 30s poll.

WHAT TO BUILD

- `RoomService.setReadCursor` publishes an event on the existing global bus (`eventFanOut`, surfaced at `GET /api/events` via `apps/server/src/routes/events.ts`; the instance is wired in `apps/server/src/index.ts`). Payload carries at minimum: room id, author id (the member whose cursor moved), and the new `lastReadSeq`.
- Add the new event type to the shared event union in `packages/shared` AND to the client's event allowlist — a new event member that is not added to the client allowlist is silently dropped (this has bitten before; grep for where session/room event types are filtered in `apps/client/src/layers/entities/`).
- Client: `apps/client/src/layers/entities/room/` consumes the event and updates the TanStack Query cache for room unread counts / the unread divider directly, with no added polling. Reuse the existing global-event subscription; do not open a second stream.
- Only the CALLER's own cursor moves are actionable on the client; ignore cursor events for other authors (agents' RP3 advances must not repaint the human's divider).

ACCEPTANCE / TESTS

- Server integration test using `collectDurableEvents` from `@dorkos/test-utils`: calling `PUT /api/rooms/:id/read-cursor` emits exactly one cursor event on `GET /api/events` with the expected room id and seq.
- No event is emitted when the write is a no-op (cursor already at or ahead of the requested seq).
- Client test (RTL + mock `Transport`): receiving a cursor event for the current user collapses the unread badge without a refetch.
- `pnpm vitest run apps/server/src/services/rooms/__tests__` and the room entity client tests green.
- Changelog fragment.

### Task 0.4: Add presence truthfulness to the runtime conformance suite

- **Size:** medium · **Priority:** medium
- **Depends on:** nothing
- **Can run alongside:** 0.1, 0.2, 0.3, 1.1, 1.3
- **Active form:** Adding presence truthfulness to runtime conformance

The Phase 2 presence strip claims "who is working, and what they are bound to". That claim is only safe if every runtime either answers it truthfully or admits it cannot. Add the assertion to the shared conformance suite so a runtime cannot regress it silently.

WHAT TO BUILD

- Extend `runtimeConformance` in `packages/test-utils/` with presence assertions: for a runtime that reports running state, a session that is mid-turn must report `working` (or `working_late`) and expose its binding (`busyWith`: the room or session it is bound to); a session that is idle must not report working.
- Where a runtime genuinely cannot expose running state or binding, the conformance case asserts it reports ABSENCE explicitly (undefined / not-supported), never a fabricated value. The rule for the UI downstream: **the strip omits rather than lies.**
- Run the extended suite against all production runtimes: `apps/server/src/services/runtimes/claude-code/`, `codex/`, `opencode/`, plus `test-mode`. Where a runtime fails honestly (cannot report), record that in the runtime's capability surface rather than weakening the assertion.
- Update `contributing/adding-a-runtime.md` authoring checklist with the new presence expectation.

ACCEPTANCE

- `pnpm vitest run` over each runtime's conformance test file is green with the new assertions.
- Seed a deliberate defect (a runtime that reports `working` for an idle session) and confirm the suite goes red — prove the check can fail before trusting it.
- No runtime is granted an exemption by loosening a shared assertion; exemptions are expressed as capability flags.

---

## Phase 1 — Home surface shell

### Task 1.1: Wrap /, /activity, /tasks, /workspaces in a HomeSurfaceLayout tab bar (no route renames)

- **Size:** large · **Priority:** high
- **Depends on:** nothing
- **Can run alongside:** 0.1, 0.2, 0.3, 0.4, 1.3
- **Active form:** Wrapping the home routes in a tab layout

Build the home surface as a layout with a tab bar whose tabs are the EXISTING routes rendered inside it. No path changes, no redirects — URLs are contracts.

TAB TABLE (exact)
| Tab label | Route | Renders |
| Home | `/` | current `DashboardPage` as a placeholder until Phase 2 swaps in the #team room |
| Activity | `/activity` | existing `ActivityPage` + its `activitySearchSchema`, untouched |
| Scheduled | `/tasks` | existing `TasksPage`; the LABEL says "Scheduled", the route stays `/tasks` |
| Workspaces | `/workspaces` | existing `WorkspacesPage` |

WHAT TO BUILD

- New FSD widget `apps/client/src/layers/widgets/home/` exporting `HomeSurfaceLayout` (tab bar + outlet) through its barrel `index.ts`. Follow the layer rule `shared ← entities ← features ← widgets`; import only from barrels.
- `apps/client/src/router.tsx`: `indexRoute` (line ~180, path `/`), `activityRoute` (~417), `tasksRoute` (~320) and `workspacesRoute` (~367) become children of / render through the layout. Keep every existing `validateSearch` schema and loader behaviour exactly as-is.
- Active-tab state derives from the current pathname; `/` is active only on `/`, and each other tab on its own path. Deep links with search params (`/activity?categories=…`) land on the right tab with params intact.
- Mobile: the tab bar scrolls horizontally; tabs are 44px touch targets. Verify at 375px, tablet, and desktop widths — no horizontal page scroll.
- Command palette entries for Activity / Tasks / Workspaces keep working unchanged (they navigate by path).
- Follow `contributing/design-system.md` and the Calm Tech language; use `motion` for the tab indicator if animated, and respect reduced motion.

ACCEPTANCE / TESTS

- Unit: tab-layout active-state mapping — a table-driven test over the four paths plus an unrelated path (`/team`) asserting which tab reads active.
- RTL: rendering the layout at `/activity?categories=session` preserves the search param and shows Activity active.
- Every test that renders a changed component re-runs: grep for test files mounting `ActivityPage`, `TasksPage`, `WorkspacesPage`, `DashboardPage` and the router itself before pushing.
- Changelog fragment.

### Task 1.2: Shrink the sidebar from 7 nav items to 4 and re-point orphaned tour anchors

- **Size:** medium · **Priority:** high
- **Depends on:** 1.1
- **Can run alongside:** 1.3, 1.5, 1.6
- **Active form:** Shrinking the sidebar to four nav items

The sidebar's nav header goes from 7 items to 4 now that Activity, Scheduled and Workspaces are tabs of the home surface.

WHAT TO BUILD

- `apps/client/src/layers/features/dashboard-sidebar/ui/SidebarNavHeader.tsx`: the item list becomes exactly **Home (`/`) · Team (`/team`) · Connections (`/connections`) · Marketplace (`/marketplace`)**, plus Search. Remove the Activity, Tasks and Workspaces `NavButton`s entirely (no commented-out code, no feature flag).
- Home's active state covers the whole home surface: active on `/`, `/activity`, `/tasks`, and `/workspaces`.
- Tour anchors that pointed at removed items must be re-pointed or removed: grep `TOUR_ANCHORS` — known touch points are `apps/client/src/layers/features/tours/model/tour-definitions.ts`, `apps/client/src/layers/features/dashboard-sidebar/ui/SidebarNavHeader.tsx`, and `apps/client/src/layers/features/tasks/ui/TasksList.tsx`. A tour step that anchors to a node that no longer exists must not silently no-op: re-point it at the Home nav item or the relevant tab, and update the step copy so it still reads true.
- Keyboard navigation and focus order through the shrunken header stay correct; the collapsed/rail sidebar variant still renders 4 items without overflow.

ACCEPTANCE / TESTS

- `apps/client/src/layers/features/dashboard-sidebar/__tests__/SidebarNavHeader.test.tsx` updated: asserts exactly four nav items by accessible name, and asserts Home reads active for each of the four home-surface paths.
- Tour tests (or a new one) assert every anchor id referenced by a tour definition resolves to a rendered element in the relevant surface.
- Re-run `DashboardSidebar.test.tsx` and any test mounting `SidebarNavHeader`.
- Changelog fragment.

### Task 1.3: Build the unified Jump back in recents model and replace the sidebar Recents section

- **Size:** large · **Priority:** high
- **Depends on:** nothing
- **Can run alongside:** 0.1, 1.1, 1.2
- **Active form:** Building the unified Jump back in recents model

One recents model, used by two surfaces. Today's sidebar Recents shows only agent chats — no DMs, no rooms, no runs.

WHAT TO BUILD

1. New entities slice `apps/client/src/layers/entities/recents/` exporting `useJumpBackIn()` through its barrel. It merges:
   - recent sessions (the existing `useRecentSessions` from `apps/client/src/layers/entities/session/`, partitioned by origin exactly as today),
   - recent DMs and rooms/channels (from the room entity's list/stream hooks in `apps/client/src/layers/entities/room/`, ordered by latest entry seq / activity),
     ordered by last activity across all kinds, deduped (one row per thread — a room and a session under it collapse to the room), and capped at ~8.
     Each item carries: kind (`session` | `dm` | `room`), id, display name, a one-line last-activity summary, and a timestamp for relative rendering.
2. New `JumpBackInSection` in `apps/client/src/layers/features/dashboard-sidebar/ui/`, replacing `RecentSessionsSection.tsx`. Same collapse preferences and same section-header menu behaviour as the section it replaces — reuse `SidebarSectionHeader` and the existing sidebar prefs plumbing. Delete `RecentSessionsSection.tsx` and its test once nothing imports it (no dead code).
3. Row rendering: `IdentityAvatar` (or a room glyph for channels) + name + one-line last-activity summary + relative time. Reuse the shipped identity kit; do not fork avatar logic.

ACCEPTANCE / TESTS

- Unit tests for `useJumpBackIn`: merge across the three kinds; ordering strictly by last activity; dedupe (a session belonging to a room does not appear twice); cap at 8; empty state returns an empty list, not a spinner forever.
- RTL: `JumpBackInSection` renders DM, room and session rows with the right glyphs and navigates to the correct route on click.
- Grep for every test mounting `RecentSessionsSection` or `DashboardSidebar` and re-run them.
- Changelog fragment.

### Task 1.4: Add the Jump back in popover to the focused-empty home composer

- **Size:** medium · **Priority:** high
- **Depends on:** 1.3, 1.1
- **Can run alongside:** 1.5, 1.6
- **Active form:** Adding the Jump back in composer popover

Surface two of the same recents model: focusing the home composer WHILE IT IS EMPTY floats up a Jump back in list of recent threads across all surfaces.

WHAT TO BUILD

- A `JumpBackInPopover` component in `apps/client/src/layers/widgets/home/` (or the composer feature slice if it composes more cleanly there), driven by `useJumpBackIn()` from `entities/recents` — the same data, no second query path.
- Trigger: composer receives focus AND its value is empty. Any keystroke that makes the value non-empty dismisses it. Blur dismisses it.
- Interaction: arrow keys move the selection; Enter jumps into the selected thread; Escape closes without navigating. The popover must not swallow the composer's own key handling when closed.
- Rows match the sidebar rows: `IdentityAvatar` or room glyph, name, one-line last-activity summary, relative time.
- Anchoring: attach to the shipped `Composer.*` compound family (`apps/client/src/layers/features/composer/`) as a consumer — **do not fork the composer family**; rich text (DOR-948) and room attachments (DOR-947) are in-flight siblings that share it. In Phase 1 it anchors to the placeholder home composer; Phase 2 carries it onto the #team room composer with no change to this component.
- Dismissal must not fight Radix outside-dismiss: use the established `data-gesture-priority` / yield-to-selector pattern rather than blanket `stopPropagation`.

ACCEPTANCE / TESTS

- RTL: focus-while-empty opens the popover; typing closes it; Escape closes without navigation; Enter on a selected row navigates to that thread's route.
- Keyboard-only run: tab to composer, arrow to the third row, Enter — lands on the right thread.
- Mobile (375px): the popover is fully visible and does not push the page into horizontal scroll.
- Changelog fragment.

### Task 1.5: Retire the promo main slot, Your Agents, and the System Status row with their click-throughs re-homed

- **Size:** medium · **Priority:** medium
- **Depends on:** 1.1
- **Can run alongside:** 1.2, 1.4, 1.6
- **Active form:** Retiring the promo, Your Agents, and System Status sections

Three dashboard sections have earned retirement. Each is REMOVED, not hidden, and every job it did is already covered elsewhere. Built-in contributions unregister from `apps/client/src/layers/widgets/dashboard/model/dashboard-contributions.tsx` as they go.

WHAT TO RETIRE

1. **`promo` (the `dashboard-main` PromoSlot placement)** — retired. The `dashboard-sidebar` placement SURVIVES and the promo registry stays (`apps/client/src/layers/features/feature-promos/model/promo-registry.ts`, `use-promo-slot.ts`, `ui/PromoSlot.tsx`). Only the `dashboard-main` placement and its wrapper contribution go. The tasteful successor on home is the quiet-state DorkBot suggestion (task 4.5), which reuses the registry's qualification logic.
2. **`your-agents`** — retired. Delete `apps/client/src/layers/widgets/dashboard/ui/YourAgentsSection.tsx`, `AgentCard.tsx`, `model/use-dashboard-agents.ts`, `lib/agent-card-status.ts`, `lib/order-agent-cards.ts` and their tests, once nothing imports them. Its jobs are covered by: the presence strip (task 2.4), the sidebar roster, the `/team` page, and Jump back in.
3. **`system-status` (the row)** — retired as a row. Delete `apps/client/src/layers/features/dashboard-status/ui/SystemStatusRow.tsx` and `SubsystemCard.tsx`. Every click-through already has a home and must be verified reachable before deletion: Tasks status → the Scheduled tab; Relay / dead letters → `/connections?region=messaging`; Mesh / topology → `/team?view=topology`; the activity sparkline (`ActivitySparkline.tsx`) → moves to the Activity tab header (keep the component, re-home it).

ACCEPTANCE / TESTS

- Unit regression test asserting the built-in contribution list no longer contains `promo`, `your-agents` or `system-status` ids — an orphan-disposition regression guard so removed sections stay removed.
- Manually drive each re-homed click-through in a real browser and confirm it lands on the right surface with the right filter applied (`/connections?region=messaging`, `/team?view=topology`, Scheduled tab, Activity tab sparkline).
- `pnpm knip` (after building dists) reports no newly orphaned modules from these deletions; delete anything it flags.
- Changelog fragment written for a human: what disappeared and where that information now lives.

### Task 1.6: Re-home the dashboard.sections extension slot to a From your extensions section on the Activity tab

- **Size:** medium · **Priority:** medium
- **Depends on:** 1.1
- **Can run alongside:** 1.2, 1.4, 1.5
- **Active form:** Re-homing the extension dashboard sections slot

The `dashboard.sections` extension slot is KEPT — only its placement moves. Third-party extensions must not lose their surface when the dashboard page is deleted in Phase 2.

WHAT TO BUILD

- The slot id `dashboard.sections` stays stable — extensions in the wild keep working with no manifest change. Do not rename it.
- Remaining (third-party) contributions render in a **"From your extensions"** section at the TOP of the Activity tab (`/activity`), above the activity feed. Built-in contributions are unregistered as they are absorbed or retired (tasks 1.5 and 2.5), so by the end of the program this section holds only third-party contributions.
- When there are zero third-party contributions the section renders zero DOM — no empty header, no placeholder card.
- The slot query today lives in `apps/client/src/layers/widgets/dashboard/ui/DashboardPage.tsx` (`useSlotContributions('dashboard.sections')`, with a `visibleWhen` filter). Move that consumption into the Activity tab surface, preserving the `visibleWhen` predicate and the priority ordering.
- Docs: update `packages/extension-api` docs and `contributing/architecture.md` to state the new placement and that the slot id is unchanged. Note in the docs that a proper room-widget successor is deferred (Phase 5, not this program).

ACCEPTANCE / TESTS

- RTL: with two fake contributions registered, both render at the top of the Activity tab in priority order; with a `visibleWhen` returning false, that one does not render.
- With zero contributions, the Activity tab renders no "From your extensions" heading at all.
- Extension-api docs and `contributing/architecture.md` updated in the same PR.
- Changelog fragment (extension authors are the audience — say plainly where their sections now appear).

### Task 1.7: End-to-end and docs coverage for the home surface shell

- **Size:** medium · **Priority:** medium
- **Depends on:** 1.1, 1.2, 1.4, 1.5, 1.6
- **Can run alongside:** —
- **Active form:** Adding e2e and docs coverage for the home shell

Prove the shell in a real browser and write down what changed, before Phase 2 builds on top of it.

E2E (Playwright, `apps/e2e/tests/`) — follow the `browser-testing` skill:

- Tab navigation preserves deep links: land on `/activity?categories=session`, confirm Activity is the active tab and the filter is applied; move to Scheduled and back; the URL and params survive.
- The sidebar has exactly four nav items (Home, Team, Connections, Marketplace) plus Search.
- The Jump back in popover opens on focusing the empty home composer and navigates into the selected thread.
- Mobile viewport (375px): the tab bar scrolls horizontally, no page-level horizontal scroll, tabs are tappable.
- Add these to a new or existing spec under `apps/e2e/tests/` alongside the existing `dashboard-sidebar/` suite.

DOCS

- `docs/` (Fumadocs): update the home-surface concept page to describe the tabbed home and the four-item sidebar. Follow the `writing-for-humans` skill — plain enough for a smart 9th grader who does not code.
- `plans/language-ia-simplification.md`: confirm the addendum pointing at this spec is present and accurate (its "sidebar unchanged" line is superseded by this work).
- `contributing/architecture.md`: note the `widgets/home/` slice and the layout-over-routes approach.

ACCEPTANCE

- Playwright specs pass locally against a real build, not only in mock mode.
- Prove a check can fail: seed a fifth sidebar item, watch the e2e go red, revert.
- `docs:coverage` passes if new MDX files are added.
- Changelog fragment.

---

## Phase 2 — #team room home

### Task 2.1: Seed the #team room at boot with ensureTeamRoom() and guard it as a system room

- **Size:** large · **Priority:** high
- **Depends on:** 0.1
- **Can run alongside:** 2.3
- **Active form:** Seeding and guarding the #team room

Create the one room the product depends on, once per install, and make it undeletable.

WHAT TO BUILD

1. `apps/server/src/services/rooms/ensure-team-room.ts` (new), patterned on `ensureDorkBot()` (`apps/server/src/services/mesh/ensure-dorkbot.ts`) and called from the same boot path in `apps/server/src/index.ts`. It:
   - creates the **#team** channel once per install, idempotent, keyed by a well-known natural key (e.g. `system:team`) so a restart never creates a second one;
   - adds the local human and DorkBot as members;
   - is safe to call on every boot, including against a database where the room already exists with edited title/topic (it must not overwrite user edits).
2. **Newly-registered agents join automatically**: hook agent registration so a new agent is added to #team as a member with the channel-default `engaged` response mode. Find the registration path in `apps/server/src/services/mesh/` and add the membership there; existing agents are backfilled on first boot after this ships.
3. **System room semantics** — #team cannot be archived or renamed by agents. This closes the DOR-608 hole for the one room the product depends on: `apps/server/src/services/rooms/room-service.ts` deliberately leaves `updateRoom` ungated because the naive `requireOperator` fix breaks `createRoom`'s DM un-archive path (see the file header comment, lines ~18-25). Do NOT add a blanket gate. Add a narrow guard: a room flagged as a system room refuses rename, archive and delete from any non-owner caller, enforced at the service, at the MCP tool surface, and in the client UI (mirroring how system agents are protected). Users may MUTE #team; they may not delete it.
4. **Discovery**: make #team findable by natural key. Either a lightweight `GET /api/rooms/team` convenience route or a `wellKnown: 'team'` field on the `GET /api/rooms` list — implementer's choice, but document it in OpenAPI either way. `GET /api/rooms` is otherwise unchanged.
5. Regenerate OpenAPI (run BOTH doc commands — the `openapi-fresh` gotcha; a single command leaves the check red).

ACCEPTANCE / TESTS

- Server integration: `ensureTeamRoom` idempotency — call it three times, exactly one room exists, membership is not duplicated.
- Membership defaults: the human and DorkBot are members after first call; a freshly registered agent is a member with `engaged` response mode.
- System-room guard: an agent-authored rename, archive and delete of #team are each refused with the room's standard error shape; the same operations on an ordinary room still succeed; the DM un-archive path is untouched (regression test).
- A user CAN mute #team.
- `pnpm vitest run apps/server/src/services/rooms/__tests__` green; `docs-openapi` check green.
- Changelog fragment.

### Task 2.2: Route unaddressed #team posts to the default agent via always membership mode

- **Size:** medium · **Priority:** high
- **Depends on:** 2.1
- **Can run alongside:** 2.3, 2.4
- **Active form:** Routing unaddressed #team posts to the default agent

Posting in #team is a room post, full stop. Unaddressed posts must reach exactly one agent, using room semantics rather than new routing machinery.

WHAT TO BUILD

- The **default agent** (from `packages/shared/src/config-schema.ts`, `agents.defaultAgent`, default `'dorkbot'`) holds an `always` response mode on its #team membership. That single configuration is what makes unaddressed posts trigger it. Wire this in `ensureTeamRoom` / the membership defaults so it is true from first boot.
- Every other agent's #team membership uses the channel default (`engaged` / mention-only semantics) — they do not consume unaddressed messages, so no token burn and no pile-on.
- `@handle` reaches any member directly; multiple mentions fan out through the existing room dispatch (`apps/server/src/services/rooms/addressing.ts`, `room-trigger.ts`) — unchanged.
- **Changing the default agent in settings re-points the `always` membership**: when `agents.defaultAgent` changes, the previous default agent's #team membership drops back to the channel default and the new one gains `always`. This is the user-visible knob; it must not require a restart.
- No new routing layer, no special-case "home composer" code path on the server.

ACCEPTANCE / TESTS

- Server integration with `FakeAgentRuntime`: an unaddressed post in #team triggers exactly one turn, on the default agent. Assert on the runtime double, not on log lines.
- A post mentioning `@someagent` triggers that agent and NOT the default agent twice.
- Two mentions fan out to two turns.
- Changing `agents.defaultAgent` moves the `always` mode; the old default stops answering unaddressed posts, verified by a second unaddressed post.
- An unaddressed post in an ORDINARY room still triggers nobody (the `E7` guarantee is not weakened globally).
- Changelog fragment.

### Task 2.3: Build the pinned triage header — Waiting on you and Needs attention, resolvable in place

- **Size:** large · **Priority:** high
- **Depends on:** 1.1
- **Can run alongside:** 2.1, 2.2, 2.4
- **Active form:** Building the pinned triage header

A sticky header above the feed that is never buried by scroll, absorbing the two dashboard sections that earned their keep. Build it in `apps/client/src/layers/widgets/home/` and showcase it in the Dev Playground; task 2.5 mounts it at `/`.

WHAT TO BUILD

1. **Waiting on you** — pending-approval cards. Same data as today: `usePendingApprovals` and the SSE liveness from `apps/client/src/layers/features/approvals/`. Approve and deny happen IN PLACE: the card resolves with a checkmark and the count melts (use `motion`, respect reduced motion). The feature slice stays where it is; the widget COMPOSES it — do not copy the approval logic into the widget.
2. **The never-fail-silent rule survives unchanged**: a failed approvals fetch renders the loud `ApprovalsUnavailable` card with its retry. Silence on failure is not acceptable here — an approval the user never sees is a blocked agent.
3. **Needs attention** — the second card group: stalled sessions, failed runs, dead letters, offline agents. Same `useAttentionItems` heuristics from `apps/client/src/layers/features/dashboard-attention/model/use-attention-items.ts`; each row deep-links, and the existing detail sheets move here with it.
4. **Both groups render ZERO DOM when empty.** With nothing waiting and nothing wrong, the header collapses to just the presence strip (task 2.4). No empty-state cards, no "all clear" chrome.
5. Sticky positioning that survives feed scroll on desktop and mobile without covering the composer; 44px touch targets; no page-level horizontal scroll at 375px.

ACCEPTANCE / TESTS

- RTL: approve-in-place resolves the card and decrements the count without a full refetch flash.
- RTL: approvals fetch failure renders `ApprovalsUnavailable` with a working retry.
- RTL: with zero approvals and zero attention items, neither group emits any DOM node (assert on absence, not on a hidden class).
- RTL: an attention row navigates to its deep link.
- Add the header to the Dev Playground per the `maintaining-dev-playground` skill.
- Grep for every test mounting `PendingApprovalsSection` or `NeedsAttentionSection` and re-run them.
- Changelog fragment.

### Task 2.4: Build the presence strip — who is working, and following in as a viewer

- **Size:** medium · **Priority:** high
- **Depends on:** 0.4, 2.1
- **Can run alongside:** 2.2, 2.3
- **Active form:** Building the presence strip

The bottom line of the pinned header: avatars of the agents currently working, and what each is bound to. Presence is who is online, not a kanban column.

WHAT TO BUILD

- A `PresenceStrip` component in `apps/client/src/layers/widgets/home/`, fed by the existing presence signals (RP9, shipped): `working` / `working_late` states plus the `busyWith` binding. Reuse `IdentityAvatar` from the identity kit and the presence copy helpers already used by `RoomPresenceLine` (`apps/client/src/layers/widgets/room-view/ui/RoomPresenceLine.tsx`, `lib/presence-copy.ts`) — one presence vocabulary, not two.
- One-liner per agent in the shape "tangerines · replying in #release-train". Where a runtime cannot report a binding truthfully, **the strip omits rather than lies** (this is why task 0.4 puts presence into the runtime conformance suite).
- Clicking an avatar FOLLOWS INTO that room or session as a VIEWER — watch, not hijack. This is an agent-etiquette rule: opening someone's work must not claim their session or interrupt a turn. Verify the session lock (`X-Client-Id`) is not taken by the follow.
- When nobody is working, the strip renders a quiet single line, not a large empty block.
- Hover reveals the identity hover card (`IdentityHoverCard`) — reuse, do not fork.

ACCEPTANCE / TESTS

- RTL: the strip renders from presence events; a `working` event adds an avatar, an idle event removes it, with no refetch.
- RTL: an agent whose runtime reports no binding renders the name with no fabricated activity line.
- Following an agent navigates to the bound room/session and does NOT acquire the session lock.
- Add to the Dev Playground with working / working_late / idle / no-binding states.
- Changelog fragment.

### Task 2.5: Swap / to the #team room and delete the dashboard — one PR, no feature flag

- **Size:** xl · **Priority:** high
- **Depends on:** 2.1, 2.2, 2.3, 2.4, 1.1, 1.4
- **Can run alongside:** —
- **Active form:** Swapping / to the #team room and deleting the dashboard

The decision is explicit: **no feature flag** (early beta, building in public). The home tab shows the room the moment this merges, and the dashboard goes with it in the same PR. Absorbed pieces MOVE; nothing duplicates.

WHAT TO BUILD

1. **`/` renders the #team room through the existing `room-view` machinery** — timeline, thread panel, mention picker, presence line, halt (`apps/client/src/layers/widgets/room-view/`). Do NOT fork the room widget: `/channels?id=<team>` must remain a valid alias rendering the same widget. Resolve the room by the well-known key added in task 2.1.
2. **The room composer here is the full `Composer.*` compound family** (`apps/client/src/layers/features/composer/`), attachments included — consumed as-is. Rich text (DOR-948) and room attachments (DOR-947) are separate in-flight specs; this must not fork the family.
3. **Mount the pinned triage header (2.3) and presence strip (2.4)** above the feed, and carry the Jump back in popover (1.4) onto this composer.
4. **Delete the birth-a-session path.** `apps/client/src/layers/widgets/dashboard/ui/DashboardComposerSection.tsx` birthed a throwaway session per message. Posting in #team is a room post — no navigation, no morph away from the room; the URL is already the room. Agent creation lives on `/team` and in conversation, not on the composer.
5. **Delete `DashboardPage` and the whole `apps/client/src/layers/widgets/dashboard/` slice**, including `dashboard-contributions.tsx`'s built-in entries for `composer`, `pending-approvals`, `needs-attention` and `recent-activity` (the Activity tab IS the feed — the 15-item `RecentActivityFeed` preview in `apps/client/src/layers/features/dashboard-activity/` goes too). Remove the Phase 1 dashboard placeholder from the Home tab in the same change. No dead code, no commented-out sections, no orphaned tests.
6. Run `pnpm knip` (build dists first) and delete everything it flags as newly orphaned.

ACCEPTANCE / TESTS

- Opening `/` shows the #team room: header only when something needs the user, presence strip, feed, composer.
- `/channels?id=<team>` renders the same widget with no duplicated component tree.
- Posting from the home composer creates a room entry and triggers the default agent (task 2.2) — no session is born, verified by session count before and after.
- The first open of the day is choreographed with `motion`: the greeting settles first, then content; reduced-motion users get it instantly with no animation.
- Room stream failure paths still use the existing self-healing stream and notices; an agent that cannot take a turn still writes a visible notice (RP1).
- `apps/client/src/layers/widgets/dashboard/` no longer exists; no import in the repo references it.
- Re-run every client test that mounted a dashboard section or the router.
- Drive it in a real browser at 375px, tablet and desktop before opening the PR.
- Changelog fragment written for a human: the home screen is now your team's room.

### Task 2.6: Day-one starter chips and the honest quiet state

- **Size:** medium · **Priority:** medium
- **Depends on:** 2.5
- **Can run alongside:** 2.7
- **Active form:** Building day-one and quiet states for the room

Two states the room must handle gracefully: the very first open, and a morning when nothing happened. Never fake a recap.

WHAT TO BUILD

1. **Day one.** #team contains only DorkBot. Onboarding is a CONVERSATION, not an empty board: starter chips render above the composer, reusing the existing suggestion-chip pattern already in the codebase (grep the onboarding / chat feature slices for the shipped chip component — do not build a second one). Chips seed a first message into the composer; they are not links to a wizard.
2. **Quiet morning.** No invented content. The room shows **"All quiet."** plus a forward-look line built from REAL data only: the next scheduled run (from the tasks entity) and the oldest item still waiting on the user (from the approvals / attention data the header already holds). Render it as a lightweight system post in the feed or a header line — pick one and be consistent; do not render both.
3. If neither a next run nor a waiting item exists, the forward-look line is omitted entirely rather than padded with a generic sentence.
4. Copy follows the `writing-for-humans` skill: plain, no hype, no exclamation marks, describes what happens for the user.

ACCEPTANCE / TESTS

- RTL: with zero room entries and only DorkBot as a member, the starter chips render and clicking one populates the composer with that text (and does not send it).
- RTL: with entries but none since the last visit and no scheduled runs and no waiting items, the quiet state shows "All quiet." and NO forward-look line.
- RTL: with a scheduled run tomorrow, the forward-look line names it with a real time.
- No test asserts on invented or hardcoded summary text — the forward look must be derived from fixture data.
- Changelog fragment.

### Task 2.7: End-to-end, docs, and product media for the room-as-home

- **Size:** medium · **Priority:** medium
- **Depends on:** 2.5
- **Can run alongside:** 2.6
- **Active form:** Adding e2e, docs, and media for the room-as-home

Prove the new home in a real browser, document it, and refresh the marketing and docs media that this change makes stale.

E2E (Playwright, `apps/e2e/tests/`) — follow the `browser-testing` skill:

- Home loads as the #team room: the feed, composer and (when seeded) the pinned header are present at `/`.
- Approve-from-header round trip: seed a pending approval, approve it from the home header, confirm it resolves in place and the count drops.
- Posting an unaddressed message from the home composer creates a room entry and does not navigate away.
- The presence strip renders a working agent and following it opens the bound room as a viewer.

DOCS (Fumadocs, `docs/`)

- `docs/concepts/rooms.mdx`: add #team — what it is, who is in it, why it cannot be deleted, and that new agents join it automatically.
- Home-surface concept page: the home IS the room; where the old dashboard's information went (approvals and attention are in the header; activity is the Activity tab; agent cards are the presence strip, sidebar roster and `/team`).
- Follow `writing-for-humans` throughout.

PRODUCT MEDIA

- The dashboard screenshots on the marketing site and in docs are now wrong. Regenerate captures through the `capturing-product-media` flow (`apps/e2e/capture` + the shot registry). Never hand-place files in `apps/site/public/product/`.

ACCEPTANCE

- Playwright specs pass against a real build.
- Prove a check can fail: break the header mount, watch the approve-from-header spec go red, revert.
- `docs:coverage` passes; no MDX file references the deleted dashboard.
- Captures regenerated and the registry updated in the same PR.
- Changelog fragment.

---

## Phase 3 — Read-state unification

### Task 3.1: Add the read_cursors table as the one user-side read-state store

- **Size:** medium · **Priority:** high
- **Depends on:** 0.3
- **Can run alongside:** 2.1, 2.3
- **Active form:** Adding the read_cursors table

One table replaces two disagreeing mechanisms. Today chat sessions use a per-browser localStorage watermark and rooms use a server-side `last_read_seq` whose writes are never broadcast, so a second device only catches up on the 30s poll.

WHAT TO BUILD

- New Drizzle schema `read_cursors` in `packages/db/src/schema/` (new file, exported from `packages/db/src/schema/index.ts`):
  - `user_id` (text), `thread_kind` (text, one of `room` | `session` | `inbox`), `thread_id` (text), `last_read_seq` (integer), `updated_at`.
  - Composite primary key or unique index on `(user_id, thread_kind, thread_id)`.
- **Per-user by construction.** The `user_id` column is not optional and not a placeholder: multi-human rooms get correct per-person state the day they exist, and there are no cross-user reads.
- Migration file generated through the repo's normal Drizzle flow. It creates the table only — data migration lands in tasks 3.3 and 3.4.
- A thin service in `apps/server/src/services/` owning get/set for cursors, with the invariant that a cursor never moves BACKWARD (a set below the stored value is a no-op, not a write).
- **Do not touch the agent cursor.** `room_members.last_read_seq` remains the AGENT-side cursor that RP3 advances; `read_cursors` is the USER-side table. They are different concerns and both survive.

ACCEPTANCE / TESTS

- Unit: set/get round trip; monotonic guard (a lower seq is ignored); distinct users in the same thread hold independent cursors; distinct `thread_kind` values with the same `thread_id` do not collide.
- The migration applies cleanly to a populated dev database and is idempotent on re-run.
- `pnpm --filter @dorkos/db typecheck` and `pnpm --filter @dorkos/server typecheck` clean.
- Changelog fragment.

### Task 3.2: Ship PUT /api/read-cursors/:kind/:id with a broadcast on every write

- **Size:** medium · **Priority:** high
- **Depends on:** 3.1
- **Can run alongside:** —
- **Active form:** Shipping the read-cursors route with broadcast

One route, one bus event, no polling.

WHAT TO BUILD

- `PUT /api/read-cursors/:kind/:id` in a new route module under `apps/server/src/routes/`, registered alongside the existing routers. Body carries `lastReadSeq`. `:kind` validates against `room | session | inbox` via a Zod schema in `packages/shared`; unknown kinds are a 400, not a silent accept.
- Auth: the same auth as the room routes; the cursor written is always the CALLER's — a caller can never write another user's cursor. No cross-user reads or writes are possible through this route.
- Express 5 semantics: `req.body` is undefined on an empty POST/PUT — handle that explicitly rather than destructuring blind.
- **Every cursor write broadcasts on `eventFanOut`** (the same bus task 0.3 used), carrying kind, thread id, and the new seq. Clients reconcile through TanStack Query cache updates; no new poll and no second stream.
- Add the event type to the shared event union AND the client's event allowlist — an unlisted event member is silently dropped.
- Regenerate OpenAPI with BOTH doc commands (the `openapi-fresh` gotcha) and confirm the `docs-openapi` check is green.

ACCEPTANCE / TESTS

- Server integration via `collectDurableEvents`: a successful PUT emits exactly one event with the expected kind, id and seq.
- A no-op write (seq at or below stored) emits NO event.
- An unknown `:kind` returns 400 with the standard error shape.
- An empty body returns 400 rather than throwing.
- OpenAPI includes the new route with its request and response schemas.
- Changelog fragment.

### Task 3.3: Migrate room human cursors onto read_cursors and wrap the CommunityAdapter seam

- **Size:** large · **Priority:** high
- **Depends on:** 3.2
- **Can run alongside:** 3.4
- **Active form:** Migrating room cursors and wrapping the community seam

Rooms move to the new table with a single write path — no dual-writing left behind.

WHAT TO BUILD

- Migrate the HUMAN read cursor for rooms off `room_members.last_read_seq` onto `read_cursors` (`thread_kind: 'room'`). Backfill existing human memberships in the migration. **The agent cursor stays on the membership row** — RP3 is agent-side, this table is user-side.
- Move every reader of the human cursor to the new table: `apps/server/src/services/rooms/room-service.ts:1082` (the sidebar unread map, built from `listMembershipsFor(viewerAuthorId)`) and the `room-service.ts:419,434` unread-count readers scoped to the resolved caller.
- `PUT /api/rooms/:id/read-cursor` (`apps/server/src/routes/rooms.ts:330`) DELEGATES to the new cursor service so there is one write path. Keep the old route for back-compat until the client migrates, then REMOVE it — no lingering legacy. State the removal condition in the route's TSDoc so the follow-up is not forgotten.
- **Wrap the `CommunityAdapter` seam**: `getReadCursor` / `setReadCursor` on `packages/shared/src/community-adapter.ts` and the local backend in `apps/server/src/services/communities/local/` read and write the new table. The `readCursor` capability field and `communityConformance` gate must still pass — community-server compatibility is preserved, and nothing here builds a community server.

ACCEPTANCE / TESTS

- Server integration: mark-read through the old room route and through the new read-cursors route produce the same stored state and the same broadcast.
- Backfill: a database with existing `room_members.last_read_seq` values for a human ends with matching `read_cursors` rows and no lost unread state.
- Two users in one room hold independent cursors.
- `communityConformance` passes with the wrapped seam.
- An agent's RP3 cursor is unaffected by any user-side write (regression test — this is the one way to break RP3 from here).
- Changelog fragment.

### Task 3.4: Move chat sessions off the localStorage watermark onto read_cursors, with one UnreadDivider

- **Size:** large · **Priority:** high
- **Depends on:** 3.2
- **Can run alongside:** 3.3
- **Active form:** Moving chat sessions onto unified read cursors

Chat sessions today track "new messages" with a per-browser localStorage watermark, which is why a second device disagrees with the first. Move them onto the shared table and collapse the two divider implementations into one.

WHAT TO BUILD

- Chat sessions write and read `read_cursors` with `thread_kind: 'session'`, keyed by the session's monotonic SSE `seq` (the same `seq` the durable per-session stream `GET /api/sessions/:id/events` already emits). Delete the localStorage watermark code and its storage key entirely — no fallback, no dual-read.
- One-time client-side carry-over is NOT required (a watermark is cheap to lose); if a stale key remains in a user's browser it must be actively removed rather than left orphaned.
- **One `UnreadDivider` mechanism everywhere.** Today rooms and chats each render their own. Keep one component (promote it to the `shared` or `entities` layer as the FSD hierarchy `shared ← entities ← features ← widgets` requires) and delete the other. Both rooms and sessions feed it from the unified cursor.
- "New for you" in #team and the sidebar unread dot both read the unified cursor — no separate count path.
- Cursor advance rules: the cursor moves when the user has actually seen the entries (the existing frozen-cursor behaviour in `apps/client/src/layers/widgets/room-view/__tests__/use-frozen-read-cursor.test.ts` documents the intent — a divider must not vanish the instant you arrive).
- Cross-device: because every write broadcasts (task 3.2), a second tab clears its divider on push, not on a poll.

ACCEPTANCE / TESTS

- Unit: the divider position derives identically from a room cursor and a session cursor given the same shaped input.
- RTL: reading a session advances the cursor via the API, not localStorage; no `localStorage` key is written (assert on the storage mock).
- RTL: a broadcast cursor event from another device clears the divider without a refetch.
- Grep the repo for the old watermark key — zero hits outside the deletion commit.
- Re-run every test that renders `UnreadDivider` or its former twin, plus room and chat timeline tests.
- Changelog fragment: your unread marks now follow you between devices.

### Task 3.5: Remove the legacy room mark-read route and prove no dual write path survives

- **Size:** small · **Priority:** medium
- **Depends on:** 3.3, 3.4
- **Can run alongside:** —
- **Active form:** Removing the legacy mark-read route

Close the migration out. The spec is explicit: back-compat is kept until clients migrate, THEN removed — no lingering legacy.

WHAT TO BUILD

- Remove `PUT /api/rooms/:id/read-cursor` (`apps/server/src/routes/rooms.ts:330`) now that every client writes through `PUT /api/read-cursors/:kind/:id`. Remove its tests, its OpenAPI entry, and the delegation shim added in task 3.3.
- Audit for any remaining second write path to read state: grep `setReadCursor`, `lastReadSeq`, `last_read_seq`, and the deleted localStorage key across `apps/`, `packages/`, and `apps/obsidian-plugin/`. The only survivors should be (a) the unified cursor service and (b) the RP3 agent-side advance on the membership row.
- Verify the Obsidian embedded surface (which uses `DirectTransport`, not `HttpTransport`) writes cursors through the same service — embedded mode bypasses the router but must not bypass read state.
- Regenerate OpenAPI with both doc commands.

ACCEPTANCE / TESTS

- A request to the removed route returns 404; no client code references it.
- Grep audit documented in the PR description with the surviving call sites enumerated.
- `communityConformance` and the room/session suites stay green.
- `pnpm knip` reports no orphaned modules from the removal.
- Changelog fragment.

### Task 3.6: End-to-end and docs coverage for unified read state

- **Size:** medium · **Priority:** medium
- **Depends on:** 3.5
- **Can run alongside:** —
- **Active form:** Adding e2e and docs for unified read state

Prove the cross-device promise in a browser, and write down the model.

E2E (Playwright, `apps/e2e/tests/`)

- Two browser contexts as the same user: reading a room in context A clears the unread mark in context B without a reload and without waiting for a poll interval.
- The same for a chat session.
- The unread divider appears in the right place after new entries arrive while the user is away, and does not vanish the instant the user arrives.
- Add to the existing `apps/e2e/tests/streams/` or `rooms/` suites where they fit.

DOCS

- `docs/concepts/rooms.mdx` and the sessions concept page: how "new messages" works now — one mark per person per conversation, shared across your devices, private (nobody sees what you have read).
- Be explicit about what is NOT built: social "seen by" read receipts are not shipped; cursors are private markers only.
- `contributing/architecture.md`: the `read_cursors` table as the single user-side read-state store, with `room_members.last_read_seq` retained as the agent-side RP3 cursor.
- Follow `writing-for-humans` for the docs pages.

ACCEPTANCE

- Playwright specs pass against a real build with two contexts.
- Prove a check can fail: disable the broadcast, watch the cross-device spec go red, revert.
- `docs:coverage` passes.
- Changelog fragment.

---

## Phase 4 — Moments + welcome-back

### Task 4.1: Add the moment post type and its distinct rendering in the feed

- **Size:** medium · **Priority:** medium
- **Depends on:** 2.5
- **Can run alongside:** 4.3, 4.6
- **Active form:** Adding the moment post type and rendering

A moment is a room entry, not a new persistence model. Build the type and the rendering first; the detectors that mint them follow in task 4.2.

WHAT TO BUILD

- A **moment** post type on `room_entries` — a variant of the existing entry shape (author, body, metadata), NOT a new table. Define the type in `packages/shared` so client and server agree, with the metadata a moment carries: a moment kind (first-agent, joined-team, first-pr, first-schedule, first-overnight-run, first-connection, volume-mark, anniversary, agent-minted) and the real data it was derived from.
- **Derived from real data only.** The type must not permit a moment without a data source reference; an agent-minted moment records which agent minted it.
- Rendering: a distinct entry style in the room feed — the identity kit (`IdentityAvatar`, `IdentityHoverCard`) plus a moment glyph from `@dorkos/icons`. Quiet and warm, not a confetti banner; follow `contributing/design-system.md` and the Calm Tech language. Reduced motion respected.
- Moments render in `apps/client/src/layers/widgets/room-view/ui/RoomEntryRow.tsx`'s existing dispatch, alongside notices and ordinary entries — no parallel timeline.
- Agent-minted moments ride the EXISTING guarded post path, so the cascade guard and turn budget bind them unchanged. No new write surface, no new tool.
- Copy follows `writing-for-humans`: "tangerines joined your team", not "🎉 New team member onboarded!".

ACCEPTANCE / TESTS

- Unit: a moment entry round-trips through the shared schema; an entry claiming to be a moment without a data source fails validation.
- RTL: a moment entry renders with the moment style and glyph and is distinguishable from an ordinary entry by an accessible label.
- An agent-minted moment is subject to the same cascade guard as any other agent post (server test).
- Add moment variants to the Dev Playground.
- Changelog fragment.

### Task 4.2: Ship the server-side moment detectors, each firing once from real events

- **Size:** large · **Priority:** medium
- **Depends on:** 4.1
- **Can run alongside:** 4.4
- **Active form:** Shipping the server-side moment detectors

Detectors live server-side in `apps/server/src/services/rooms/` and post to #team. They run on EXISTING event paths, not timers.

STARTER DETECTOR SET (build exactly these)

- **First agent created** — the user's first agent beyond DorkBot.
- **"X joined your team"** — on agent creation/registration (the canonical example: "tangerines joined your team").
- **First PR shipped**, **first schedule created**, **first overnight run**, **first Connection** — each fires once, ever, per install.
- **Weekly volume marks** — e.g. shipped every day this week, busiest day yet. These piggyback the existing activity aggregation rather than adding a timer.
- **Anniversaries** — one week / one month with an agent, 100th session, 1000th message.

RULES THAT BIND EVERY DETECTOR

- **Real data only.** A detector reads what actually happened; nothing is invented, rounded up, or projected.
- **Fires once.** Each first-of-its-kind detector needs durable idempotency (a persisted marker, not an in-memory flag) so a restart does not re-post it. Anniversaries fire once per anniversary.
- **Runs on existing event paths** — agent registration, activity ingest — except the daily volume marks, which ride the activity aggregation that already runs.
- Posts go to #team through the normal room post path, so room etiquette, the cascade guard, and the turn budget apply.
- Etiquette (`meta/agent-etiquette.md`): present, useful, and mostly quiet. Over-participation is the failure mode users complain about — if a day would produce several moments, they must not all land.

ACCEPTANCE / TESTS

- Unit per detector: fires on the real event, does NOT fire on a near-miss, and does not fire a second time after a simulated restart (assert against the persisted marker).
- A volume mark computed from fixture activity matches the fixture exactly — no test tolerates an approximate number.
- Integration: a burst of qualifying events in one minute does not produce a burst of posts.
- Server test asserting no detector runs on a timer of its own.
- Changelog fragment.

### Task 4.3: Add the welcomeBack config block with its semver migration and Settings toggle

- **Size:** medium · **Priority:** medium
- **Depends on:** nothing
- **Can run alongside:** 4.1, 4.6
- **Active form:** Adding the welcomeBack config and Settings toggle

Config first, so the posting logic in task 4.4 has a knob to read. Follow `contributing/configuration.md` and the `adding-config-fields` skill end to end — Zod field → defaults → conf migration → docs → tests.

WHAT TO BUILD

- New block on `UserConfigSchema` in `packages/shared/src/config-schema.ts`:

```
welcomeBack: {
  enabled: boolean (default true),
  absenceThresholdMinutes: number (default 240),
  maxPosts: number (default 3),
}
```

- **Zod is the authoritative schema**, and a schema change requires a **semver-keyed migration** in `apps/server/src/services/core/config-manager.ts` (see the existing `'0.44.0'` … `'0.57.0'` migration map). Key it to the release this ships in. The migration backfills the defaults into existing config files.
- Read-time conversion matters: `conf` only runs a migration when its key is in range, and in a dev tree the version resolves to `0.0.0` and NO migration runs at all. Correctness must not depend on the migration having run — the Zod defaults must produce a valid config on their own.
- **Settings toggle** in the existing Settings groups (`apps/client/src/layers/features/settings/ui/`): an on/off switch for welcome-back messages, plus the absence threshold if it fits the existing group's density. Start simple — **no per-agent knobs in v1**.
- Copy follows `writing-for-humans`: describe what happens for the user ("When you come back after a few hours away, your agents can post what changed"), not the mechanism.
- Docs: `docs/` settings page gains the welcome-back toggle.

ACCEPTANCE / TESTS

- Unit: a config file written before this change parses with the defaults applied; the migration applied to that same file writes the block explicitly.
- The migration is idempotent and does not clobber a user-set value on re-run.
- RTL: the Settings toggle reflects and writes the stored value.
- `pnpm --filter @dorkos/shared build` then re-run dependents — a stale `@dorkos/shared` dist causes false-red type errors elsewhere.
- Changelog fragment.

### Task 4.4: Ship welcome-back posting with hard caps — news, not noise

- **Size:** large · **Priority:** medium
- **Depends on:** 4.3, 2.5
- **Can run alongside:** 4.2
- **Active form:** Shipping welcome-back posting with caps

When the user returns after a REAL absence, agents active since they left may post to #team: one line plus a concrete offer.

THE IRON RULE: news, not noise. Every constraint below exists to enforce it.

WHAT TO BUILD

- Detect the user's return after an absence exceeding `welcomeBack.absenceThresholdMinutes` (default 240 — hours, never minutes). Absence is measured from the last real user interaction, not from a tab losing focus.
- Only agents that were **active since the user left** are candidates, and only those with a **real status delta** — an agent that did nothing new says nothing.
- **Caps**: at most `welcomeBack.maxPosts` (default 3) posts per return. One line each. Ordered by usefulness, not recency, when more than the cap qualify.
- **Cost discipline**: cheap status lines come from SESSION STATE without waking the agent. A model turn is spent ONLY when the agent has a genuine next-step offer to make ("Want me to open the PR?"). Never wake an agent just to say it is still working.
- Gate on `welcomeBack.enabled`; when off, no detection work runs at all.
- Posts ride the normal room post path into #team, so the cascade guard, turn budget and etiquette rules apply unchanged.
- Implementation lives in `apps/server/src/services/rooms/`, beside the moment detectors.

ACCEPTANCE / TESTS

- Unit gate logic: absence below the threshold produces nothing; absence above it with zero deltas produces nothing; five qualifying agents produce exactly `maxPosts` posts.
- No-delta agents are excluded — assert the runtime double records ZERO turns for them.
- An agent with a status line but no offer produces a post with NO model turn spent (assert on the runtime double, not on logs).
- `enabled: false` produces no posts and no candidate evaluation.
- Two returns in quick succession do not double-post the same news.
- Copy for the posts follows `writing-for-humans` and is generated from real state, never templated optimism.
- Changelog fragment.

### Task 4.5: Add DorkBot's single quiet-state suggestion as the promo grid's successor

- **Size:** small · **Priority:** low
- **Depends on:** 2.6, 1.5
- **Can run alongside:** 4.2, 4.4
- **Active form:** Adding the quiet-state DorkBot suggestion

The retired `dashboard-main` promo grid (task 1.5) gets a tasteful successor: one gentle DorkBot suggestion in quiet states.

WHAT TO BUILD

- In a quiet state on the home room (nothing waiting, nothing wrong, no new entries), DorkBot may offer ONE suggestion — for example "want your agents working while you sleep?".
- **One line. Dismissible.** Dismissal is remembered so the same suggestion does not return the next morning.
- Source the candidate suggestions from the promo registry's existing qualification logic where it fits (`apps/client/src/layers/features/feature-promos/model/promo-registry.ts`, `use-promo-context.ts`, `use-first-use-date.ts`) — reuse the qualification rules rather than writing a second eligibility system. Only surface a suggestion the registry says the user actually qualifies for.
- It renders as part of the quiet state built in task 2.6, below "All quiet." and the forward-look line — never alongside real content, never when the header has something waiting.
- No dark patterns: it is a suggestion, not an upsell; dismissing it must be as easy as accepting it, and there is no second nag.

ACCEPTANCE / TESTS

- RTL: in a quiet state with a qualifying promo, exactly one suggestion renders; with two qualifying promos, still exactly one.
- With nothing qualifying, no suggestion renders and no empty container is emitted.
- Dismissing hides it and it does not return on remount.
- With a pending approval in the header, no suggestion renders at all.
- Changelog fragment.

### Task 4.6: Audit the Settings Tools tab can actually toggle Tasks and Relay off

- **Size:** small · **Priority:** low
- **Depends on:** nothing
- **Can run alongside:** 4.1, 4.3
- **Active form:** Auditing the Tasks and Relay settings toggles

Verified 2026-08-08: Tasks and Relay are ALREADY `enabled: true` by default in `packages/shared/src/config-schema.ts` (`relayTools`, `meshTools`, `adapterTools`, `tasksTools` all default true, ~line 961). No defaults flip is needed. The remaining work is a toggle audit.

WHAT TO DO

1. Open `apps/client/src/layers/features/settings/ui/ToolsTab.tsx` (and `ui/tools/`) and confirm a user can turn BOTH Tasks and Relay OFF from the UI. The tab already READS both flags; confirm it can WRITE them.
2. Where a toggle is missing, add it — same control pattern and grouping as the toggles already there, with copy that follows `writing-for-humans` (say what turning it off means for the user, not which flag it sets).
3. **Leave `resolveTasksFiring` alone.** The non-production scheduled-firing gate is CORRECT: it gates cron firing in dev so a dev tree does not fire real schedules. Flipping it is explicitly out of scope for this program. Do not "fix" it.
4. Confirm turning a tool off actually stops the capability being offered to agents (not just a stored boolean) — trace one flag from the toggle to the runtime tool list.

ACCEPTANCE / TESTS

- RTL: the Tools tab renders toggles for Tasks and Relay; toggling each writes the config and reflects the stored value on remount.
- A server test asserting a disabled flag removes the corresponding tools from what an agent is offered.
- `resolveTasksFiring` is untouched — confirm by diff.
- Changelog fragment only if a toggle was added; otherwise the PR carries `skip-changelog`.

### Task 4.7: End-to-end, docs, and programme close-out for moments and welcome-back

- **Size:** medium · **Priority:** medium
- **Depends on:** 4.2, 4.4, 4.5, 4.6
- **Can run alongside:** —
- **Active form:** Closing out moments and welcome-back with e2e and docs

Prove the emotional layer never lies, document it, and close the programme out.

E2E (Playwright, `apps/e2e/tests/`)

- Creating an agent produces exactly one "joined your team" moment in #team, styled as a moment.
- Simulated return after an absence produces at most three welcome-back posts and none from agents with no delta.
- With welcome-back disabled in settings, a return produces zero posts.
- The quiet state renders "All quiet." plus at most one DorkBot suggestion.

DOCS

- `docs/`: a page or section on moments and welcome-back — what they are, that they only ever come from things that really happened, and how to turn welcome-back off. Follow `writing-for-humans`.
- Settings docs updated with the welcome-back toggle and the absence threshold.
- `docs/concepts/rooms.mdx`: moments are room entries, not a separate feed.

CLOSE-OUT

- Confirm every Documentation-section requirement of `specs/team-room-home/02-specification.md` is satisfied: home-surface concept page, rooms concept (#team), settings (welcome-back toggle), `contributing/architecture.md` + extension-api `dashboard.sections` re-homing, `plans/language-ia-simplification.md` addendum, OpenAPI regenerated for every new route, changelog fragments present per PR.
- Confirm every non-goal stayed out: no RP6/RP7/RP8 tools, no community servers, no kanban, no generic widgets, no social read receipts, no fork of the `Composer.*` family, no Obsidian embedded-mode redesign.
- Run `pnpm verify` and `pnpm knip` (build dists first); resolve anything they flag.

ACCEPTANCE

- Playwright specs pass against a real build.
- Prove a check can fail: make a detector fire twice, watch the moment spec go red, revert.
- `docs:coverage` passes.
- Changelog fragment.
