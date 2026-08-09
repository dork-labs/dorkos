---
slug: team-room-home
status: Complete
started: 2026-08-08
last-updated: 2026-08-09
---

# Implementation: The home is a room (#team)

**Status:** Complete
**Tasks Completed:** 31 / 31 — P0 (4/4, merged #868), P1 (7/7, merged #874), P2 (7/7, merged
#880), P3 (6/6, merged #879), P4 (7/7, this branch).

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

## Phase 4 — Moments + welcome-back (D5)

Worktree `/Users/doriancollier/.dork/workspaces/dorkos/trh-p4` → branch
`feat/team-room-home-p4-moments`. Linear DOR-1031. Six implementation commits plus this
close-out; every task adversarially reviewed before its commit.

- **Task #4.1 — the moment post type.** `RoomMomentSchema` rides the existing entry body, so a
  moment is a POST and nothing but `body.moment` says so; there is no second table and no second
  timeline. System-authored moments append without waking anyone (cascade-stamped at the ceiling);
  an agent-minted one goes through the full guarded post path and may only name itself as subject,
  which is the anti-spoof rule. The feed draws it as a calm banded row: the subject's face, one
  shared sparkle glyph, identity colour only, no animation at all. Commit f3cfbbe5b.
- **Task #4.2 — the detectors.** Eight detectors on two seams that already existed, the
  agent-created seam and activity ingest, and **no timer anywhere**. Firsts, joins, overnight runs,
  week and month anniversaries (clamped, with a 48h freshness grace) and an exact-count weekly
  streak read once per local day rather than once per event. **The moment IS the durable marker** —
  "has this been marked?" is a question about the room's own log (`RoomStore.hasMoment`), so a
  restart, a second process or a double evaluation cannot repost one. One line per pass, and none
  within an hour of the last. Commit c9785d019.
- **Task #4.3 — the `welcomeBack` config block.** `{ enabled: true, absenceThresholdMinutes: 240,
maxPosts: 3 }` on `UserConfigSchema` with argued bounds, a `0.59.0`-keyed additive migration that
  correctness never depends on (the Zod defaults stand alone, because a dev tree resolves `0.0.0`
  and runs no migration), and operator-only writes. A raised absence threshold now survives config
  recovery: the carryover machinery learned the "higher is more protective" direction instead of
  exempting the one leaf its type could not describe. Commit 67f695c95.
- **Task #4.4 — welcome-back posting.** After a real absence, each agent that actually did
  something posts one line to #team. The caps are code, not prompt: `planWelcomeBack` slices to
  `maxPosts`, and **zero model turns are spent** — nothing in the module can reach a runtime.
  "Away" is measured from the last thing the person demonstrably did here (a read cursor that
  moved, a message they wrote), so a restart can only make an absence look longer, never shorter.
  Commit c82d384b4.
- **Task #4.5 — one quiet suggestion.** On a caught-up quiet morning DorkBot offers a single
  earned suggestion under the forward look, sourced from the promo registry's own qualification
  rules rather than a second eligibility system. Never to a blank install, never for something the
  person already does, dismissed once and gone everywhere. The retired `dashboard-main` promo
  placement and the wide card format only it used are deleted. Commit 60e8f678e.
- **Task #4.6 — the toggle audit.** No defaults flip was needed. The Tools tab gained a Background
  systems card (one switch each for scheduled runs and agent messaging) that follows the STORED
  value, says plainly when a change waits for the next start, shows reality rather than the
  overruled setting when an env variable decides, and never says "Saved." over a system that failed
  to start. `resolveTasksFiring` untouched, confirmed by diff. Settings → Preferences gained the
  welcome-back switch. Commit 9873c9ec3.

### Task #4.7 — e2e, docs, and the programme close-out

**E2E.** Three additions, all against legs that spend nothing.

- `tests/home-surface/team-room.spec.ts` (`chromium-team-room`, test-mode leg) gained **the
  moments block, deliberately first in the file**: registering an agent marks it once, the row
  renders as a moment (`data-moment` carrying the kind the SERVER recorded, the sparkle mark, the
  `Moment: …` accessible name, the subject's own face, and no control to press), the moment names
  the record it was read off, and a second agent created in the same minute produces **no second
  line**. First in the file because #team marks at most one moment an hour, so the first agent
  created on that leg is the only one whose milestone can land in a run — the opening assertion
  says so rather than leaving it to be rediscovered.
- The same file gained **the quiet-suggestion block**: a caught-up room says "All quiet." with
  exactly one suggestion under it, dismissing is one press, and it does not come back on reload.
  It seeds its own agents (the registry's rules are what decide whether a suggestion is earned) and
  reads the approval queue and the mesh's unreachable count first, skipping with a named reason on
  the two arrangements where a missing quiet line is the CORRECT answer.
- `tests/settings/settings-dialog.spec.ts` (cockpit leg) gained **the welcome-back round-trip**:
  flip, full page reload, read it back, flip back, reload again. Everything else on that tab is a
  browser preference that would survive a reload on `localStorage` alone, which is why this one is
  worth driving. Self-restoring, so the run leaves the config as it found it.

**Proved able to fail.** `MOMENT_QUIET_PERIOD_MS` set to `0` turned the moments spec red at exactly
its burst assertion ("a burst of agent creations produced a burst of milestones", expected 1,
received 2). Reverted; `git diff` over `apps/server` and `packages` is empty.

**A P4 change had broken an existing spec, and the sweep found it.** `settings-dialog.spec.ts`
asserted `toHaveCount(8)` on the Preferences switches; task 4.6 added a ninth (the welcome-back
switch) to that tab. Corrected to 9 with the new switch named alongside the other three, so a
future swap cannot pass on the count alone. Nothing else broke: the `dashboard-main` promo
placement had no e2e references, and `tests/dashboard-sidebar`, `tests/home-surface/home-shell` and
the rest of `tests/settings` all pass unchanged.

**Docs.** `docs/concepts/rooms.mdx` gained two sections — "Moments: the things #team marks" (only
from your own records, once each, one an hour, a message in the room rather than a separate feed)
and "When you come back after being away" (the caps, what "away" measures, and that the switch is
Settings → Preferences). `docs/getting-started/what-is-dorkos.mdx` gained the quiet morning and
DorkBot's one suggestion. `docs/getting-started/configuration.mdx` now points at the in-app switch
from the `welcomeBack` block. `docs/glossary.mdx` gained **Moment**.

**Changelog.** The six P4 commits are covered by four fragments after folding three
populator-generated stubs into the hand-written entries beside them (the stubs restated commit
subjects as user copy and would have double-printed at release): background systems, moments (4.1 +
4.2), the quiet suggestion, and welcome-back (4.3 + 4.4). `--validate` clean, every P4 commit
claimed.

## Programme close-out

### The 31-task ledger

| Phase                     | Tasks | Landed                    |
| ------------------------- | ----- | ------------------------- |
| P0 Foundations            | 4/4   | #868 (DOR-1027)           |
| P1 Home surface shell     | 7/7   | #874 (DOR-1028)           |
| P2 #team as home          | 7/7   | #880 (DOR-1029, DOR-1033) |
| P3 Read-state unified     | 6/6   | #879 (DOR-1030)           |
| P4 Moments + welcome-back | 7/7   | this branch (DOR-1031)    |

Every task shipped. Three pieces of commissioned scope were **deliberately narrowed**, each in
writing at the point of the decision rather than dropped quietly:

- **The welcome-back offer half** (spec D5.2's "Want me to open the PR?"). v1 spends zero model
  turns, structurally: this install has no honest signal that says an agent HAS a next-step offer,
  and asking it would be exactly the speculative turn the rule forbids. The seam a later phase
  needs is `WelcomeBackWorkSource`. Filed as **DOR-1046** ("Welcome-back offers: spend a turn only
  when an agent has a genuine next step").
- **Three of spec D5.1's listed detectors are declined**, each because rule 1 (real data only)
  leaves nothing to read, and each argued in the module header rather than stubbed: **first PR
  shipped** (this install keeps no record of a pull request — watching a git remote would be a
  detector reading the world instead of its own log); **100th session / 1000th message** (session
  storage is runtime-owned per ADR-0310, so a count is a per-runtime-degrading aggregate, and a
  number that might be wrong is worse than no moment); **"busiest day yet"** (the activity log is
  pruned on a retention window, so "yet" would silently mean "since whatever we still have"). The
  moment kinds exist in `RoomMomentKindSchema`, so each is a small addition on the day a record
  appears to read.
- **Task 4.6 was an audit, not a defaults flip.** Tasks and Relay were already `enabled: true` by
  default; what was actually missing was a way to turn them OFF from the UI, which is what shipped.

### Review rounds

Every one of the 31 tasks went through an independent adversarial review before its commit, and
the reviews earned their place: they caught the inert presence gate and the "empty turn passed as
shown" bug in P0, hollow active-state tests, a mobile tour that killed the page, room-turn double
listing, an unreachable popover, a DM letter-disc regression and a dishonest week summary in P1,
and in P4 the first-agent branch that silently swallowed a second agent's "joined your team" line.
What this log can vouch for by name: P0's tasks 0.1 and 0.4 were two-stage (0.4 needed a second
round after two criticals), 0.3 passed with two importants fixed red-then-green, and every P1 task
was two-stage. P2, P3 and P4 tasks each record a review before their commit, with the findings
folded in before the commit was written rather than tracked separately — so the per-task round
count for those three phases is not recoverable from this log, only the fact of the review and its
findings. Every seeded-defect proof in this programme was reverted and each revert verified by
diff.

### Follow-ups filed

| Issue        | State | What                                                                               |
| ------------ | ----- | ---------------------------------------------------------------------------------- |
| **DOR-1036** | Done  | WorkspacesPage had no internal scroll container (fixed in a parallel branch)       |
| **DOR-1039** | Todo  | The Activity tab week summary and the feed describe different subjects             |
| **DOR-1040** | Todo  | Chat cross-device read state has no browser coverage                               |
| **DOR-1042** | Todo  | Mesh-registered agents do not take their #team seat until the next boot            |
| **DOR-1043** | Todo  | Header clips its overflow with no cue that more is below                           |
| **DOR-1044** | Todo  | The operator-only refusal copy misdescribes settings that are not security-shaped  |
| **DOR-1045** | Todo  | An agent may switch off the whole Relay bus and Tasks scheduler via `config_patch` |
| **DOR-1046** | Todo  | Welcome-back offers: spend a turn only when an agent has a genuine next step       |

### Non-goals, all held

No RP6/RP7/RP8 room tools (the only mention of `post_to_room` in the tree is a prose comment); no
community servers or `#company` rooms, and the `CommunityAdapter` seam is intact; no kanban; no
generic widgets; no social "seen by" read receipts (a cursor is only ever read back by whoever
wrote it, and the route has no way to name a user); no fork of the `Composer.*` family (it was
extended in place — three pre-existing files, no new `Composer*` file, no shadow copy under the
home widget); no Obsidian embedded-mode redesign (`apps/obsidian` is untouched; the only
embedded-mode change is the deletion of a stub that followed a retired route).

### Known gaps at close-out

- **Welcome-back posting has no browser coverage, and honestly cannot have one yet.** An absence
  needs a durable last-seen timestamp older than the threshold, and the only HTTP path that writes
  one writes `now`; the floor is 15 minutes, which no e2e may wait for. Simulating it would mean
  either a test-only time seam or writing the database behind the server's back, and both would
  make the spec assert against a fixture rather than against the product. The behaviour is carried
  by 35 unit tests across `welcome-back.test.ts` and `welcome-back-work.test.ts`, including the
  gate arithmetic, the zero-turn proof against a runtime double, the `enabled: false` no-work path
  and the two-returns-in-quick-succession case.
- **Programme-wide changelog hygiene.** The P1–P3 fragments (already on `main`) carry the same
  populator-stub duplication that P4's were cleaned of — roughly eight pairs where a hand-written
  entry sits beside a stub restating the commit subject. They will double-print at release unless
  folded. Left alone here because they belong to merged PRs; worth a pass before the next release
  compiles `CHANGELOG.md`.
