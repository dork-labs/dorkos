---
slug: team-room-home
status: In Progress
started: 2026-08-08
last-updated: 2026-08-08
---

# Implementation: The home is a room (#team)

**Status:** In Progress
**Tasks Completed:** 24 / 31 — P0 (4/4, merged #868), P1 (7/7, merged #874), P2 (7/7, this
branch), P3 (6/6, merged into this branch). P4 has not started.

## Sessions

### Session 1 - 2026-08-08

**Orchestrator:** Claude Code session c94c2d2a (host: Dorian's machine)
**Workers:** _(recorded per task below)_

Phase worktrees:

- P0: `/Users/doriancollier/.dork/workspaces/dorkos/trh-p0` → branch `feat/team-room-home-p0-foundations`
- Spec docs: `/Users/doriancollier/.dork/workspaces/dorkos/trh-specify` → branch `docs/team-room-home-specify` (PR #866)

Linear: project Team Room Home; umbrella DOR-1026; phases DOR-1027 (P0, claimed), DOR-1028 (P1),
DOR-1029 (P2), DOR-1030 (P3), DOR-1031 (P4); xl swap DOR-1033; RP3 = DOR-665 (claimed).

Assumptions logged:

- Task-API projection is per-phase, not per-task (context economy; canonical descriptions in
  03-tasks.json which workers read directly).
- Task 0.2 (ADR promotion) held by the orchestrator until PR #866 merges, to avoid a same-file
  conflict with the draft ADRs that PR introduces.
- Task 0.4 scope-guarded away from apps/server/src/services/rooms/ (task 0.1 owns that area
  concurrently).

Tasks completed:

- Task #0.1: RP3 ambient pending context (DOR-665) — worker: opus implementation agent; commit
  64b3782e1. Two-stage adversarial review passed. Design notes: third clamp is a SQL LIMIT on
  qualifying entries (a literal seq floor undercounts when exclusions remove positions);
  listUnreadEntries gained a throughSeq ceiling (no double-show across the claim-time cursor
  advance); cursor advance sits in claimTargets immediately before holdClaim, monotonic.
- Task #0.4: presence truthfulness in runtimeConformance — worker: opus implementation agent;
  commit 8ba4d0585. Review round 1 found two criticals (inert gate: sendMessage never fed the
  projector; empty-array turn passed as "shown") — both fixed via drivePresenceTurn through the
  real getOrCreateProjector/feedProjector seam and a non-empty-turn rule; round 2 passed, one
  new finding (N1 false-red on honest blocked-mid-turn) fixed by narrowing the else-arm to
  idle-only. All proofs seeded-and-reverted in test-mode.

- Task #0.3: read-cursor broadcast (room_read_cursor on eventFanOut, cancel-then-min client
  reconciliation) — worker: opus implementation agent; commit "read state follows you between
  devices". Review passed with 2 importants (route-level exactly-one-frame proof; list-badge
  race vs in-flight refetch) — both fixed with red-then-green evidence. **Superseded within the
  same release train by task 3.3**: `room_read_cursor` was replaced by the unified `read_cursor`
  event before it ever shipped, so there is no back-compat window and no second name to keep
  alive. The client reconciliation (cancel-then-min list patch, Math.max detail patch) survives
  unchanged on the new event.
- Task #0.2: thread-over-sessions ADR 260808-140954 draft→accepted — orchestrator, after the
  branch rebased onto post-#866 main.

Phase 0 complete: 4/4. Phase 1 complete: 7/7 (tasks 1.1-1.7: tab shell, Jump back in + the
room-origin overlay, sidebar 7→4 + viewport-safe tours, composer popover with shared identity
marks, dashboard slimmed + extensions on Activity, 50 e2e tests incl. 375px + keyboard gates).
Every task two-stage adversarially reviewed; criticals fixed red-then-green (hollow
active-state tests, mobile tour death, room-turn double-listing, unreachable popover, DM
letter-disc regression, dishonest week summary). Follow-ups: DOR-1036 (parallel branch),
DOR-1039 (summary subject mismatch), promo dead-code on DOR-1031. Product-media cockpit shot
stale — regen after merge. 31-task programme: 11 done; P3 running in parallel.

- Task #2.1: `ensureTeamRoom()` — #team opened once per install on `rooms.well_known = 'team'`,
  owner + DorkBot seated, every registered agent backfilled at boot and seated on creation via
  the `agent-created` seam, system-room guard on rename/archive/delete. Commit 2ad51586b.
- Task #2.2: the fallback seat — the default agent holds `always` on its #team membership,
  `standDownFallbackSeat` in `addressing.ts` filters it out whenever a post names somebody, and
  `watchDefaultAgent` re-points it when the setting moves. Commit 9f75e35b9.
- Task #2.3: the pinned triage header — Waiting On You + Needs Attention above the scroller,
  answered in place (✓ held, then melt), zero DOM when empty, empty live region always.
  Commit 654d9e153.
- Task #2.4: the presence strip — up to five rows plus a fold, room claims joined with fleet
  streaming sessions, omit-rather-than-lie on a missing binding, click follows as a viewer.
  Commit 9a4467013.
- Task #2.5: the swap — `/` renders #team through `RoomSurface` (one tree; `/channels?id=` is
  still the same widget), the dashboard slice and the birth-a-session composer deleted with
  every orphan swept. Commit 2aa5a1bb0.
- Task #2.6: day-one chips and the quiet state — starter chips that draft rather than send and
  clear at the first keystroke, "All quiet." gated on a cursor frozen at mount so it can never
  claim quiet over a live conversation, and the phone-only header collapse to a one-line count
  summary while the composer has focus. Commit 6adee3dfa.
- Task #2.7: e2e, docs and product media — this task. See below.

### Task #2.7 — e2e, docs, media, and the phase's visual gate

**E2E.** `apps/e2e/tests/home-surface/team-room.spec.ts` (8 tests, all passing) plus
`fixtures/team-room-api.ts` and a new `chromium-team-room` Playwright project. It covers: `/`
opens the room and `/channels?id=` draws one masthead not two; an unaddressed post reaches the
fallback seat and exactly one agent answers; naming an agent stands the default agent down; the
header draws zero DOM when nothing waits; an approval is answered from home and resolves in
place before the count drops; `/?detail=` still opens its sheet; the presence strip shows
somebody working elsewhere and follows them; an archived #team offers to be brought back and
does not un-archive itself. The approve-from-header check was proved able to fail: unmounting
`PinnedTriageHeader` turned it red at the header assertion, then it was reverted.

Two decisions in that file are load-bearing rather than incidental:

- **It runs against the TEST-MODE leg, and that is a safety property.** DorkBot holds #team's
  `always` seat and its manifest names `claude-code`; the cockpit leg registers the real Claude
  Code runtime, so one `Enter` in the home composer starts a real, billable turn against
  whatever `claude` sign-in the machine has. There is no key to withhold that prevents it. The
  spec is `testIgnore`d out of the `chromium` project for that reason.
- **A pending approval is seeded through `POST /api/shapes/:name/apply` with a nonsense
  `X-DorkOS-Agent` header.** The gate runs before the Shape is resolved and refuses any caller
  presenting an agent identity, so an uninstalled Shape name still produces a real approval and
  still cannot do anything.

**Docs.** `docs/concepts/rooms.mdx` gained the #team section; the home-surface story went on
`docs/getting-started/what-is-dorkos.mdx` (no home concept page existed) with the explicit
dashboard mapping; the glossary Cockpit entry now says what Home is; `mesh.mdx`,
`marketplace/index.mdx` and `marketplace/publishing.mdx` lost the "dashboard" name for a screen
that no longer exists. Changelog history left alone as history.

**Product media.** Regenerated through the pipeline (record + process, exit 0, 23 shots, no
skips). Only one shot photographs `/` (`cockpit` → `cockpit-light.png`), but the pipeline has
no per-shot publish, so all 45 assets were refreshed. The new shot is honest but empty ("Nothing
said here yet") — inhabiting the room means driving a real turn, which is recorded as a TSDoc
note on `shootCockpit`. It will be stale again the moment task 2.6 lands.

Phase 2 complete: 7/7. **Task 2.6 was in flight in this same worktree while 2.7 ran**, so the
media note above and the visual-gate findings below were both written before it landed — the
cockpit shot is stale by exactly that commit.

## Files Modified/Created

See commits 64b3782e1 (0.1: packages/db migration 0057, packages/shared room-schemas,
apps/server/src/services/rooms/\*, 29 client fixture files, openapi.json, changelog fragment)
and 8ba4d0585 (0.4: packages/test-utils runtime-conformance + presence tests,
session/**tests**/durable-turn-harness.ts, four runtime conformance wirings,
contributing/adding-a-runtime.md).

## Known Issues

- Presence conformance gates the runtime layer (lifecycle + cwd binding); the room-level
  busyWith/working_late half is RP9's territory and NOT covered by this gate — Phase 2's
  presence strip must not assume otherwise (review finding I3, accepted as scope).
- claude-code's binding rules are skipped in the mocked-SDK suite (getSession honestly null,
  no JSONL on disk) — disclosed in adding-a-runtime.md.

### Found by task 2.7's visual gate, not fixed here

- **At 375px with the software keyboard up, the pinned triage header pushes the composer off
  the screen.** This is the case `PinnedTriageHeaderView`'s `MAX_HEIGHT` TSDoc explicitly
  deferred to this gate, and it is real. Measured in Chromium at 375×812 with the visual
  viewport shrunk by 336px (an iPhone SE / mini class keyboard), driving the shipped
  `useVisualViewportBottomInset` path: with **one** approval waiting the composer's bottom sits
  at 604.8 against a visual-viewport bottom of 476 — **129px behind the keyboard**; with two or
  more, the header hits its `40svh` cap (325.8px) and the composer sits **227px** behind it,
  with the feed gone entirely. Keyboard closed, every count is correct (composer bottom 812,
  fully visible). Screenshots show the approval card's own Allow/Deny row clipped at the fold.

  The mechanism: `RoomSurface`'s phone branch insets the column by the keyboard delta, but the
  header is a `shrink-0` sibling capped in `svh`, which does not shrink with the visual
  viewport — so header + composer overflow the padded content box and the composer is what
  goes under. Not fixed in this task: the correct fix is a product decision about what a
  triage header should do while somebody is typing (shrink to a summary, or cap against the
  REMAINING viewport rather than the small one), it touches a file task 2.6 was editing
  concurrently, and it needs its own unit coverage. Needs a ticket.

- **`POST /api/mesh/agents` does not seat a new agent in #team.** Only `POST /api/agents` and
  `createAgentWorkspace` notify the `agent-created` seam that calls `joinTeamRoom`. Verified
  against a live server: an agent registered through the mesh route was absent from the roster,
  the same agent created through the agents route was seated `engaged` within a second. The
  boot backfill in `ensureTeamRoom` eventually catches it, so nothing is permanently lost, but
  D3.1's "a new agent is in your team room by the time you can look at it, without a restart"
  is false for the discovery-scan and mesh-register paths. Needs a ticket.

- **The header's internal scroll has no overflow affordance.** At its cap the last approval
  card is cut mid-row with no fade or shadow saying more is below. Cosmetic, visible on desktop
  at five or more approvals.

- **Legacy naming, not a defect:** `apps/e2e/tests/dashboard-sidebar/` and
  `pages/DashboardSidebarPage.ts` still say "dashboard" for what is now just the sidebar.
  Nothing is broken (they were swept and pass), but the name outlived the screen. Renaming
  moves manifest keys, so it wants its own change.

## Phase 3 — Read-state unification (D4)

**Worktree:** `/Users/doriancollier/.dork/workspaces/dorkos/trh-p3` → branch
`feat/team-room-home-p3-read-state`. Linear DOR-1030.

**Commits:** `968b674eb` (3.1 + 3.2), `28e327f97` (3.3 + 3.4), plus the closing commit carrying
3.5 + 3.6.

Tasks completed:

- **3.1 + 3.2 — the store and its route.** `read_cursors(user_id, thread_kind, thread_id →
last_read_seq, updated_at)`: composite PK, CHECK-guarded kinds, non-negative seq, monotonic
  compare-and-skip writes. `PUT/GET /api/read-cursors/:kind/:id` validates through shared Zod and
  refuses a non-human caller with `PEOPLE_ONLY` — agents keep the RP3 cursor on the membership
  row. Broadcasts `read_cursor` on the global stream only when the stored value actually moved.
  `openSseStream` extracted into `@dorkos/test-utils`.
- **3.3 + 3.4 — rooms and chats onto one cursor.** Humans moved off `room_members.last_read_seq`
  (one-time backfill, migration 0061). `room_read_cursor` superseded by the unified `read_cursor`,
  which carries a lazily-computed unread count for rooms. Chat sessions dropped the localStorage
  watermark for a transcript-position cursor sharing `unreadPlacement` with rooms, behind a
  session-scoped write queue. Obsidian keeps its divider through a vault-local store behind the
  Transport seam. `CommunityAdapter` reads and writes the same store.
- **3.5 — the legacy route removed.** `PUT /api/rooms/:id/read-cursor` is gone, with every
  consumer migrated (see the amendment below).
- **3.6 — proof and prose.** Cross-device e2e
  (`apps/e2e/tests/rooms/read-state-cross-device.spec.ts`, 2 tests), the docs pages, and this
  record.

### Amendment to D4: the delegation runs the other way

The spec says "room mark-read route delegates to it". The implementation inverted that: the
GENERIC route delegates into `RoomService.setReadCursor`, not the reverse.

The reason is that only the rooms domain can answer two questions the read-state layer has no way
to ask — may this caller see this room, and what is the unread count now. A generic route that
stored a bare number would emit a `read_cursor` frame the room list has nothing to patch with, so
the badge would stay lit on the reader's second device: the precise failure D4 exists to fix. A
`session` or `inbox` cursor has no such domain and lands straight on the table.

The spec's intent — one write path, no lingering legacy — is met, and more strictly than the
literal wording would have: there is one implementation and now also one URL.

### Task 3.5: removed rather than kept as an alias

Task 3.5 assumed the room route was a shim to delete once clients migrated. It was not a shim —
after 3.3 both URLs already reached one implementation — so the decision was whether a second URL
earned its place. It did not, and the argument that had kept it (written into `rooms.ts` during
3.3) turned out to cut the other way.

That argument was that the generic route is people-only, so the room route was the only way an
AGENT's cursor could move. True, and unexercised: no client, no MCP tool and no capability ever
called it. What an agent has been shown is advanced in-process by the ambient participation loop
(`room-trigger.ts`) as entries are actually delivered. So the route was not a capability agents
used; it was a way for an agent to claim it had been shown entries it never received. Removing it
closes that rather than taking anything away. `RoomService.setReadCursor`'s agent branch survives
untouched, reached by the ambient loop and by `CommunityAdapter`.

Consumers migrated: `useMarkRoomRead` and `useMarkRoomReadNow` now call
`transport.setReadCursor('room', …)`; `setRoomReadCursor` is gone from the `Transport` interface,
the HTTP transport, the embedded stubs and the mock factories; `SetReadCursorRequestSchema` went
with it. The OpenAPI path and its generated MDX are regenerated away.

**Grep audit — the surviving write paths onto read state, and only these:**

1. `ReadCursorService.advance` — the unified store. Reached from `routes/read-cursors.ts` and from
   `RoomService.setReadCursor` (person branch).
2. `RoomStore.setReadCursor` — the agent-side RP3 cursor on the membership row. Reached from
   `room-trigger.ts` (ambient delivery) and `RoomRoster.setReadCursor` (agent branch). No route
   reaches it.
3. `createLocalReadCursorMethods` — the embed's vault-local store, behind the Transport seam.
4. `CommunityAdapter.setReadCursor` → `RoomService.setReadCursor`, i.e. path 1 or 2.

The retired `dorkos:chat:last-seen:*` localStorage prefix survives only inside
`purgeLegacyWatermarks`, which deletes it and never reads a value back.

**Embedded mode does not bypass read state.** `createEmbeddedStubMethods` spreads
`createLocalReadCursorMethods()` after `roomStubs`, so `DirectTransport` gets the real vault-local
store rather than a throwing stub — verified by
`apps/client/src/layers/shared/lib/direct/__tests__/read-cursor-methods.test.ts` (7 tests, green).

### Verification

- **Seeded-defect proof.** Commenting out `eventFanOut.broadcast('read_cursor', moved)` turned the
  cross-device spec red at exactly the assertion it exists for (device two still reading
  `#slug 3 unread` after device one read the room), while the cold-open spec stayed green — the
  two tests fail for different reasons, which is what makes each one worth having. Reverted.
- The room list has no `refetchInterval` anywhere in `entities/room`, so the only thing that can
  clear the second device's badge is the broadcast. That is what makes the assertion mean
  something rather than merely pass.

### Known gaps

- **The chat cross-device story has no browser coverage.** Chat sessions need a runtime, and the
  cockpit leg the room specs run against would spend real money; the test-mode leg's
  `chromium-mock` project is deliberately a single spec file (shared mutable server state), so
  adding a session-cursor suite there is a config change this task did not make. The behaviour is
  covered at unit level — `use-unread-cursor.test.tsx` "clears the rule when the same person reads
  the session on another device", plus the ignore-my-own-echo and wrong-thread cases — and the
  route half by `read-cursors.test.ts`. Worth a follow-up.
- **"The divider survives a reload at the same position" was not written, because it is not the
  behaviour.** Reading a session to the end advances the cursor, so a reload correctly shows no
  rule. What ships is the in-view hold ("the line does not vanish under you while you are
  reading"), covered by `use-unread-cursor.test.tsx`.
