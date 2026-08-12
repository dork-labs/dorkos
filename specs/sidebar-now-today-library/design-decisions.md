# Design Decisions — Sidebar: Heads up / Today / Library

Visual companion sessions: `.dork/visual-companion/19627-1786276365/` (screens
teardown → session-02) and `.dork/visual-companion/9729-1786282982/` (screens
session-03 → session-05). Design meta reference:
`research/20260809_design-meta-2026-learnings.md`. Code audits from this
session: sidebar map, avatar/status inventory, activity-signal inventory
(summarized inline where load-bearing).

Every decision below was made explicitly by Dorian during the session unless
marked (derived) — those follow from the codified design rules.

---

## 1. Direction

**Screen:** `session-01-directions.html`
**Options:** A · Tighten (fix in place) / B · Mission control (attention inbox,
restructure) / C · Now / Today / Library (time-and-urgency zones)
**Chosen:** **C**, folding in B's New button and a permanent help affordance.
Reasoning: "We're still in beta, now is the time to reshape the product. We want
a step change in UI/UX, not just conventional." Relearning cost accepted;
"meet your new sidebar" onboarding tour explicitly **skipped** (few users).

## 2. The zone system

- Three zones: **Heads up**, **Today**, **Library** (+ **Getting started**,
  which is the day-one life stage of Heads up — same engine, same slot).
- **Renamed 2026-08-11 (DOR-1155): the first zone's label is "Heads up."** Label
  only — the id stays `now` in the model, the DOM and config, because renaming
  it costs a config migration and buys the user nothing. "Now" read temporally,
  so the operator looked in this zone for the agent that was currently running;
  the zone actually holds what he should know about (agents waiting on him,
  plus the rolled-up "N working" line). Every "Heads up" below is the zone this
  document first named "Now"; quoted decisions from the 2026-08-09 session are
  left verbatim.
- Zone labels are **landmarks, never accordions**: they cannot collapse. A zone
  with no content **disappears entirely** — an empty box is never rendered
  (decided: "Now zone disappears entirely", screen session-02, click-confirmed).
- **Heads up** = needs-you items + working rollup. Priority: permission prompts →
  questions → wedged/error → idle-timeout nudges. Max 3 visible + "+ N more";
  working sessions aggregate to one line ("6 working"), never N pulsing rows.
  Never scrolls.
- **Today** = unified recents (sessions, channels, DMs, threads). Sorted by
  _the user's_ last interaction — never by agent activity (rows must not jump
  while watched; live-ness pulses in place). ~8 rows; automated sessions behind
  "+ N automated"; quiet items archive overnight, recoverable via ⌘K. Morning
  digest row ("While you were away…") appears once per day when relevant.
- **Library** = stable manual structure: Pins (top), Channels, Direct messages,
  Agents (groups nested inside as sub-headers, one indent level). Sections are
  the accordions: **click anywhere on the section row toggles expand/collapse**
  (decided, click-confirmed). Destinations are always leaf rows, so
  select-vs-expand is never ambiguous. Collapsed sections keep signal: unread
  badges and "N working" roll up onto the row. Alt-click a chevron =
  collapse/expand all. Section chrome appears by data volume (no DM section
  until a DM exists; group affordances at ~8 agents / 2+ runtimes).
- **Threads** live in Today as conversations with a thread origin mark (agreed
  2026-08-09). **Pins** live at the top of Library (agreed). The
  **marketplace sidebar takeover** (`sidebar.body` slot) survives unchanged in
  architecture, restyled (agreed).

## 3. Row grammar (one template for every row)

**Screen:** `session-04-live-mix.html`

`[glyph] [who] [› title] [trailing]`

- Glyph (fixed 18px slot): agent avatar = session/agent, `#` = channel, person
  avatar = DM, face-stack = group DM. The glyph carries the type; row chrome
  never changes per type.
- **Sessions always carry attribution**: `Agent › title`. The `›` itself is the
  session marker — its absence means "this is the place, not a thread of it."
- Same agent with several sessions = several rows; **the name repeats on
  purpose** (stable scan anchor; structural clustering rejected because Today's
  shape would churn as sessions come and go).
- Truncation budget: agent name capped at **42%** of the text line (then
  ellipsis); title flexes with a ~6-char minimum; trailing meta never pushed
  off. Full `Agent › Title` in the tooltip. System assists: session title
  generator biased to ≤4 words; `disambiguateDisplayNames` already exists.
- Two-line rows **only** when there is live status to show (the verb) or a
  preview worth showing; height differences carry meaning.
- Overflow menu: vertical kebab (⋮), hover/focus-revealed, narrow gutter.
- Origin marks (small muted glyph, trailing — never on the avatar): none =
  human↔agent chat, timer = task/scheduled, paper plane = Telegram/external,
  `#` = room-triggered, arrows = agent-to-agent. Same glyph set in Today, the
  session switcher, "+N automated", and Activity.

## 4. Agents and sessions

**Screens:** `session-03-conversations.html`, `session-04-live-mix.html`

- **Clicking an agent opens the most recent human conversation** (decided,
  option A) — "an agent is a teammate, not a folder." Fresh session if none.
- The inline 3-session expansion panel (`AgentListItem`) is **removed**. Depth
  moves to the **session switcher**: responsive surface (dialog on desktop,
  bottom sheet + long-press on mobile; also reachable from ⌘K and the agent
  row's "N live" chip). Groups: Live now (with verbs; multiple concurrent
  sessions are just multiple rows), Recent (with one-line outcomes), Automated
  (collapsed, origin-marked). Current session tagged. Footer: ↵ continue,
  ⌘↵ new, ⇧↵ fork.
- Agent rows in Library show: avatar + name + status (see §6) + "N live" chip
  when multiple sessions run concurrently.
- **The active-conversation anchor**: the open conversation is always Today's
  first row, pinned while open, carrying live status. This solves "my agent is
  40 rows down and I can't see if it's working" with zero new UI. It is not
  placed in Heads up because Heads up means "needs you" — being where the user already is
  would teach them to ignore Heads up.
- **Scroll-to-active** (decided): on conversation switch, the sidebar scrolls
  the anchor into view. Guardrails: never auto-expand a collapsed section (the
  Library copy just gets an active tint if visible — dual presence), instant
  jump under reduced-motion, and never scroll while the user is reading — only
  on switch.
- Automated sessions never claim a top-level Today row; they stay behind the
  reveal unless they need you (then they're in Heads up).

## 5. Activity verbs (the honesty ladder)

**Screen:** `session-05-signals.html`; code audit confirmed feasibility.

1. Specific verb ("editing RoomRow.tsx", "running pnpm test") when a live
   `tool_call` event carries a recognizable name+input. Claude Code: always;
   Codex/OpenCode: generic-but-honest forms ("running a command…").
2. "working…" when a turn is streaming and the tool is unknown (guaranteed on
   all runtimes by the lifecycle contract).
3. "waiting on you" when blocked (also a Heads up item).
4. Nothing when idle. **Degrade down the ladder, never guess.**

Engineering gap (the one real server task): the fleet-wide session-list stream
carries only lifecycle today — piggyback a throttled `activity` label onto its
`session_status` events, derived from the latest tool_call via the normalizer,
cleared on `turn_end`. Bonus: replace the chat status strip's randomized joke
verbs with the same ladder — one verb system everywhere.

## 6. Avatar signal system (three layers, three homes)

**Screen:** `session-05-signals.html`; full inventory in the session audit.

- **Top-right corner = status dot**: green + soft pulse = a turn is streaming
  _right now_; amber static = needs you; red static = error/wedged; nothing =
  idle. Only "working" ever pulses (motion-safe), one shared animation.
- **Bottom-right corner = identity badge** (existing system, kept): Bot mark
  for agents, platform logo for bridged humans. Static, permanent. Square
  avatar = agent, circle = person (kept).
- **Trailing in the row = session origin marks.** Origin never renders on the
  avatar; the corner belongs to identity.
- Cleanups mandated by the audit: (1) "working" currently renders 5 different
  ways with 3 color spellings — consolidate to the corner dot + optional verb
  text, one `status-*` token set; (2) the avatar pulse is currently wired to a
  ~1-hour heartbeat proxy in most call sites — the dot must mean live streaming
  only, heartbeat freshness moves to the hover card; (3) retire the health ring
  from list rows (keep in Agent Hub hero); (4) one shared glyph registry for
  kind/origin so the corner badge and origin marks can't drift; (5) move the
  Agent Hub hero's hover pencil off the avatar corner.

## 7. Header, New button, Ask DorkBot, footer

**Screens:** `session-02-c-deep-dive.html`, follow-up discussion 2026-08-09.

- **Header = workspace switcher-in-waiting**: top-left block shows the
  workspace, named after the operator ("Dorian's team"), and is a button from
  day one → menu with workspace settings, account, and a quiet version line
  ("v0.58.0 beta · Check for updates"). When communities ship they appear as
  additional rows in this same menu (Slack-style switcher): single-player →
  multi-player is "the menu gets longer," zero relayout.
- **Version number is hidden from the chrome** (decided). It lives in that menu
  - in DorkBot's seeded context. **Update-ready** renders as a transient footer
    pill ("Update ready — Restart") that exists only while true. Updates never
    enter Heads up (Heads up = your agents need you).
- **One "New" button** (from B, decided): the only create surface — Session
  (⌘N, ↵ = last-used agent), Channel, Direct message, Agent…, Agent group.
  Section hover `+` deep-links into this same menu pre-selected. Kills the
  scattered-creates problem (old issue 7).
- **⌘K pill** sits under the header ("Jump to anything…").
- **Ask DorkBot** (decided): permanent ✦ affordance in the footer strip + first
  Getting-started suggestion + a mobile tab. Opens a fresh DorkBot session
  **pre-seeded with context** (current page, fleet size, recent errors) via a
  hidden server-side preamble. Engineering gap: no start-with-prompt mechanism
  exists today — add a `prompt` deep-link param on `/session` (generally
  useful) and a server-side `seedContext` on first message.
- **Footer** shrinks to one slim tinted strip: destination icons (Home, Team,
  Marketplace, Connections) + Ask DorkBot. No logo block, no version line.
  Separation by tint, not border.

## 8. Empty states and the user journey

**Screen:** `session-02-c-deep-dive.html` §1, revised in
`session-03-conversations.html` §3.

- The sidebar is never empty: DorkBot + #team are seeded at install.
- Day one: **Getting started** zone (the first life stage of Heads up) with **computed**
  suggestions, never a static checklist: discovery found agents → "Meet the N
  agents we found"; none found → "Add your first agent" (fallback only); agents
  never ran → "Start your first session"; plus "Say hi in #team", "Ask DorkBot
  anything". Items retire permanently when done; the zone becomes Heads up as real
  signals take over.
- Quiet morning: no Heads up zone; Today opens with the welcome-back digest. Truly
  nothing: Library stands alone — absence is the calm signal.
- Power user (30+ agents): Heads up capped with rollups; Library collapsed rows
  carry counts ("32 · 6 working"); density scales, chrome doesn't.

## 9. Mobile

**Screen:** `session-02-c-deep-dive.html` §4.

- The drawer dies. Heads up + Today become the **Home tab** content. Four bottom
  tabs: Home (badged with needs-you count) · Library · DorkBot · You.
- No FAB; "New" stays in the header. Long-press replaces hover (the dual-render
  menu system already guarantees context menus exist everywhere). Rows grow to
  40–44px. "Catch up" bulk action tops Today. Approvals inline in Heads up =
  approve-from-anywhere.

## 10. Moments

**Screen:** `session-02-c-deep-dive.html` §5. Welcome-back glow (row glows
amber once for work finished while away), the all-clear beat (Heads up settles with
"All clear ✓" then folds away), the morning digest (once per day, dissolves if
ignored), suggestions that retire, approve-from-anywhere. The "meet your new
sidebar" tour is **cut** (decided — user count doesn't justify it).

## 11. Visual language (from the design-meta doc, applied)

Density: 13px labels / 11px meta, 28px rows (40+ on touch), **16px total left
inset**, one indent level (14px), sidebar ~272px. Sentence-case section labels
(caps retired). Separation by whitespace and 5–10% tint (zones are tinted
cards; no hairline borders; scroll-edge shadows where needed). Nothing renders
at rest: `+`/⋮/chevrons appear on hover and focus-visible, with mobile
always-visible or long-press equivalents. Icon↔chevron morph on section
headers. Two-tier unread: bold+dot = activity, numbered badge = direct/needs
you. Dark mode: same tint logic, calibration pass required (open).

## 12. DX architecture (how the rules stay understandable)

Decided direction (2026-08-09): **a convention, not a framework.**

- One pure function `buildSidebarModel(state) → SidebarModel` in the feature's
  `model/`: every rule above (zone visibility, Heads up priority/cap, anchor,
  digest, retirement, rollups) is a small named, TSDoc'd function composed
  inside. Components render the model; no logic in JSX.
- **Every row/zone carries a `reason` field** (provenance):
  `'now:permission-prompt'`, `'anchor:active-session'`,
  `'suggestion:agents-found'` — "why is this here?" is answerable in devtools
  for any row, ever.
- Journey states (first-run / quiet / busy / power) become **fixtures** driving
  both tests and Dev Playground showcases. Playground already seeds real stores
  (`SidebarShowcases` pattern) — this extends it.
- Explicitly rejected: rules DSL, config engine, state-machine library — one
  consumer, and TS functions are the best rule language.
- Consolidation: one `SidebarRow` + one `SectionHeader` primitive replaces the
  duplicated `SidebarSectionHeader`/`GroupHeader` pair and the three row
  implementations. Keep: dual-rendered menus, server-persisted prefs, smart
  groups, mobile auto-close, a11y drag-drop.
- New `contributing/sidebar-model.md` guide when implementing.

## 13. Dev Playground deliverables (required, not optional)

Update: `SidebarShowcases`, `JumpBackInShowcases` (new grammar),
`IdentityMatrixShowcases` + `StatusShowcases` (signal system),
`NavigationShowcases`. Add: `SidebarModelShowcases` (zone fixtures: first-run /
quiet / busy / power), session-switcher showcase, verb-ladder states.

## 14. Engineering follow-ups discovered (file as work items)

1. Fleet-stream `activity` label (server; enables verbs in the sidebar).
2. Start-session-with-prompt: `prompt` deep-link + server `seedContext`
   (enables Ask DorkBot).
3. Avatar signal cleanup (5 renderings → 1; heartbeat-lit pulses fixed;
   token unification) — can land before the redesign.
4. Chat status strip: replace joke verbs with the real ladder.
5. Session title generator: bias to ≤4 words.
6. ⌘K upgrades per the palette design pass (pending).
7. Prefs migration: existing groups/pins/collapse map onto Library.
8. Product media re-shoot after landing (`capturing-product-media`).

## 15. ⌘K design pass (resolved 2026-08-09; all decisions confirmed by Dorian)

**Screen:** `session-06-command-k.html`. Audit summary: the palette is a good
launcher with dead recall paths — sessions are not searchable at all, three row
types are inert (slash commands, the "Continue" suggestion, agent-submenu
session rows), extension actions are registered but never read, archived rooms
are excluded client-side, and global relevance is discarded in favor of fixed
group order. A live FTS5 message index exists server-side with no query route
(`specs/message-search` tasks 5.x unbuilt).

Decisions:

- **⌘K finds things, not words**: agents, sessions, rooms, actions — by name,
  title, recency. Message-content search stays a separate surface (upholds the
  recorded ⌘K/⌘F split in `specs/rooms/02-specification.md` §517 and
  `specs/message-search` §8); ⌘K's last row hands off ("Search messages for
  'x'…"). C's "archived overnight → find in ⌘K" therefore means by
  title/recency, which is how people recall conversations.
- **Sessions become first-class searchable items** using the sidebar row
  grammar (avatar + Agent › title + origin mark + time), fed by the existing
  cross-agent `/api/sessions/recent` (palette never used it).
- **Zero-query = command center**: Continue (live, with verb) → Recent
  (frecency-blended mix of sessions/rooms/agents, archived items labeled) →
  New actions → prefix legend.
- **One ranked list**: blend Fuse relevance × frecency × recency across types;
  "Best match" section on top; stop discarding scores.
- **Scope chips, not query syntax**: `@agent` / `#channel` resolve into visible
  chips; residual query searches within scope ("sessions with DorkOS").
  Backspace pops the chip. No `agent:foo before:bar` language.
- **One frecency store for all types** (extend the existing Slack-bucket agent
  frecency, key `type:id`).
- **Search + act**: inline shortcut hints on rows (↵ open, ⌘↵ new session with
  agent) — passive shortcut learning.
- **Quick wins independent of the redesign**: fix the three inert row types,
  wire extension `commandHandlers`, pass cwd/runtime to `useCommands()`,
  include archived rooms with a label.

## 16. Workspace concept (audited 2026-08-09)

Audit verdict: **six concepts share the word "workspace."** (1) Managed
Workspace — server-provisioned checkout, the only thing `/workspaces` renders,
currently a **ghost feature**: provisioning requires a `workspaceKey` no client
code ever sends, so the page is permanently empty and its empty-state promise
("provisioned automatically") is false. (2) Agent workspace (harness/scaffold
directory). (3) Git worktrees — created by gtr/flow/EnterWorktree into the
_same directory_ the manager owns, but the manager never scans disk, so they
are never adopted (the `.gtrconfig` comment anticipated adoption that doesn't
exist). (4) Channel workspace (spec only). (5) Shape "workspace chrome"
(UI layout). (6) Toolchain vocabulary (pnpm/Obsidian/Docker).

Also found: `WorkspaceService.sweep()` ignores retention cap/age and would
remove every unpinned workspace if ever wired to a caller (currently zero
callers) — a latent landmine; and a stale comment claiming `worktree-setup.sh`
calls the port API (it doesn't).

Implications adopted for this spec:

- The sidebar/⌘K row grammar uses **"project"** language for the repo/cwd
  dimension (projectKey exists) and avoids the word "workspace" until the
  naming is consolidated (`specs/agent-workspace-binding` — already `specified`
  — has exactly this goal: "one meaning for the phrase").
- The `/workspaces` Home tab's fate is decided in that effort, not here; the
  sidebar redesign does not add workspace UI.
- File as work items: adopt-orphan-worktrees scan, fix or fence `sweep()`,
  fix the stale docs promise on the workspaces page, wire or remove
  `workspaceKey` provisioning.

## 17. Open items (before/at SPECIFY)

- Dark-mode calibration; a11y spec (zone landmarks, roving tabindex,
  Heads up live-region); drag-and-drop scope (Library manual order + keyboard fallback;
  Heads up/Today never draggable); Obsidian EmbedSidebar mapping. Resolve inside
  `02-specification.md`, not as further design rounds.
- Multi-project (repo) context in row grammar — decide placement of project
  meta for operators running one agent across several repos.

## 18. Notification rules (decided 2026-08-09, delegated authority)

Two tiers plus Heads up membership — one table, no exceptions beyond those listed:

| Signal                                            | Rendering                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| Channel has new messages                          | Bold label only. No badge, no dot.                                        |
| Unread DM to you                                  | Numbered amber badge (DMs are direct by nature).                          |
| @mention of you (any room)                        | Numbered amber badge on that row.                                         |
| Agent working                                     | Status dot (avatar corner) + verb. Never affects unread state.            |
| Approval / agent question / wedged / idle-timeout | Heads up zone item. The only things that enter Heads up.                  |
| Automated session activity                        | Nothing. No bold, no badge. Blocking states go to Heads up like the rest. |

- **Mentions and DMs never enter Heads up.** Heads up is reserved for blocked
  work; diluting it with social signals teaches users to ignore it. (An agent
  asking you a question in a DM enters Heads up as a _question_, not as a DM.)
- **Mute** kills bold, badge, and Today eligibility. One exception:
  @mentions pierce mute (badge still renders). Muted rooms stay excluded from
  recents (already the Jump Back In rule; carries to Today).
- **Bold clears on read** via the existing cross-device read cursors
  (DOR-1030).
- **Rollups on collapsed Library sections**: badge = sum of tier-2 counts,
  bold if any tier-1, plus the working count. Signal never lost by folding.
- **No snooze in v1.** Heads up items clear by resolution. Idle-timeout nudges are
  dismissible (hover × / ⋮ menu), and dismissal is permanent for that idle
  episode.
- **Mobile Home tab badge = the Heads up count** (matches "N need you"). Library
  tab carries no badge — it is the calm surface.

## 19. The Heads up ↔ Getting started swap is damped on the way back (decided 2026-08-11, DOR-1144)

**Screens:** none — this was found in the P2.3 review, driving the shipped
build rather than a mockup. Contract: **BC-52**.

The two zones share one slot and §2's rule settles who gets it: real signals
always win. That half is right and is not touched here. The problem was the
_transition_. For a day-one operator who still has unretired suggestions, the
zone left and came back instantly, so every turn an agent started or finished
moved Today about four rows — twice per turn, on a surface the operator is
reading. That is the thing BC-17 already refuses to do to Today's order, being
done to Today's position instead.

**Decided:**

- **The yield stays instant.** A permission prompt, a question, a streaming turn
  — anything real — takes the slot on the frame it exists. Precedence is not
  negotiable and gains nothing from being smoothed.
- **The return waits out a minimum dwell of 5 seconds** from the moment the zone
  stepped aside. A turn that starts and finishes inside that window therefore
  produces no return at all, which is the flap the review found: the zone never
  comes back, so it cannot go away again.
- **The return also waits for the operator's hands to leave the zones**,
  deferring while the pointer is inside the zone stack or a row holds focus.
  This is BC-17's own promise applied to the other axis, and it reuses BC-17's
  own machinery rather than a second copy of it (`useInsideHold`, now shared by
  `useTodayOrderHold` and `useGettingStartedReturn`). Scoped to the zones rather
  than to the whole panel for BC-17's own reason: the zones are what move, and a
  pointer resting in the empty panel beneath them has nothing above it to shift.
  **This half is indefinite, not brief**: a pointer left resting in the zone
  stack holds the return open for as long as it rests there, with no ceiling.
  That is deliberate and is exactly `useTodayOrderHold`'s existing semantics —
  the operator is still in the panel, so the reason not to move anything has not
  expired — and it is bounded in practice by the pointer leaving, which is the
  same event BC-17 already waits on.
- **`prefers-reduced-motion` changes none of it.** The sidebar's other
  reduced-motion rules suppress flourishes — the welcome-back glow, the
  all-clear beat — because those are decoration about something that already
  happened. This is timing, not animation, and the operator who asked for less
  movement is the last one who should get the undamped version.

**The accepted cost, stated plainly:** while the return is held, the slot is
empty, so a short turn now moves Today up in two small steps (the zone leaving,
then the working rollup clearing) and back down once, several seconds later,
instead of thrashing it twice per turn. Movement is not eliminated; it is made
infrequent and never sudden, which is what "rows must not move under a hand"
actually asks for.

**Rejected:**

- _Damping both directions_ — the symmetric implementation, and the obvious one.
  It delays real signals, which is the one thing the zone system exists to
  prevent. The hook is built so this cannot be reintroduced by accident: it can
  only ever subtract the Getting-started zone from the model it is handed, and
  holds no copy of a previous frame to put back.
- _Retiring Getting started the first time it yields_ — cheaper, and it throws
  away suggestions the operator has not acted on because an unrelated agent
  happened to run.
- _Reserving the slot's height so nothing below it ever moves_ — a permanent
  empty box for a transient problem, and BC-1 says a zone with nothing to say
  renders nothing at all.
