---
slug: team-room-home
status: In Progress
started: 2026-08-08
last-updated: 2026-08-08
---

# Implementation: The home is a room (#team)

**Status:** In Progress
**Tasks Completed:** 17 / 31 — P0 (4/4, merged #868), P1 (7/7, merged #874), P3 (6/6, this
branch). P2 is in flight in its own worktree and counts itself; this line does not speak for it.

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
  (one-time backfill, migration 0059). `room_read_cursor` superseded by the unified `read_cursor`,
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
