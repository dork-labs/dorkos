---
slug: team-room-home
id: 260807-170131
created: 2026-08-08
status: specified
design-session: .dork/visual-companion/55521-1786115964
---

# The home is a room: #team room home, tabs IA, jump back in

**Status:** Approved (design decisions locked 2026-08-07; delegated calls resolved 2026-08-08)
**Author:** Claude (design session with Dorian, 2026-08-07; specified 2026-08-08)
**Date:** 2026-08-08

## Overview

Replace the report-style dashboard at `/` with the **#team room** — a real room containing the
user and all their agents — wrapped in a home surface whose tabs absorb Activity, Tasks
("Scheduled"), and Workspaces. A pinned triage header keeps "Waiting on you" glanceable above
the feed; a presence strip shows who is working; a unified "Jump back in" recents list replaces
the sidebar Recents and appears on the focused-empty composer. The sidebar shrinks from 7 nav
items to 4: **Home · Team · Connections · Marketplace** (+ Search).

The full decision record (options considered, rejections, reasoning) is
[design-decisions.md](design-decisions.md). This document is the buildable specification.

## Background / Problem Statement

The dashboard is a report about live things — status cards, promo cards, an activity preview —
and a report about live things is stale the moment you stop looking. Every agent-native product
studied (Devin, Cursor, Codex, Copilot mission control, Conductor, VibeKanban) made "what's
happening now" the home; none built a metrics dashboard. Meanwhile the composer on our dashboard
births a throwaway session per message, the sidebar Recents shows only agent chats (no DMs,
rooms, or runs), and "new messages" state is split across two disagreeing mechanisms
(localStorage watermark in chats; a mute server column in rooms).

## Goals

- Home = the #team room: live feed, pinned triage, presence, full composer — one surface where
  the user and their agents actually work.
- Sidebar 7 → 4; Activity/Scheduled/Workspaces become tabs of the home surface with zero
  broken deep links.
- One unified "Jump back in" recents model (DMs + rooms/channels + sessions) serving both the
  sidebar and the composer popover.
- Sequence, don't invent: land room-participation RP3 (DOR-665) as the cursor prerequisite;
  reuse the shipped composer family, identity kit, room-view widget, and room_context pipeline.
- Bless the thread-over-sessions model in an ADR (documenting the split that already exists).
- Unify read state onto one server-side, broadcast, per-user cursor model (community-ready).
- Moments + welcome-back messages: the emotional layer, from real data only.

## Non-Goals

- **RP6/RP7/RP8 room tools** (`post_to_room`, `read_room_history`, `search_room_history`,
  burst debounce): owned by `specs/room-participation/02-specification.md`. This program lands
  RP3 (its one true prerequisite) and stops; the tools follow under that spec. RP7 additionally
  must not ship before the message-search index (DOR-672, ADR 260728-214214 still `proposed`).
- **Community servers / #company rooms** — the CommunityAdapter seam already anticipates them;
  nothing here may break it, nothing here builds it.
- **Kanban board view** — rejected as default; may return later as an opt-in Shape.
- **Generic widgets (weather/clock)** — explicitly rejected in core; marketplace Shapes
  territory.
- **Social "seen by" read receipts** — private cursors only; receipts are a later additive
  layer when rooms get multiple humans (Matrix `m.fully_read` vs `m.read` split).
- **Rich text (DOR-948) and room attachments (DOR-947)** — separate in-flight specs; this
  program consumes the shared `Composer.*` family as-is and must not fork it.
- **Obsidian embedded mode redesign** — embedded mode bypasses the router today and keeps doing
  so; the new home surface is a cockpit/web concern.

## Technical Dependencies

All internal; no new external libraries.

- `Composer.*` compound family (`apps/client/src/layers/features/composer/`) — shipped
  (DOR-946, #851).
- Identity kit: `IdentityAvatar`, `IdentityHoverCard`, `MentionPill`, `ProfileDrawer` — shipped
  (identity-consistency programme, closed out).
- Room view widget (`apps/client/src/layers/widgets/room-view/`) — shipped; `/channels` route.
- `room_context` pipeline (RP2), `engaged` response mode (RP4), mention picker (RP5), presence
  signals (RP9), halt — shipped per the 2026-08-08 audit.
- `motion` (animation), TanStack Router (code-based routes), Zustand + TanStack Query.
- `eventFanOut` global event bus (`GET /api/events`) for cursor-write broadcasts.
- `conf`-backed user config (`services/core/config-manager.ts`) — welcome-back toggle needs a
  semver-keyed migration per `contributing/configuration.md`.

## Detailed Design

### D1. Phase 0 — Foundations

**D1.1 RP3 lands first (DOR-665, already `agent/ready`).** Exactly as specified in
`specs/room-participation/02-specification.md` §8 and the DOR-665 validation criteria:

- `room_members.joinedSeq` column, backfilled from `joinedAt` matched against
  `room_entries.createdAt` in the same migration.
- `rooms.ambientMaxEntries` per-room column (default 30) replacing the hardcoded
  `PENDING_MAX_ENTRIES` in `apps/server/src/services/rooms/room-context.ts` (that file's own
  comment names this handoff).
- Pending window = `max(lastReadSeq, joinedSeq, latestSeq − ambientMaxEntries)` exclusive →
  `latestSeq` inclusive, `pendingTruncated` when anything dropped.
- **The agent cursor advances when the turn is claimed**, not when the reply posts. This is the
  missing write half: today `setReadCursor` is called only from the client mark-read route and
  the dormant community adapter.
- Live-ambient stays out of scope here if DOR-665 defers it; the cursor mechanics are what this
  program needs.

**D1.2 Thread-over-sessions ADR.** Documents and blesses the split that already exists in code
(no migration):

- **Direct agent chat** (`/session`): the _session_ is the durable thing — runtime-owned
  transcript, resumed directly. Kept deliberately.
- **DMs and rooms**: the _thread_ (the append-only room log) is the durable thing; sessions
  underneath are disposable engine runs. A fresh session may start under the same thread when
  context goes stale; agents rebuild context from the log (RP3 push + future RP7 pull). Users
  never see "sessions" on room surfaces.
- **The where-you-reply rule**: the place you reply from decides what continues. Home composer
  → #team. Triage card about a session → that session. DM → that DM thread. Task-triggered and
  Telegram-originated sessions never hijack the home composer.

**D1.3 Read-cursor write broadcast (the cheap sync fix).** `RoomService.setReadCursor` gains an
event publish on the existing bus so a second device updates on push instead of the 30s poll.
This lands regardless of D6 (the fuller unification) because it closes most of the cross-device
gap for rooms at trivial cost.

### D2. Phase 1 — the home surface shell (tabs + sidebar + Jump back in)

**D2.1 Tab-wrapped routes, zero redirects.** The home surface is a layout with a tab bar; the
tabs are the _existing routes_ rendered inside it:

| Tab label  | Route         | Notes                                                                |
| ---------- | ------------- | -------------------------------------------------------------------- |
| Home       | `/`           | the #team room (Phase 2; placeholder = current dashboard until then) |
| Activity   | `/activity`   | existing `ActivityPage` + its `activitySearchSchema` untouched       |
| Scheduled  | `/tasks`      | existing `TasksPage`; label says "Scheduled", route stays `/tasks`   |
| Workspaces | `/workspaces` | existing `WorkspacesPage`                                            |

Implementation: a `HomeSurfaceLayout` (new FSD widget or layout route component) renders the
tab bar and an outlet; `indexRoute`, `activityRoute`, `tasksRoute`, `workspacesRoute` become
children of (or render through) that layout. Deep links, search params, and the command palette
keep working because the paths never change. Mobile: the tab bar scrolls horizontally; tabs are
44px touch targets.

**D2.2 Sidebar shrinks 7 → 4.** `SidebarNavHeader` items become: Home (`/`, active on `/`,
`/activity`, `/tasks`, `/workspaces`), Team (`/team`), Connections (`/connections`),
Marketplace (`/marketplace`), + Search. The Activity/Tasks/Workspaces `NavButton`s are removed.
Tour anchors that referenced removed items are re-pointed (grep `TOUR_ANCHORS`).

**D2.3 Jump back in — one model, two surfaces.** A unified recents model
(`entities/`-layer hook, e.g. `useJumpBackIn()`) merging:

- recent sessions (existing `useRecentSessions`, partitioned by origin as today),
- recent DMs and rooms/channels (by latest entry seq / activity),
- ordered by last activity, deduped, capped (~8).

Surface 1: replaces `RecentSessionsSection` in the sidebar (same collapse prefs). Surface 2: a
popover anchored to the home composer when focused-while-empty, listing the same items; Enter
jumps into the thread. Each row: `IdentityAvatar` (or room glyph), name, one-line last-activity
summary, relative time.

**D2.4 Orphan disposition** (delegated call, resolved):

| Current section                       | Disposition                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `composer` (DashboardComposerSection) | Absorbed: the home composer becomes the #team room composer (Phase 2). The birth-a-session flow it carried is retired; agent creation lives on `/team` and in conversation.                                                                                                                                                     |
| `pending-approvals`                   | Absorbed into the pinned triage header ("Waiting on you" cards, resolve in place) — same `usePendingApprovals` + SSE liveness, same never-fail-silent rule (`ApprovalsUnavailable` + retry stays).                                                                                                                              |
| `needs-attention`                     | Absorbed into the pinned triage header as the second card group ("Needs attention": stalled sessions, failed runs, dead letters, offline agents — same `useAttentionItems` heuristics, same detail sheets, which move with it).                                                                                                 |
| `promo` (dashboard-main PromoSlot)    | **Retired.** The `dashboard-sidebar` placement survives. The promo registry stays; quiet-state DorkBot suggestions (D5.3) become the tasteful successor on the home surface.                                                                                                                                                    |
| `your-agents`                         | **Retired.** Its jobs are covered: presence strip (who's working, Phase 2), sidebar roster, `/team` page, Jump back in.                                                                                                                                                                                                         |
| `system-status`                       | **Retired as a row.** Its click-throughs already have homes: Tasks status → the Scheduled tab; Relay/dead letters → `/connections?region=messaging`; Mesh/topology → `/team?view=topology`; the activity sparkline → the Activity tab header.                                                                                   |
| `recent-activity`                     | Absorbed: the Activity tab IS the feed (full `ActivityPage`, better than the 15-item preview).                                                                                                                                                                                                                                  |
| `dashboard.sections` extension slot   | **Kept, re-homed.** Built-in contributions unregister as they're absorbed. Remaining (third-party) contributions render in a "From your extensions" section at the top of the Activity tab. The slot id stays stable; `extension-api` docs note the new placement. Phase 5 (deferred) designs the proper room-widget successor. |

### D3. Phase 2 — the #team room as home

**D3.1 Seeding.** `ensureTeamRoom()` boot hook in `apps/server/src/services/rooms/` (patterned
on `ensureDorkBot()`): creates the #team channel once per install (idempotent, keyed by a
well-known natural key, e.g. `system:team`), with the local human and DorkBot as members;
newly-registered agents are added as members with the channel-default `engaged` response mode.
System room semantics: #team cannot be archived or renamed by agents (reuse the DOR-608 guard
surface); users may mute it but not delete it.

**D3.2 The home tab renders the room.** `/` renders the #team room through the existing
`room-view` machinery (timeline, thread panel, mention picker, presence line, halt), wrapped
with the home-specific chrome below. `/channels?id=<team>` remains a valid alias — same widget,
no fork. The room composer here is the full `Composer.*` family (attachments included).

**D3.3 Pinned triage header** (sticky above the feed, never buried):

- **Waiting on you**: pending-approval cards; approve/deny in place; card resolves with a ✓ and
  the count melts. Failed fetch shows the loud unavailable state.
- **Needs attention**: the `useAttentionItems` rows; each deep-links (detail sheets move here).
- Both groups render zero DOM when empty — the header collapses to just the presence strip.
- **Presence strip**: avatars of currently-working agents (existing `working`/`working_late`
  presence + `busyWith` binding), one-liner like "tangerines · replying in #release-train".
  Clicking follows into that room/session as a viewer (watch, not hijack — agent-etiquette).

**D3.4 Composer routing.** Posting in #team is a room post, full stop (no navigation, no
morph): unaddressed posts trigger the **default agent** (from settings; DorkBot by default) via
room addressing; `@handle` reaches any member; multiple mentions fan out per existing room
dispatch. This is a room-membership configuration (default agent's membership responds to
unaddressed posts), not new routing machinery: the default agent's #team membership uses
`always` mode; other agents default to `engaged`/`mention-only` semantics per the channel
default. The old "birth a session per dashboard message" path is deleted.

**D3.5 Default-route swap.** The home tab shows the room the moment D3.1–D3.4 are merged — no
feature flag (explicit decision: early beta, building in public). The dashboard placeholder from
Phase 1 is removed in the same PR. `DashboardPage` and its retired sections are deleted (no dead
code); absorbed pieces move, they don't duplicate.

**D3.6 Day one / quiet states.** Day one: #team contains DorkBot; onboarding is a conversation
(starter chips above the composer, reusing the existing suggestion-chip pattern). Quiet morning:
no fake recap — "All quiet." + forward-look line (next scheduled run, oldest waiting item) as a
lightweight system post or header line, not invented content.

### D4. Phase 3 — read-state unification

Per `research/20260807_read_state_architecture.md`:

- One `read_cursors` table (`packages/db`): `(user_id, thread_kind, thread_id) → last_read_seq,
updated_at`. `thread_kind ∈ {room, session, inbox}`. Rooms migrate off
  `room_members.last_read_seq` (single-write-path migration; the column's readers move to the
  new table; agents' RP3 cursor stays on the membership row — RP3 is agent-side, this table is
  user-side).
- Every cursor write broadcasts on `eventFanOut`; clients reconcile via TanStack Query cache
  updates (no poll dependency).
- Chat sessions move off the localStorage watermark onto the same table keyed by the session's
  monotonic SSE `seq`; the `UnreadDivider` becomes one mechanism everywhere.
- "New for you" in #team: unread divider + the sidebar unread dot both read the unified cursor.
- The `CommunityAdapter` `getReadCursor`/`setReadCursor` seam wraps the new table for the local
  backend (community-server compatibility preserved).
- Per-user by construction (user_id column) — multi-human rooms get correct per-person state
  the day they exist.

### D5. Phase 4 — moments + welcome-back

**D5.1 Moments.** A moment is a room entry post type (system-authored or agent-minted),
derived from real data only. Starter detectors (server-side, evaluated on real events, posted
to #team): first agent created, "X joined your team" (agent creation), first PR shipped /
first schedule / first overnight run / first Connection, weekly volume marks, anniversaries.
Agent-minted moments ride the existing post path, rate-limited by room etiquette (cascade guard

- turn budget already bound them). Rendering: a distinct entry style in the feed (identity kit
- a moment glyph), no new persistence model — they are room entries.

**D5.2 Welcome-back.** On user return after a real absence (threshold default 4h), agents
active since the user left may post to #team: one line + a concrete offer. Iron rule: news, not
noise. Caps: max 3 posts per return; only agents with a real status delta; cheap status lines
come from session state without waking the agent; a model turn is spent only when the agent has
a genuine next-step offer. Config (`UserConfigSchema`, semver migration per
`contributing/configuration.md`):

```
welcomeBack: {
  enabled: boolean (default true),
  absenceThresholdMinutes: number (default 240),
  maxPosts: number (default 3),
}
```

Settings toggle in the existing Settings groups. Start simple; no per-agent knobs in v1.

**D5.3 Quiet-state suggestions.** DorkBot's single gentle suggestion in quiet states (e.g.
"want your agents working while you sleep?") replaces the promo-card grid as the discovery
mechanism on home — one line, dismissible, sourced from the promo registry's qualification
logic where it fits.

### D6. Cross-cutting

- **Tasks/Relay defaults**: already `enabled: true` in `config-schema.ts` (verified
  2026-08-08); remaining work is (a) confirm the Settings Tools tab can toggle both off, add if
  not; (b) leave the non-prod scheduled-firing gate (`resolveTasksFiring`) as-is — it gates
  cron firing in dev, which is correct, and flipping it is out of scope.
- **Language & IA plan addendum**: `plans/language-ia-simplification.md` "sidebar unchanged"
  line gets an addendum pointing at this spec (done alongside this spec).
- **Runtime presence conformance**: presence strip truthfulness ("is it running, what is it
  bound to") should join the runtime conformance suite (`runtimeConformance`) as an assertion
  where runtimes expose it; where a runtime cannot, the strip omits rather than lies.

### Code structure (primary touch points)

- `apps/client/src/router.tsx` — home-surface layout wrapping `/`, `/activity`, `/tasks`,
  `/workspaces`.
- `apps/client/src/layers/widgets/home/` (new) — `HomeSurfaceLayout`, tab bar, pinned triage
  header, presence strip; absorbs approval/attention UI from `features/approvals` /
  `features/dashboard-attention` (which keep their feature slices; the widget composes them).
- `apps/client/src/layers/widgets/dashboard/` — deleted at D3.5 (sections absorbed/retired).
- `apps/client/src/layers/features/dashboard-sidebar/` — nav shrink + `JumpBackInSection`.
- `apps/client/src/layers/entities/recents/` (new) — `useJumpBackIn()`.
- `apps/server/src/services/rooms/ensure-team-room.ts` (new), RP3 changes per DOR-665,
  `read_cursors` schema in `packages/db/src/schema/`.
- Moments/welcome-back: `apps/server/src/services/rooms/` (post-type + detectors), config in
  `packages/shared/src/config-schema.ts`.

### API changes

- `GET /api/rooms` unchanged; #team discoverable by natural key (new lightweight
  `GET /api/rooms/team` convenience or a `wellKnown: 'team'` field on the list — implementer's
  choice, documented in OpenAPI either way).
- `read_cursors`: `PUT /api/read-cursors/:kind/:id` + broadcast event; room mark-read route
  delegates to it (back-compat kept until clients migrate, then removed — no lingering legacy).
- No changes to session APIs.

### Data model changes

- `room_members.joinedSeq` (RP3), `rooms.ambientMaxEntries` (RP3), `read_cursors` table (D4),
  moment entries as a `roomEntries` post type (no new table).

## User Experience

- **Open the app** → `/` shows #team: pinned header (only if something needs you), presence
  strip, feed, composer. First open of the day: greeting settles in first (choreographed,
  `motion`), then content.
- **Type without @** → default agent answers in the room. **@tangerines …** → tangerines
  answers. Where you reply decides what continues.
- **Tab bar** → Activity / Scheduled / Workspaces one tap away; URLs unchanged.
- **Focus the empty composer** → Jump back in popover (recent DMs, rooms, sessions). Same list
  lives in the sidebar where Recents was.
- **Come back after a day** → up to 3 real updates from your agents in the feed, "all quiet" +
  forward look if nothing happened.
- **Error paths**: approvals fetch failure is loud (retry card); room stream failures use the
  existing self-healing stream + notices; an agent that can't take a turn writes a visible
  notice (RP1, shipped).

## Testing Strategy

- **Unit**: `useJumpBackIn` merge/order/dedupe; orphan-disposition regressions (removed
  sections stay removed); tab-layout active-state mapping; welcome-back gate logic (absence
  threshold, caps, no-delta agents excluded); moment detectors (fire once, real data only);
  RP3 window math per DOR-665's enumerated cases (assert on the runtime double, not log lines).
- **Integration (server)**: `ensureTeamRoom` idempotency + membership defaults; cursor
  advance-on-claim via `FakeAgentRuntime` scenarios; `read_cursors` write + broadcast via
  `collectDurableEvents`; mark-read route delegation.
- **Client (RTL + mock Transport)**: pinned header resolve-in-place; presence strip renders
  from presence events; composer routing (unaddressed → default agent membership semantics);
  every test that renders a changed component re-run (grep for mounting parents before push).
- **E2E (Playwright, apps/e2e)**: home loads as room; approve-from-header round trip; tab
  navigation preserves deep links (`/activity?categories=…`); sidebar has 4 items; jump-back-in
  popover navigates. Update captures via the capturing-product-media flow afterward (media will
  be stale).

## Performance Considerations

- The home room mounts the room timeline plus approvals/attention/presence hooks — all existing
  queries already used by the dashboard; net query count drops (7 sections → 1 room + header).
- Cursor broadcasts are tiny events on an existing bus; no new polling.
- Moment detectors run on existing event paths (agent registration, activity ingest), not
  timers, except the daily-volume marks which piggyback the activity aggregation.

## Security Considerations

- #team is a normal room: membership-scoped reads, the untrusted-fence prompt boundary, cascade
  guard and turn budget all apply unchanged. Agent-minted moments ride the same guarded post
  path — no new write surface.
- `read_cursors` is per-user state behind the same auth as the room routes; no cross-user reads.
- The system-room guard (cannot rename/archive #team via agents) closes the DOR-608 hole for
  the one room the product depends on.

## Documentation

- `docs/` (Fumadocs): home-surface concept page update, rooms concept update (#team), settings
  (welcome-back toggle), writing-for-humans register.
- `contributing/architecture.md` + extension-api docs: `dashboard.sections` re-homing.
- `plans/language-ia-simplification.md` addendum (sidebar change).
- OpenAPI regeneration for new/changed routes (both doc commands, per the openapi-fresh gotcha).
- Changelog fragments per PR.

## Implementation Phases

- **Phase 0 — Foundations**: RP3 (DOR-665), thread-over-sessions ADR, cursor-write broadcast.
- **Phase 1 — Home surface shell**: tab layout over existing routes, sidebar 7→4, Jump back in
  (both surfaces), orphan dispositions except composer/approvals/attention (which move in
  Phase 2 with the room).
- **Phase 2 — #team room home**: ensureTeamRoom, room at `/`, pinned triage header, presence
  strip, composer routing, dashboard deletion. Ships without a flag.
- **Phase 3 — Read-state unification**: `read_cursors` + broadcast + one divider mechanism.
- **Phase 4 — Moments + welcome-back + quiet-state suggestion.**
- **Phase 5 (deferred, not this program)**: extension room-widget slot / Shapes story for the
  home surface; kanban-as-a-Shape; RP6/RP7/RP8 under room-participation.

Phases 1 and 0 are independent and can run in parallel worktrees; Phase 2 depends on both;
Phase 3 is independent of 2 (can parallelize); Phase 4 depends on 2.

## Open Questions

- ~~Which agent hears unaddressed #team posts?~~ **(RESOLVED)** The default agent from
  settings, via its `always` membership mode. Rationale: room semantics instead of new routing
  machinery; user-configurable by changing the default agent.
- ~~Feature flag for the default-route swap?~~ **(RESOLVED)** No flag — early beta, building in
  public (Dorian, 2026-08-07). Ship when Phase 2 merges.
- ~~Do Tasks/Relay need a defaults flip?~~ **(RESOLVED)** Already on by default in
  `config-schema.ts`; remaining work is the Settings toggle audit only.
- ~~Where do third-party `dashboard.sections` contributions go?~~ **(RESOLVED)** "From your
  extensions" section atop the Activity tab; slot id stable; proper successor in Phase 5.
- ~~Does `/tasks` rename to `/scheduled`?~~ **(RESOLVED)** No route rename — tab label
  "Scheduled" only; URLs are contracts.

## Related ADRs

- Draft (seeded by this spec): thread-over-sessions; home-is-a-room; unified read cursors.
- ADR-0310 (runtime-owned session storage) — constrains: threads never replace direct-chat
  session durability.
- ADR-0273 (runtime-neutral context injection) — the room_context push channel.
- ADR 260728-022013 (a thread is a relation between entries) — thread model.
- ADR 260726-170125 (a room is a membership-scoped durable stream) + 260726-170127 (cascade
  guard) — room primitives.
- ADR 260807-173219 (compound composer family) — the composer this spec consumes.

## References

- `specs/team-room-home/design-decisions.md` (decision record, three rounds)
- `specs/room-participation/02-specification.md` (RP3/RP6/RP7/RP8) + DOR-665
- `research/20260807_room_context_delivery_buzz_and_patterns.md`
- `research/20260807_read_state_architecture.md`
- `research/20260320_dashboard_content_design_patterns.md`,
  `research/20260320_dashboard_route_navigation_architecture.md`
- Linear: DOR-951 (composer/rooms programme), DOR-946 (parity, done), DOR-947 / DOR-948
  (in-flight sibling specs), DOR-672 (message search, RP7 blocker)
- Codebase audits (2026-08-08): client IA state; room-participation implementation status
  (both folded into this spec's Detailed Design)
