# Design Decisions — Sidebar simplification

Visual companion session: `.dork/visual-companion/88892-1787170146/` (screens
`01-structure.html`, `02-sidebar-review.html`). Evidence and citations:
`research/20260819_sidebar-simplification-review.md`. Every decision below was
made explicitly by Dorian on 2026-08-19 unless marked (derived).

The brief, in Dorian's words: "More than anything else, I want this pass to
focus on the simplification of the UI/UX."

---

## 1. Structure: how many levels, one header style

**Screen:** `02-sidebar-review.html` §1 (also `01-structure.html`)
**Options:** 1A · Stepped — keep three levels (zone label / section header /
rows), make each step real · 1B · Flat — two levels, one header style, drop the
"Library" label
**Chosen:** **1B.** "Let's go with B, two levels and one header style."

What it means, concretely:

- **One header component** for Heads up, Today, Channels, Direct messages,
  Agents (and sections, §3): the current zone-label style — 11px, medium,
  `text-sidebar-foreground/70`, no icon — at **x = 12px**. Hover/focus reveals a
  chevron and the existing `+` at the right. Click anywhere on the header
  folds/unfolds (the existing section behaviour, extended to all headers).
- **Rows**: glyph slot at **x = 20px**, label at **x = 46px**, for every row type
  — channel, DM, agent, session, digest, roll-up. The agent row stops reaching
  the label column by different arithmetic (`AgentIdentity` in the title slot);
  it uses the same glyph slot as everyone else.
- **Nested rows** (a section's members, §3): header at x = 24, glyph at 32,
  label at **58**. One level, never two.
- **Tokens, not literals.** `--sidebar-header-x`, `--sidebar-row-x`,
  `--sidebar-nested-x` (names indicative); the gutter e2e spec asserts the
  tokens, not `16px`.
- **The visible "Library" `<h2>` is removed.** The zone id `library`, the
  section ids `pins / channels / dms / agents`, the persisted collapse keys and
  the DnD container ids all stay; the `<section>` keeps `aria-label="Library"`
  so assistive tech still names the region. Same pattern as DOR-1155 (label
  only, never the id). Alt-click fold-all keeps enumerating the Library zone.
- **Heads up keeps its tint.** "Computed vs. yours" is carried by tint and
  position now, not by a word.
- **Header icons go** (the `#`, bubble and robot on Channels / Direct messages /
  Agents) — the rows under them carry the glyph.
- (derived) **All headers fold**, including Heads up and Today — one rule
  ("headers fold") beats an exception. A folded header shows its roll-up
  (`roll-up-collapsed-section.ts` already computes "N · 1 unread"). Open item:
  confirm at SPECIFY.
- (derived) **Mobile**: the bottom tab that showed the Library panel keeps the
  name "Library" as a place name, or becomes "All" — pick at SPECIFY; the panel
  contents are unchanged.

Why B over A: A keeps "Library" and makes the hierarchy unambiguous, but it
costs Library rows 16px of label width, puts Today rows and channel rows on
different x (looks uneven), and asks a 272px panel to teach three levels. B
has one header, one indent, nothing to learn, and every row label on one x.

Also fixed under either option (so included in this decision):

- **The multi-party DM stack.** `SidebarRow`'s 18px glyph slot uses
  `justify-center`; a 2-face stack (34px) spills 8px left of the gutter and a
  3-face stack (48px) overlaps the title by ~7px. Fix: `justify-start` on the
  slot, cap the sidebar stack at **2 faces** with `-space-x-3.5` (20 + 20 − 14
  = 26px — exactly the room between slot and title). Optionally make the `xs`
  disc 18px so a single-face DM and a `#` are truly flush.

## 2. One way to talk to an agent

**Screen:** `02-sidebar-review.html` §2
**Options:** 2A · The agent row is the one door; sessions are the conversation
· 2B · The DM is the door; the session is "open the engine"
**Chosen:** **2A.**

The facts that drove it (all cited in the review, §3.3): a 1:1 DM is a room
whose backing session runs with `cwd = the agent's own directory` and the
agent's own runtime — "a session where you didn't pick a folder" — and the DM
view renders the agent's final words only: no tool cards, no thinking, no
slash commands, no permission mode, no model picker, no queue/steer, no fork.
The session view has all of that and no unread / reactions / threads. The same
agent showed twice in the sidebar with two click results. `specs/rooms` §8.5
named this exact outcome and the exit: "the two should converge and one should
go."

What 2A means:

1. **Clicking an agent opens its session** (as today, BC-34). That row is _the_
   1:1 line to an agent.
2. **One agent = a session; two or more = a group conversation.** The
   `Direct message…` entry becomes `Group message…` (or keeps its name and
   states the rule in the picker); picking exactly one agent opens a session.
   `+ New` reads: **Session · Channel… · Group message… · Agent… · Section…**
3. **Hand-made 1:1 DMs stop being created.** Existing ones that are empty are
   archived once on upgrade (open item: confirm tidy vs. leave). 1:1 DMs that
   still arise — agent-initiated (`relay_notify_user` → `notify-dm.ts`) and
   bridged Telegram/Slack private chats — **surface in Today** with a dot when
   they have something for you and put a dot on the agent row. They are not a
   standing second list. Reachable any time via ⌘K `@name` and the agent's
   profile → Rooms.
4. **One verb.** Team page "Chat with X" and profile "Message" — both open a
   session today — become **Open session**.
5. **Later, one boolean at a time**: unread on sessions (needs a read cursor
   sessions don't have), then reactions/threads (needs a sidecar — runtime-owned
   transcripts can't be written into; that is why rooms exist). Each is one flag
   in `session-capabilities.ts` once the store exists.

What 2B would have been, and why not now: the Slack model — click an agent,
land in a persistent chat with unread, reactions, threads, agent-initiated;
"Open its session" drills into the engine. Right for Ikechi and the north star
once rooms can render engine output. Today the room log keeps final text only
(ADR 260726-170125 refuses token deltas; ADR 260731-211050 persists turn
boundaries) and room slash commands are designed and unbuilt (DOR-603). You'd
click an agent and not see what it's doing — wrong for the launch persona.

Storage is untouched: ADR 260808-140954 (threads durable in rooms, session
durable in `/session`) stands. 2A removes entry points and adds one Today
rule; it does not merge transcripts.

Spec amendments this implies: `sidebar-now-today-library` BC-34 / BC-45;
`rooms` §8.5 / §14.4 ("a DM has no cwd" is false in code — say what
`docs/concepts/rooms.mdx:28-36` already says); `docs/concepts/rooms.mdx`.

## 3. Sections for anything; how long the Agents list is

**Screen:** `02-sidebar-review.html` §3
**Options:** 3A · Sections are top-level and hold anything; Agents shows recent

- pinned · 3B · Keep groups nested under Agents; rename and unlock only
  **Chosen:** **3A.**

Correction recorded first: groups **already** hold agents, channels and DMs
(`SidebarItemRefSchema = agent | room`, DOR-581; room rows carry the same
"Move to group ▸"; DnD is kind-agnostic). Sessions are excluded by design
(time-ordered; a curated list goes stale in a day); workspaces and tasks have
no sidebar row at all. So "put anything in a group" is already true for
everything in the sidebar's stable part — the UI just doesn't say so: the menu
item is "Agent group", groups render _under_ Agents even when they hold only
channels, and the affordance is gated on ≥8 agents / ≥2 runtimes.

What 3A means:

- **"Agent group" → "Section."** In `+ New`, in header menus, in row menus
  ("Move to section ▸"), in the empty hint ("Drag channels, conversations or
  agents here").
- **Sections render top-level**, as peers of Channels / Direct messages /
  Agents — **sections first**, in the operator's order, then the three fixed
  sections. (derived) A section holding only channels no longer lives under
  "Agents".
- **Always offered** — no 8-agent gate for manual sections. Smart sections keep
  the gate (their presets need a fleet) and stay **agent-only** (the rule fields
  are agent attributes; a room-shaped rule language would be a feature, not a
  generalisation — `specs/sidebar-groups/01-ideation.md:56`).
- **One nesting level** stays the cap.
- **Agents shows recent + pinned + grouped, then one live row "All N agents
  →"** that opens `/team`. "Recent" = the existing `inactive` attention
  boundary, tightened (proposed: 7 days of _your_ activity, floor of 8 rows —
  confirm at SPECIFY). The Team page is the directory, as Slack's People is.
  This also gives the dead "N inactive" row (DOR-1105) its destination.
- **Fix first, before any of the above lands:** group `displayFilter` is
  persisted and offered but never applied; "Mute" on a smart group is a no-op;
  a mixed section sorted by "Recent" sinks every room; "New group…" from a room
  row mounts its input under Agents; stale `filterSidebarItems` docs; spec R3
  vs. code on ungrouped manual reorder.

Why 3A over 3B: 3B is a tiny diff but leaves a channels-only section under
"Agents" and the list as long as the fleet. The user's instinct — Slack doesn't
list every person — is right, and because an agent is also a project it is
doubly right: a cold project shouldn't cost a row forever.

## 4. The bottom of the sidebar

**Screen:** `02-sidebar-review.html` §4
**Options:** 4A · One bottom slot: pinned above the footer, one card at a time,
× always · 4B · Just pin the promo stack as it is (up to 3), add ×
**Chosen:** **4A.**

The facts: `PromoSlot` is the last child _inside_ the scroller
(`DashboardSidebar.tsx:61`), so a long list pushes it below the fold for good.
The sidebar `PromoCard` has **no dismiss control** — the spec placed the × on
the `dashboard-main` standard format, and that placement was retired with
`team-room-home`. `remote-access` ("Use DorkOS on the go") is
`shouldShow: () => true`. Dismissal is localStorage, per browser. The footer
already stacks `ProgressCard` + `ProfilePromptCard` + `SidebarFooterStrip`
(with the update pill). Mobile never mounts the slot. The playground shows the
slot free-floating, so the bug is invisible there.

What 4A means:

- **One bottom-slot component**, a sibling of the scroller inside the sidebar
  `<nav>` (`shrink-0 px-2 pb-2 empty:p-0`, the `EmbedSidebar.tsx:100-120`
  precedent), that **arbitrates** promo / getting-started progress / profile
  prompt / update pill.
- **One card visible**, highest priority wins; the next waits its turn.
  Proposed order: getting-started progress > update pill > profile prompt >
  promo — confirm at SPECIFY.
- **× always.** Dismissal persisted in config (join `dismissedUpgradeVersions`
  with a `dismissedPromoIds`), so it syncs across devices.
- `maxUnits` 3 → 1. `remote-access` gets a real trigger (not the desktop app
  _and_ no remote access configured) or is deleted.
- Playground gains "slot inside a 272px panel with an overflowing list";
  `DashboardSidebar.test.tsx` gains an assertion (the promo is `vi.mock`ed to
  `null` there today). The file-size / no-model-read guard on
  `DashboardSidebar.tsx` still passes for a JSX move.
- (derived) **Reduced motion**: the slot's `layout` animation is suppressed
  along with its entrance.

## 5. Motion — approved as written

**Screen:** `02-sidebar-review.html` (demos under §4)
**Chosen:** "Everything you put for Motion looks good to me."

Already good and kept: the "All clear ✓" beat, the damped Getting-started
return (never under the pointer), the Today order hold, the directional body
swap, reduced-motion respected throughout. What's added — all 120–200 ms, one
easing, nothing loops, all off under reduced motion:

1. **Fold with a count** — collapse is a height spring + chevron turn; a
   folded header shows its quiet roll-up ("3 · 1 unread").
2. **Arrive, settle, no pulse** — a new row slides in from its header and
   flashes the row tint once (200 ms); unread is weight + dot, never a looping
   glow.
3. **Bottom slot rises once** — only when a card newly qualifies, never on
   every render; × collapses height.
4. **Lift, ring, settle** — drag lifts 2% with a shadow; the drop target shows
   a 2px inset ring, not a background wash; settle with a short spring. Use
   motion `layout` on rows that move between or within zones (the 4am archive,
   a "Move to section", a Today reorder after the hold releases) so the eye can
   follow.

Rule: motion explains a state change the user didn't cause; it never decorates,
never repeats, and a hovering hand pauses it (the Today-hold pattern, applied
everywhere). Delight items carried forward: drop an agent on a channel row to
add it; the agent row whispers the hottest session's verb; the header tooltip
says Alt-click folds all.

## 6. Initial load

**Added by Dorian after the four picks:** "One additional thing to consider is
how the sidebar initially loads. We should make the initial load EXTREMELY
polished."

**What the trace found (code-only, 2026-08-19; the evidence is in the review
doc's load appendix):** the shell paints nothing until `GET /api/config`
returns; then the sidebar renders with zero server data because **"pending"
and "empty" are the same value everywhere in the model** — no zone, no
skeleton, only the always-on promo card and the Getting-started progress card
fading up in the footer. Then, in roughly this order, the panel pops in from
nothing: Heads up ("N working", from the WS snapshot) → pins/groups/collapse
(the sidebar's config is a **second, sequential** fetch under a different key)
→ Channels + Direct messages (~60 rows) → Agents (~30 rows, all `'fresh'`
because recents are pending) → recents land and Agents **collapses to a
handful + "26 inactive"** → a second `recent-sessions` fetch gives every Today
row a second line → manifests land and **every agent name and face flips**
(DOR-1143; DM stacks flip together) → profile prompt slides up in the footer →
"Your team" becomes the operator's name. No query cache persists across
reloads; nothing remembers the panel's last shape; the scroll-to-active can
fire a smooth scroll unprompted on `/channels`; the one designed load moment
(BC-49 welcome-back glow) is built and wired to nothing; the skeleton primitive
exists and is unused.

**Decided (derived — Dorian delegated the remaining decisions):**

1. **Paint what you know, reserve what you don't, reveal once.** The sidebar
   may paint in exactly two ways: _warm_ (from a local cache, in its final
   shape, in the first frame, with no animation) or _cold_ (a skeleton of the
   final geometry that is replaced by the real panel in **one** reveal). It
   never assembles itself in front of the user.
2. **Boot from local memory.** Persist the TanStack Query cache for the boot
   queries only — config, rooms, threads, mesh agent paths, resolved manifests,
   recent sessions, team roster — with `@tanstack/react-query-persist-client` +
   a sync storage persister, allow-listed by `shouldDehydrateQuery`, keyed by
   server origin, busted by app version, `maxAge` 24 h. Web `HttpTransport`
   only; the Obsidian `DirectTransport` does not persist. A reload paints the
   last-known panel in the first frame (names, faces, prefs, groups, rooms,
   sessions), then refetches in the background and reconciles; rows that move
   or leave do so with `layout` motion, never a pop.
3. **Pending is not empty.** `useSidebarState` exposes a `boot` state
   (`cold | warm | settled`) and the model's "roster resolved" gate widens to
   the full boot set (config **and** rooms **and** mesh **and** manifests
   **and** recents). Until the gate opens on a cold boot the panel shows the
   skeleton (`SidebarMenuSkeleton`, which already exists), with header rows and
   ~8 row bones in the final geometry; the bottom slot and the footer paint in
   their final state. Timeout 1.5 s: if a query is still pending, paint what
   settled and let the rest reconcile (per-query degradation, never a hold
   forever).
4. **One reveal.** Cold only: when the gate opens, the skeleton cross-fades
   into the real panel once (160 ms, opacity + 4 px rise, one stagger of
   ~30 ms per zone — never per row). Warm: nothing animates. Reduced motion:
   instant in both.
5. **Identity never flips.** Agent rows and DM stacks paint only with resolved
   manifests (the gate); the path-hash fallback remains only for directories
   that have no manifest, where it is final. The `sidebar-item.ts` comment
   asserting faces never change is deleted with the fix (DOR-1143 closes).
6. **One fetch per fact.** `['config']` and `['config','current']` become one
   query (fixes the late Library restructure and the digest's defeated
   once-a-day latch). The two `recent-sessions` requests (10 and 24) become one
   (limit 24, `select` for the sidebar's 10).
7. **Agents never over-paints.** With the gate, `'fresh'`-because-pending is
   unreachable; with 3A, the list is recent + pinned from the first frame.
8. **Scroll-to-active on boot is instant and before paint.** The anchor latches
   at the first _settled_ model (not at `TodayZone` mount), positions with
   `behavior: 'auto'` in a layout effect, and only ever smooth-scrolls on a
   real conversation switch after boot.
9. **The bottom slot paints with the panel** (4A). Its "rises once" rule means
   "not on boot": on a warm or cold-revealed paint the slot is simply there.
   `ProgressCard` / `ProfilePromptCard` stop animating on mount; they are
   cards the slot arbitrates.
10. **The header never says "Your team" to a returning user.** Roster rides the
    cache; on a cold boot the team name is a skeleton pill, not a placeholder
    word. Ask DorkBot stays disabled until mesh answers (honest).
11. **BC-49 (welcome-back glow) is removed**, not wired: the digest row already
    carries "while you were away", and nothing should glow on first paint.
    Spec amendment in `sidebar-now-today-library`.
12. **Evidence bar.** A browser test on a warm cache asserts that no row's
    bounding box moves between first paint + 100 ms and + 2 s (the sidebar's
    own CLS budget: zero on warm, one reveal on cold); a unit test asserts the
    boot gate set; the playground gains "cold skeleton" and "warm paint" states.

## 7. Not decided here (open for SPECIFY)

- Fold-all-headers confirmation (§1)
- "Recent" threshold and floor for the Agents list (§3)
- Bottom-slot priority order (§4)
- Mobile tab name for the old Library panel (§1)
- Tidy of existing empty hand-made 1:1 DMs (§2)
- `remote-access` promo trigger (§4)
- Whether "group message" and "channel" should later become one thing (both
  are rooms; the remaining difference is a slug and a topic) — noted, not
  decided.
