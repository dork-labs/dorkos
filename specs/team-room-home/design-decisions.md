---
design-session: .dork/visual-companion/55521-1786115964 (screens 1-4), .dork/visual-companion/16938-1786121056 (restored)
date: 2026-08-07
participants: Dorian + Claude (visual-companion exploration)
status: decided — pending /flow capture
---

# Design Decisions: The home is a room (#team)

Visual-companion session exploring the dashboard redesign. Research inputs: full map of the
current dashboard implementation, plus a competitive study (Devin, Cursor, Codex, GitHub Copilot
mission control, Conductor, VibeKanban, Vercel, Linear, Notion, Raycast, incident.io, Bloomberg).
Key research finding: **every agent-native product made "what's running now" the home; none
built a metrics dashboard.** A report about live things goes stale; the live thing itself never does.

## 1. Should we even have a dashboard?

**Screens:** `concepts.html` (4 directions: Board / Briefing / Launcher / Tabs)
**Decided:** Keep a home surface, change its job — from _report about the system_ to _the live
place where you and your team work_. The current report-style dashboard (status cards, promo
cards, activity preview) goes away as a format.

## 2. Information architecture

**Screens:** `concepts.html` (D), `tab-one.html`
**Decided:**

- Sidebar shrinks 7 → 4: **Home · Team · Connections · Marketplace** (+ Search). "Team" is the
  rename of "Agents" (Dorian's call, predates this session).
- **Activity, Tasks ("Scheduled"), Workspaces become tabs on the home surface**, not sidebar items.
- Marketplace stays a separate place (it already swaps the whole sidebar). Connections stays
  (setup, not daily work). Team stays (big management surface: list/topology/denied/access).
- NOTE: `plans/language-ia-simplification.md` says "sidebar unchanged" — this decision supersedes
  that line; the plan needs an addendum when this work is captured.

## 3. Tab 1: the home is the #team room

**Screens:** `tab-one.html` (three states), `catchup.html` (inbox model), `team-room.html` (final)
**Options considered:** A) kanban board home, B) DorkBot briefing home, C) launcher home,
D) structured inbox tab, E) **the #team room as home** (chosen — Dorian: "ALL-IN").

The home tab is a real room, **#team = you + your agents** (local machine, LOCAL_COMMUNity
backend). Later, community servers can add #company / #community rooms via the CommunityAdapter
seam — same surface, different backend.

Structure:

- **Pinned header** (sticky, never buried by scroll): "Waiting on you" triage cards
  (approvals, agent questions) that resolve in place, + a **presence strip** ("DorkOS · editing
  router.tsx", "Meeting Notes · replying in #release-train"). Presence = who's working, shown as
  people online, NOT a kanban column.
- **Feed below**: moments, agent posts (welcome-backs, reports), and the user's group
  conversation with @mentions.
- **Full room composer** at bottom — attachments and all. One composer to rule them all
  (depends on `composer-parity` spec, in flight 2026-08-06).

Rejected: kanban board as default ("Done" column is fake — agents finish _turns_, not tasks;
kanban may return later as an opt-in power view, possibly a Shape). Rejected: generic widgets
(weather/clock) in core — those become opt-in marketplace Shapes.

## 4. Composer routing & the texting model

**Screen:** `tab-one.html` (A/B options), `team-room.html`
**Decided:**

- Plain unaddressed text → **the default agent from settings** (defaults to DorkBot).
  In the room model: unaddressed posts are handled by the default agent; @mentioned agents
  respond; other agents do not consume the message (no token burn, no pile-on).
- `@handle` reaches any agent directly (handles shipped in DOR-676).
- **Texting model**: a thread with an agent is durable and resumes by default; "new
  conversation" is the explicit action. Architectural implication: **thread = durable container,
  sessions = engine runs underneath** — a fresh session can start under the same thread when
  context goes stale; users never see "sessions."
- **The where-you-reply rule**: the place you reply from decides what continues. Home composer
  → #team. Inbox card about PR #841 → that work session. DM → that DM thread. Task-triggered and
  Telegram-originated sessions never hijack the home composer.
- Send transition: **morph, not navigate** — composer stays anchored, feed/board fades back,
  conversation grows in place (`motion`); URL updates quietly.

## 5. "Jump back in"

**Screen:** `team-room.html` (panel 2)
**Decided:** Focusing the empty composer floats up a "Jump back in" list of recent threads
across ALL surfaces — DMs, rooms/channels, scheduled-run sessions. Dorian: "That's gold."
**Also decided:** the sidebar "Recents" section is REPLACED by this same unified list (current
Recents shows only agent chats; the replacement covers DMs + rooms + channels + runs). One data
model, two surfaces (sidebar section + composer popover).

## 6. Moments, not widgets (the human connection)

**Screens:** `catchup.html` (panel 3), `team-room.html`
**Decided:** The emotional layer is the user's own team, not generic widgets. Moments are feed
posts derived from REAL data, never invented:

- Firsts: first agent, first PR, first schedule, first overnight run, first Connection, first
  agent-to-agent conversation
- Team changes: "tangerines joined your team" (agent creation — Dorian's canonical example)
- Streaks/volume: shipped every day this week, 12 PRs this week, busiest day yet
- Anniversaries: one week/month with an agent, 100th session, 1000th message
- **Agent-minted moments**: agents (esp. DorkBot) can post moments the rules can't detect,
  as a rate-limited post type.
- First open of the day is choreographed: greeting fades in first, then content settles.

## 7. Welcome-back messages

**Decided:** When the user returns after a real absence, recently-active agents may post to
#team — status + a concrete next-step offer ("Want me to open the PR?"). Iron rule: **news, not
noise** — only agents with something real to report; cap ~2-3 posts; one line each; triggered
only by absence of hours, not minutes; on by default with a settings toggle (config schema
change → semver migration). Cheap status lines come from session state; tokens are spent waking
an agent only when it has a genuine offer to make.

## 8. Quiet states

**Screen:** `catchup.html` (panel 2)
**Decided:** Never fake a recap. Quiet morning → say "all quiet," then look FORWARD: today's
schedule, the oldest item still waiting on the user, one gentle DorkBot suggestion (e.g. "want
agents working while you sleep?"). Day one → the room contains only DorkBot, and onboarding is
a conversation in #team (starter chips), not an empty board.

## Dependencies & known risks (captured, not yet resolved)

1. **Room↔session identity plumbing is the muddiest part of the stack** (placeholder ids in
   room_sessions, transcripts under ~/.claude3, near-zero logs on room-turn failures). The whole
   vision rides on hardening this. Likely Phase 0 + an ADR for the thread-over-sessions model.
2. **Composer-parity / composer-rich-text / room-attachments specs in flight** (created
   2026-08-06 by another agent) — room-home composer work waits for parity to land.
3. Presence quality ("replying in #release-train") needs reliable running-state + binding info
   across all three runtimes — conformance suite addition.
4. Disposition needed for every current dashboard section: promos/Discover, System Status row,
   Your Agents cards, needs-attention heuristics (failed runs, dead letters, offline agents),
   and the `dashboard.sections` extension slot + PromoSlot placements (extension-api contract).
5. Route migration: /activity, /tasks, /workspaces → tabs (redirects, deep links, palette,
   mobile). Renames interact with the Language & IA program.
6. Read/unread model for "New for you" (what marks read, storage, cross-device).
7. Rollout: the home is the default route — feature flag vs. hard swap; rooms are still behind
   the demo-claim gate (unverified end-to-end).

## Addendum — decisions from the 2026-08-07 follow-up round

**Room context delivery (resolves open items 2.b/2.c/2.d from the session):**

- Silent agents DO get room history when later @mentioned — being quiet never means being
  out of the loop.
- **Pull model via tool**: agents get a tool (likely MCP) to read the _delta_ of room messages
  they haven't seen and to post new messages. No re-sending full history an agent already has
  in its session context.
- **Thread compaction for long rooms**: provide the latest X messages (by count or content
  length) + summaries of older stretches, while agents can always read the full transcript or
  sections of it on demand.
- Research commissioned (2026-08-07): Buzz source review (github.com/block/buzz via opensrc),
  external patterns, and an internal audit of the current room-turn pipeline →
  `research/20260807_room_context_delivery_buzz_and_patterns.md`,
  `research/20260807_read_state_architecture.md`.

**Read state (requirements from Dorian):** per-user, global/syncable across devices and
browsers, universal (agent sessions, DMs, rooms/channels, inbox items), and community-server
compatible — a future shared server must know which users have seen which messages. Private
read marker first; social read receipts become possible when rooms get multiple humans.

**Welcome-back:** start simple, must be configurable. Claude designs the config shape.

**Orphan disposition & route/rename migration:** Dorian delegated both calls to Claude —
propose during SPECIFY (widgets where they fit, kill what doesn't earn its place).

**Rollout (supersedes risk #7):** NO feature flag — early beta, building in public, ship it
directly. Also audit existing feature flags (Tasks/Relay enablement) for removal so features
are on by default; flagged to Dorian before removal since it changes product behavior beyond
this program.

## Research verdicts (2026-08-07, same day — three tracks completed)

Reports: `research/20260807_room_context_delivery_buzz_and_patterns.md`,
`research/20260807_read_state_architecture.md`, plus an internal room-turn pipeline audit
(findings folded in below).

1. **The delta-tool design is validated, with one framing correction.** No studied system
   (Buzz, AutoGen, Matrix) makes the agent _fetch_ the triggering message — the trigger and a
   small capped delta are always PUSHED; tools are for pulling anything beyond the cap. The
   model is "**push the minimal delta automatically, pull the rest on demand**," not pure pull.
2. **DorkOS already spec'd this** — `specs/room-participation/02-specification.md`: RP3
   (per-agent cursor advances after each turn; `ambientMaxEntries` capped push), RP6
   (`post_to_room` tool + ability to decline speaking), RP7 (`read_room_history` /
   `search_room_history` tools), RP8 (burst debounce). None built. **RP3 is the one true
   prerequisite**: the `room_members.last_read_seq` column exists but is dead state — nothing
   advances it after an agent turn; today only a 30-entry cap bounds replay. The team-room-home
   program should sequence room-participation RP3 → RP6/RP7 → RP8 rather than invent parallel
   machinery.
3. **Compaction (refines 2.d):** Buzz keeps room-history compaction dumb (count truncation +
   pull tools) and reserves LLM summarization for an agent's _own_ turn history. Start there;
   add summaries of older stretches only when a real failure mode demands it. The full
   transcript stays durably readable either way (`room_entries` is append-only, never trimmed).
4. **Where DorkOS is already ahead of Buzz:** durable DB cursor column (Buzz's last-seen is
   in-memory and silently drops messages across restarts); a never-trimmed durable log; cockpit
   and Telegram traffic converged on one dispatch path; a reusable injection-fenced,
   runtime-neutral room-context formatter.
5. **Worth stealing from Buzz:** a cross-room catch-up tool (`feed get --since
--types mentions,needs_action,...`) — one call answering "what did I miss across all my
   rooms." Not in the room-participation spec; cheap, validated, and exactly what a
   welcome-back agent needs when it wakes.
6. **Runtime gate:** Codex and OpenCode sessions cannot receive the in-process MCP server
   (`supportsMcp: false`) — room tools reach them only via external `/mcp`. RP6's join-time
   capability gate (`ROOM_AGENT_CANNOT_POST`) handles this; keep it.
7. **Read state:** today's "new messages" divider is two disagreeing mechanisms (chat sessions:
   per-browser localStorage watermark; rooms: server-side `last_read_seq` whose writes are
   never broadcast — second device catches up only by 30s poll). Recommended: one
   `read_cursors` table (`user_id, thread_kind, thread_id, last_read_seq, updated_at`) serving
   sessions + DMs + rooms + inbox, cursor writes broadcast on the existing `eventFanOut` bus,
   private-marker-first with social receipts as a later additive layer (Matrix's
   `m.fully_read` vs `m.read` split). `CommunityAdapter` already carries
   `getReadCursor`/`setReadCursor` + a `readCursor` capability field — the community-server
   seam pre-exists.
8. **Room↔session identity (softens risk #1):** healthier than the risk note implied —
   post-incident work added durable room notices, structured refusal/dispatch logs,
   `/api/debug/*` probes, and live rebinding on session renames. The placeholder-id dance
   remains structurally, but Phase 0 shrinks to: RP3 cursor advance + the thread-over-sessions
   ADR.

## Addendum 2 — third round (2026-08-07, after research verdicts)

**Two conversation models, both kept (Dorian's clarification):**

- **Direct chat with an agent** (the `/session` surface): the SESSION is the durable thing —
  runtime-owned transcript, resumed directly. Unchanged, kept deliberately.
- **DMs and rooms**: the THREAD (the room log) is the durable thing; sessions underneath are
  interchangeable and may be swapped or lost — agents rebuild context by reading the thread.
- This split already exists in code (room turns ride the room log; direct chats ride the
  transcript). The thread-over-sessions ADR therefore _documents and blesses_ the split —
  no migration of direct chats.

**Context delivery — final architecture (push/pull hybrid, session-swap-safe):**

1. **Turn start — PUSH**: the triggering message + a capped unread delta + a realtime snapshot
   (roster, who's working, reply budget). The delta anchors on the room-membership cursor
   (`room_members.last_read_seq`), which survives session swaps because it lives on the
   membership row, not the session. When the underlying session is fresh (new or swapped), the
   push becomes a **bootstrap window** (recent N + truncation flag) instead of a pure delta —
   a fresh session has seen nothing regardless of the cursor.
2. **Mid-turn — PULL**: `read_room_history` / `search_room_history` / current-state tools.
   No mid-turn push ever interrupts a composing agent; instead **tool responses piggyback**
   a "N new messages arrived since your turn started" notice (especially on `post_to_room`'s
   response), so the agent learns of developments at its own action points.
3. **Turn end**: the cursor advances (RP3).
4. How the agent knows to pull (Dorian's 2.b): the pushed room-context block self-documents —
   `pendingTruncated: true` + the tool names + a one-line instruction, mirroring Buzz. Exact
   tool schemas → SPECIFY, building on RP6/RP7's existing drafts.

**Tasks & Relay defaults (Dorian's directive):** flip both to on-by-default; keep a
user-facing disable toggle in Settings (the Tools tab already reads both flags — confirm it
can toggle them, add if not). Mystery solved: Dorian's own `~/.dork/config.json` already
enables relay (`relayTools: true`), which is why his agents talk over Relay despite the
off-by-default — fresh installs are the ones affected by the flip.

**Codex/OpenCode in-process MCP gap (answered):** a THEIR-side SDK limitation — Claude Code's
SDK has an in-process MCP transport seam; the Codex and OpenCode SDKs do not (Codex carries a
single hard-wired `dorkos_ui` stub only, `runtime-constants.ts`). Our workaround shape already
exists: `supportsManagedMcpServers: true` — Codex accepts external MCP servers injected
per-turn (`--config mcp_servers.*`, stdio + streamable-HTTP, DOR-892). Plan: room tools ship
on the external `/mcp` (streamable-HTTP) surface as well as in-process, and get injected as a
managed server for Codex/OpenCode room sessions; RP6's join-time capability gate
(`ROOM_AGENT_CANNOT_POST`) stays as the honest fallback for sessions where even that is
unavailable.
