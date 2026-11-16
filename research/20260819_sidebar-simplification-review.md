---
title: 'Left sidebar: simplification review (UX, DX, bugs, performance)'
date: 2026-08-19
type: review
status: current
tags: [sidebar, ux, simplification, dms, sessions, groups, promos, motion, ftue]
related:
  - specs/sidebar-now-today-library
  - specs/sidebar-groups
  - specs/smart-agent-groups
  - specs/feature-promo-system
  - specs/rooms
  - specs/unified-conversation
design-session: .dork/visual-companion/88892-1787170146
---

# Left sidebar: simplification review

**What this is.** A deep pass over the cockpit's left sidebar (`apps/client/src/layers/features/dashboard-sidebar/`, ~13k LOC incl. tests) asked for by Dorian on 2026-08-19, with one goal above the rest: **simplify**. Four code traces (render tree, DM-vs-session model, groups, promos/Library) plus a Linear sweep and live measurements on the dogfood cockpit. The mockups live in the visual-companion session named above (`02-sidebar-review.html`).

**Decisions (2026-08-19):** **1B · 2A · 3A · 4A**, motion direction approved as written, plus "make the initial load extremely polished". Decision record: `specs/sidebar-simplification/design-decisions.md`; brief: `specs/sidebar-simplification/01-ideation.md`.

---

## 1. TL;DR

The bones are excellent — the Heads up / Today model, the holds, the "All clear" beat, the one-pure-function model, the contract tests — and the code quality is high (zero TODOs, guarded create surfaces, a 5 ms rebuild budget). The problems are **hierarchy that reads flat, two doors to one agent, groups that are more capable than they look, a bottom slot that nobody can see or dismiss**, and a handful of shipped controls that do nothing.

Seven moves, in the order I'd ship them:

| #   | Move                                                                                                                       | Why                                                                                                                                                                                                                                                                   | Size                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | **Two levels, one header style; drop the "Library" label** (decided: 1B)                                                   | Zone labels at 16px, section headers at 36px, _every_ row at 42px — depth is invisible. Two header styles for three depths.                                                                                                                                           | Small (label + CSS; ids stay)         |
| 2   | **Pin one bottom slot above the footer; × always; dismissal in config**                                                    | Promos sit _inside_ the scroller and the sidebar card has **no dismiss control at all** (its × lived on a retired surface). "Use DorkOS on the go" is `shouldShow: () => true`.                                                                                       | Small                                 |
| 3   | **One door to an agent: the agent row → session. One agent = session; 2+ = group conversation. Stop hand-making 1:1 DMs.** | The same agent appears under Direct messages _and_ Agents with different click results. A 1:1 DM is a session in disguise (same cwd, same runtime) that shows final text only. The rooms spec (§8.5) said: if that turns out true, converge and one goes. It is true. | Medium (mostly removing entry points) |
| 4   | **"Agent group" → "Section"; sections render top-level and take any row**                                                  | Groups already hold channels + DMs (DOR-581) but render under _Agents_, are called "Agent group", and are gated on 8+ agents.                                                                                                                                         | Medium (render + copy)                |
| 5   | **Agents shows recent + pinned, then "All N agents →" (Team)**                                                             | Slack doesn't list every person; an agent is also a project, so a cold project shouldn't cost a row forever. Also fixes the dead "N inactive" row (DOR-1105).[^1105]                                                                                                  | Small–medium                          |
| 6   | **Fix the multi-party DM stack**                                                                                           | 18px glyph slot + `justify-center`: a 2-face stack spills 8px left of the gutter; 3 faces overlap the title by ~7px. `justify-start` + cap at 2 faces with −14px overlap.                                                                                             | Tiny                                  |
| 7   | **Make the shipped controls honest**                                                                                       | Group "Show ▸" filter never applied; "Mute" on a smart group is a no-op; the `section-count` rollup row looks pressable and does nothing[^1105]; "Chat with X" / "Message" open a _session_.                                                                          | Small each                            |

---

## 2. What the sidebar is today (plain words)

One pure function, `buildSidebarModel(state)`, emits four zones in a fixed order:

- **Getting started** — day-one suggestions (up to five: meet the agents we found / add your first agent / start your first session / say hi in #team / ask DorkBot). Shares a slot with Heads up; Heads up always wins.
- **Heads up** (id `now`) — ≤3 things that need _you_: a permission prompt, an agent's question, an error, an idle nudge. "+N more" and "N working" roll-ups. Tinted.
- **Today** — your recents (sessions, channels, DMs, threads), ordered by _your_ last touch so rows never jump under you; capped at 8; a "While you were away…" digest once a day; anything untouched since 4am leaves overnight; "+ N automated" fold.
- **Library** — Pins, Channels, Direct messages, Agents (with groups as sub-headers _inside_ Agents). Never re-orders itself. This is the zone whose label we are removing; its four sections and their persisted ids stay.

Everything hangs off `useSidebarState()` (20-dependency snapshot) → `useSidebarModel()` (memoised build, budget 5 ms, target 2 ms) → `SidebarZones` → `SidebarZone` → `SidebarSection` → `SidebarModelRow` (dispatches to `AgentListItem`, `RoomRow`, or a generic row). Promos, progress card, profile prompt and the footer strip are separate features mounted around it in `DashboardSidebar.tsx` / `AppShell.tsx`.

---

## 3. The five asks

### 3.1 Indent the items under headers more → _decided: 1B_

**Measured (live cockpit, 272px panel):** zone `<h2>` text at **16px**; section header icon at 16, text at **36px**; row label at **42px** for _every_ row type (channel, DM, agent, session, digest, roll-up). The agent row reaches 42 by different arithmetic (16 + 20 disc + 6 gap) than every other row (16 + 18 slot + 8 gap) — a coincidence, not a token. There is **no indent token**; the only indent in the panel is a hard-coded `pl-[14px]` on group sub-headers (`SidebarSection.tsx:120`) deliberately _not_ applied to their rows, because "16px total inset" is a locked decision (design-decisions §11) measured by `apps/e2e/tests/dashboard-sidebar/sidebar-row-gutter.spec.ts`.

**Why it reads flat:** a section header is only 6px left of its rows, uses an icon + 12px text while rows use a glyph + 13px text, and a Today row (depth 2) sits on the same x as a channel row (depth 3).

**1B (chosen):** one header style for Heads up / Today / Channels / Direct messages / Agents — the current zone-label style (11px, medium, muted) at x=12, no icon, hover-revealed chevron + `+` at the right. Rows: glyph at 20, label at **46** everywhere. Groups: sub-header at 24, rows at 32/58 — the only nested level. The `library` zone id, the `pins/channels/dms/agents` section ids, the collapse keys and the DnD zone ids all stay (label-only, the same pattern as the DOR-1155 `now` → "Heads up" rename). Details of what breaks if the zone _id_ were removed are in the Library trace (§B4 below) — we are not doing that.

Decide while implementing: do Heads up / Today fold like the others? I'd say **yes** — one rule ("headers fold") beats an exception, and `roll-up-collapsed-section.ts` already produces a count for a folded section.

### 3.2 Multi-party DM alignment

**Mechanism (measured):** `SidebarRow`'s glyph slot is `size-[18px] … justify-center` (`sidebar-row.tsx:533-539`). `RoomAvatar` renders a 20px disc for one face (already 1px wider than the slot) or a `-space-x-1.5` stack for 2–3 faces (`RoomAvatar.tsx:144-168`): 34px / 48px of content in an 18px box. The slot never grows (flex min-content rule), the _label stays at 42px_, and `justify-center` splits the overflow both ways — so the first face drifts to x=8 (2 faces) or x=1 (3 faces) and the 3-face stack's right edge lands ~7px _on top of the title_.

**Fix:** `justify-start` on the glyph slot (one line, every glyph then starts at the gutter), and for the sidebar size cap the stack at **2 faces with `-space-x-3.5`** (20 + 20 − 14 = 26px, exactly the room between slot and title). Optionally make the `xs` disc 18px so the single-face DM and the `#` are truly flush.

### 3.3 DM with one agent vs. an agent session

**Facts.**

- A 1:1 DM is a room (`rooms.kind='dm'`) whose log is `room_entries`; under it, one backing session per `(room, agent)` in `room_sessions`, created lazily on the first turn with **`cwd = the agent's own directory` and the agent's own runtime** (`room-turn-runner.ts:135,201,268`). So it is "a session where you didn't pick a folder" — and the folder you'd have picked is the same one.
- The DM **view** renders final text only (`render-room-body.tsx`): no tool cards, no thinking, no slash commands, no permission mode / trust dial, no model picker, no queue/steer, no fork, no directory choice. It _does_ have reactions, threads, mentions, presence, stream health, a server-side unread cursor, "add agents later", Telegram/Slack bridging, and **agents can start one** (`relay/notify-dm.ts`).
- The session view has the engine; it has no unread, no reactions, no threads, can't be bridged, can't be started by an agent.
- The client already renders both from one `Conversation` compound with **nine booleans** of difference (`room-capabilities.ts` vs `session-capabilities.ts`); `ConversationSurface`'s `'dm'` value is write-only (no readers).
- The DM's backing session is deliberately filtered out of the agent's conversation list (`partition-sessions-by-origin.ts`, DOR-928) and shows up in the SessionSwitcher under **"Automated"**; `RoomLiveLane` offers "Open its session" from inside a DM — the only bridge.
- Entry points today: `+ New › Session` and `+ New › Direct message…` both mean "talk to an agent". Agent row click → session (BC-34); agent row menu has _New session_ and _Switch session…_, no _Message_. DM row menu has _View profile_, no _Open session_. Team page **"Chat with X"** and profile **"Message"** both open a _session_. The ⌘K palette lists existing DMs ("Message Ana") but cannot start one.
- The rooms spec wrote this down twice (`specs/rooms/02-specification.md` §8.5, §14.4): _"a session is about a directory, a DM is about a participant"_ — and predicted: _"the alternative is that a DM turns out to be just 'a session where you didn't have to pick a directory,' in which case the two should converge and one should go. The outcome to avoid is shipping both permanently without deciding."_ Two of §14.4's consequences no longer hold: "a DM has no cwd" (it does) and "promote to a session is the bridge" (never built). ADR `260808-140954` keeps the _storage_ models apart on purpose (threads durable in rooms; session durable in `/session`) — that stays.

**Recommendation — 2A, "the agent row is the one door; sessions are the conversation."**

1. Clicking an agent opens its session (as today). That row is _the_ 1:1 line.
2. **One agent = session; two or more = group conversation.** The `Direct message…` picker becomes `Group message…` (or keeps its name but states the rule) and opens a session when exactly one agent is picked. `+ New` reads: Session · Channel… · Group message… · Agent… · Section….
3. Hand-made 1:1 DMs stop being created. Existing empty ones get archived once (a tidy, not a migration). 1:1 DMs that still arise (agent-initiated `notify_dm`, bridged Telegram private chats) show **in Today** with a dot when they have something for you, and put a dot on the agent row; they are not a standing second list. Reachable via ⌘K `@name` and the agent's profile → Rooms.
4. Rename the lying verbs: Team "Chat with X" and profile "Message" → **Open session** (one word everywhere).
5. Later, one boolean at a time: give sessions unread (needs a read cursor that doesn't exist yet), then reactions/threads (needs a sidecar — runtime-owned transcripts can't be written into; that's why rooms exist).

**Not yet — 2B, "the DM is the door."** The Slack model and the right north star for Ikechi, but today you'd click an agent and not see what it is doing; the room log keeps final text only (ADR `260726-170125` refuses token deltas; ADR `260731-211050` persists only turn boundaries); room slash commands are designed and unbuilt (DOR-603). Revisit when rooms can render the engine.

Files 2A touches: `NewMenu.tsx:148-198`, `create-flow-store.ts:32-38`, `AgentRowMenuItems.tsx` (unchanged), `SidebarChrome.tsx:224-253`, `NewDirectMessageMenu` (in `features/room-membership`), `agent-columns.tsx:239-244`, `ProfileView.tsx:113-117` + `profile-message.ts`, `AgentSubMenu.tsx:103-106`, `palette-contributions.ts:78`; guards that _should_ go red: `NewMenu.test.tsx`, `one-create-surface.test.ts`, `AgentRowMenuItems.test.tsx`; spec amendments: `sidebar-now-today-library` BC-34/BC-45, `rooms` §8.5/§14.4 ("a DM has no cwd" is false; say what `docs/concepts/rooms.mdx:28-36` already says).

### 3.4 Groups

**Correction:** groups already hold **agents, channels and DMs** (`SidebarItemRefSchema` = `agent | room`, DOR-581; room rows have the same "Move to group ▸" as agent rows; DnD is kind-agnostic). Sessions are excluded by design (time-ordered, they'd go stale in a day; `specs/sidebar-groups/01-ideation.md:52-54`); workspaces and tasks have **no sidebar row at all**, so "put anything in a group" is already true for everything in the Library — the UI just doesn't say so.

What makes them _look_ agent-only: the menu item is literally **"Agent group"**; groups render as sub-headers **inside Agents** even when they hold only channels; the affordance is gated on ≥8 agents or ≥2 runtimes (`offersGroupAffordances`); smart-group rules are agent fields (runtime, namespace, status, last-active, path prefix) — correctly, and not worth generalising.

**Defects found (fix before generalising anything):**

1. A group's `displayFilter` is persisted, offered in the header menu, and **never applied** (`groupSection` never reads it; only ungrouped Agents is filtered). No test asserts it.
2. **"Mute group" on a smart group is a no-op** (`apply-mute-rules.ts:42` skips smart groups) — the menu label flips, nothing dims.
3. A mixed group sorted by "Recent activity" **sinks every room to the bottom** (recency resolver returns `null` for non-agents → `-Infinity`).
4. "New group…" from a _room_ row mounts the name field under **Agents**, possibly off-screen (`useSectionChrome.tsx:291`).
5. Stale doc: `sidebar-item.ts:79,87` cite `filterSidebarItems`, which no longer exists.
6. Spec/impl split: R3 says ungrouped Agents reorders in `manual` mode; the code forbids it twice.

**Recommendation — 3A:** "Agent group" → **Section**. Sections render **top-level** (peers of Channels / Direct messages / Agents, sections first), take any row, are always offered (New menu + header menu), empty hint "Drag channels, conversations or agents here". Smart sections stay agent-only presets ("Active now", per-runtime). Keep one nesting level. Fix the six items above first.

Other real limits worth knowing: single-parent membership (Pins is the only multi-presence); no nesting (research-backed); every group edit is a whole-`ui.sidebar` PATCH (last-write-wins across two browsers); a wrong-_shape_ `ui.sidebar` is classed as config damage and replaced with defaults (`widened-leaves.ts:30-35` — it happened once, DOR-584/585); agents can rewrite your groups via `config_patch` (`agent-writable`); stale refs are never pruned (by design); touch drag is off (long-press sheet instead); keyboard DnD _does_ work.

### 3.5 Promo units at the bottom

**Facts:** `PromoSlot placement="dashboard-sidebar" maxUnits={3}` is the **last child inside the scroller** (`DashboardSidebar.tsx:61`, scroller = `SidebarContent` with `overflow-auto`). Three units qualify: "Use DorkOS on the go" (**`shouldShow: () => true`** — always), "Connect to Slack & Telegram" (relay on + no adapters = factory state), "Run agents while you sleep" (sessions > 0, tasks = 0). **The sidebar card has no × at all** — the spec (`feature-promo-system/02-specification.md:239`) said compact cards are dismissed from the `dashboard-main` standard format, and that placement was retired (`team-room-home/03-tasks.md:249`). Today the only per-unit dismiss path is the home surface's quiet-state one-liner, which reaches only `schedules`/`agent-chat`. Dismissal is **localStorage** (`dorkos-dismissed-promo-ids`), per browser, unlike the update pill which goes to config. The footer already stacks `ProgressCard` + `ProfilePromptCard` + `SidebarFooterStrip` (with the update pill) — up to four competitors at the bottom on day one. Mobile never mounts the slot at all. The playground shows the slot free-floating in a `max-w-xs` box, so the bug is structurally invisible there.

**Recommendation — 4A:** one **bottom slot** component, a sibling of the scroller inside `<nav>` (`shrink-0 px-2 pb-2 empty:p-0`, per the `EmbedSidebar.tsx:100-120` precedent), arbitrating promo / getting-started progress / profile prompt / update pill: highest priority wins, **one card visible**, × always, dismissal persisted in config (`dismissedPromoIds` joins `dismissedUpgradeVersions`). `maxUnits` 3 → 1. Give `remote-access` a real trigger (not on desktop app _and_ no remote access configured) or drop it. Add a playground state that renders the slot inside a 272px panel with an overflowing list. Watch: `DashboardSidebar.test.tsx:964-1000` guards the file at <200 lines and forbids model reads (a JSX move passes); the promo is `vi.mock`ed to `null` there, so add an assertion.

### 3.6 Is the "Library" header needed? → _decided: no (1B)_

It is a visible, non-collapsible `<h2>` landmark (`SidebarZone.tsx:103-108`), the third leg of the Now/Today/Library taxonomy (`specs/sidebar-now-today-library/design-decisions.md:15-58`): its job was _contrastive_ — "Heads up and Today are computed and may move; Library is what you built and never moves". Nothing in specs/ADRs questions it, but nothing mandates the word either. With one header style the contrast is carried by Heads up's tint and by position. Keep the zone **id**, keep `aria-label="Library"` on the `<section>` (so AT still names the region), drop the visible heading; the mobile tab can keep "Library" as a place name or become "All". The Alt-click fold-all (`SidebarZones.tsx:111-137`) enumerates the Library zone's sections and keeps working because the zone stays.

### 3.7 Listing every agent vs. a subset (the Slack thought)

Under 2A the agent row is the one standing door to an agent, so the list must stay — but short. **Show recent (last 7 days of _your_ activity) + pinned + grouped, ≈8 rows, then one live row "All N agents →" to `/team`.** The Team page is the directory, as Slack's People is. That an agent is also a project makes this _more_ right: cold projects cost nothing. The existing `inactive` attention state is the seam; its threshold is just too lenient today (26 shown, 4 hidden in your cockpit). This also gives DOR-1105's dead "N inactive" row a destination.

---

## 4. The user journey

### 4.1 First-time experience (what happens today)

Install → DorkBot + `#team` exist → sidebar shows **Getting started** (top), no Today, Library = Channels(#team) + Agents(DorkBot). Suggestions are _facts, not a checklist_; each retires when the fact flips (one-way, observed as a transition, never on first paint); all retired → the zone is gone forever; Heads up then owns the slot and "All clear ✓" plays 2.5 s when it drains. Discovery is consent-first (no scan is ever started by the sidebar). Yield to Heads up is instant; return is damped ≥5 s and never under the pointer. "Say hi in #team" is wired end-to-end to `RoomSummary.viewerHasPosted` (absent → quiet, so the Obsidian embed doesn't nag). This is good work.

### 4.2 Gaps

1. **Day-one bottom pile-up**: promo ("Use DorkOS on the go", always) + progress card + profile prompt + update pill compete at the bottom before the user has done anything. → §3.5.
2. **"Library" on day one** is a word with no referent for a new user (one channel, one agent). → 1B.
3. **`+ New` offers "Direct message…" with one agent (DorkBot)** — which duplicates DorkBot's session on day one. → 2A.
4. **A roll-up row looks pressable and does nothing** (`section-count`, the "N inactive" row) — DOR-1105. A first-week user hits it.[^1105]
5. **Section `+` is keyboard-unreachable on desktop**: `useRovingFocus.sync` stamps `tabIndex=-1` on every focusable in the section container and the `+` is neither a stop nor a lane satellite, so New channel / DM / agent are pointer-only; its `focus-visible:opacity-100` can never fire (`useSectionChrome.tsx:214-222`, `use-roving-focus.ts:107-113,216-219`). Same for the group-create and rename inputs (they work via programmatic focus, can't be Tabbed back into).
6. **Muted rows fall below 4.5:1** (DOR-1098) — dimming is the wrong mechanism; muted should drop signals, not legibility.
7. **Agent face flips mid-boot** (DOR-1143) — rows hash `projectPath` until the manifest loads.
8. **Group DM title doesn't follow its roster** (DOR-772).
9. No "promote this DM to a session" verb, no "open session" on a DM row, no "message" on an agent row — the two surfaces don't reference each other except via the live lane's escape hatch.
10. Nothing re-opens Getting started; fine, but a "Show tips again" in Settings would cost little.

### 4.3 What an S-tier product designer would do

- **Collapse the hierarchy to two levels and one header grammar** (1B). The product is a control panel; depth should come from typography, not nesting.
- **One noun per thing, one door per noun**: agent → session; room → channel/conversation; section → container. Kill the duplicate list (2A), kill "Agent group" (3A), kill the header icons (rows carry the glyph).
- **Make the stable part short and the computed part honest**: recent+pinned agents with a directory link; Heads up never lies (already true); Today never jumps (already true).
- **Every pressable does something** (DOR-1105), every control is real (group filter/mute), every word is true ("Chat with" → session).
- **One bottom slot** with a written priority order; nothing permanent, nothing undismissable.
- **Name the three words in the product** once (Heads up / Today / sections) and stop there; "Library", "digest", "now", "discovery" are implementation vocabulary and should stay in the code.

### 4.4 What an S-tier motion designer would do

Already good: All-clear beat, damped Getting-started return, Today order hold, directional body swap, reduced-motion respected throughout. Missing: **continuity** — things appear/disappear, they never _move_. Four additions, all 120–200 ms, one easing, nothing loops, all off under reduced motion (demos on the companion page):

1. **Fold with a count** — collapse = height spring + chevron turn; folded header shows a quiet "3 · 1 unread" (the roll-up rule already computes it).
2. **Arrive, settle, no pulse** — a new row slides in from its header and flashes the row tint once (200 ms); unread = weight + dot, never a looping glow.
3. **Bottom slot rises once** — slides up from under the footer only when a card newly qualifies; × collapses height.
4. **Lift, ring, settle** — drag lifts 2% with a shadow; the drop target shows a 2px inset ring (not a background wash); settle with a short spring. Use motion `layout` for rows that move between/within zones (the 4am archive, a "Move to section", a Today reorder after the hold releases) so the eye can follow.
   Rule: motion explains a state change the user didn't cause; it never decorates, never repeats, and a hovering hand pauses it (the Today-hold pattern, applied everywhere).

### 4.5 Where to delight

- **Drop an agent on a channel row = add it to the channel** (DnD exists; add room rows as drop targets).
- **Agent row whispers what it's doing** — the hottest session's verb, muted, truncated ("tests · 2m"), the way session rows already get `SessionVerbLine`.
- **Alt-click a header folds them all** — exists; say so in the header tooltip.
- **"While you were away…"** — keep; it's the best row in the panel.
- **⌘K `@name` / `#name`** — exists; teach it once in the search pill placeholder rotation.
- A folded section that shows its count; a Heads up row that takes you straight to the thing and then leaves.

### 4.6 Where to simplify (the list)

1B · 2A · 3A · 4A · 5 (recent+All N) · drop header icons · fix/remove inert controls · one verb for "open an agent" · `+ New` down to five honest items (Session, Channel…, Group message…, Agent…, Section…) · consider folding "group message" into "channel" later (both are rooms; the remaining difference is a slug and a topic).

---

## 5. Bugs, smells, dead code (with citations)

| #   | What                                                                                                                                                                     | Where                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Multi-face DM stack spills left / overlaps title                                                                                                                         | `sidebar-row.tsx:533-539`, `RoomAvatar.tsx:51,144-168`                                                                              |
| 2   | Single-face DM disc (20px) in an 18px slot — 1px left of `#`                                                                                                             | `identity-avatar.tsx:112`                                                                                                           |
| 3   | `face-stack` / `person-avatar` glyph kinds are emitted and **never rendered** (`RoomRow` ignores `row.glyph`; generic row has no branch)                                 | `build-sidebar-model.ts:272-273`, `library-rows.ts:100-102`, `select-today-items.ts:164-165`, `SidebarModelRow.tsx:172-176,268-277` |
| 4   | Five `SidebarRowModel` fields consumed by nothing: `origin`, `projectLabel`, `actions`, `status`, `liveCount`                                                            | `build-sidebar-model.ts:281-317`                                                                                                    |
| 5   | `LIVE_CHIP_MIN` (model) vs `LIVE_CHIP_THRESHOLD` (UI) — same constant, two names, one unused                                                                             | `library-rows.ts:25`, `AgentListItem.tsx:22`                                                                                        |
| 6   | Group `displayFilter` persisted + offered, never applied                                                                                                                 | `build-library-sections.ts:278-337` vs `SectionHeaderMenuItems.tsx:300`                                                             |
| 7   | Smart-group mute is a no-op while the menu offers it                                                                                                                     | `apply-mute-rules.ts:42`, `SectionHeaderMenuItems.tsx:271-349`                                                                      |
| 8   | Mixed group "Recent" sort sinks rooms                                                                                                                                    | `build-library-sections.ts:198-203,325-327`                                                                                         |
| 9   | "New group…" from a room row mounts under Agents                                                                                                                         | `useSectionChrome.tsx:291`                                                                                                          |
| 10  | Promo card has no dismiss; `remote-access` always shows; dismissal in localStorage                                                                                       | `PromoCard.tsx:49-77`, `promo-registry.ts:40-52`, `app-store-preferences.ts:170-189`                                                |
| 11  | Promo slot inside the scroller                                                                                                                                           | `DashboardSidebar.tsx:54-61`                                                                                                        |
| 12  | "Chat with X" (Team) and "Message" (profile) open a session                                                                                                              | `agent-columns.tsx:231-256`, `ProfileView.tsx:113-117`, `profile-message.ts:10-15`                                                  |
| 13  | `ConversationSurface` `'dm'` is write-only                                                                                                                               | `conversation-context.ts:19`, `RoomSurface.tsx:377`                                                                                 |
| 14  | `SidebarChrome` memo deps list `setRightPanelOpen`/`setActiveRightPanelTab`, unused in the body                                                                          | `SidebarChrome.tsx:408-409`                                                                                                         |
| 15  | `SidebarChrome` rebuilds a second `buildSidebarItems` index with `attention: {}` / `agentActivity: {}` hardcoded (silently wrong if ever read)                           | `SidebarChrome.tsx:187-200`                                                                                                         |
| 16  | Stale comment: "on mobile the sidebar is a scrollable Sheet" — the Sheet is never mounted below 768px                                                                    | `SidebarDnd.tsx:78-80` vs `AppShell.tsx:490-498`                                                                                    |
| 17  | Stale doc citing `filterSidebarItems`                                                                                                                                    | `sidebar-item.ts:79,87`                                                                                                             |
| 18  | Section `+` keyboard-unreachable (roving focus stamps it `-1`)                                                                                                           | `useSectionChrome.tsx:214-222`, `use-roving-focus.ts:107-113,216-219`                                                               |
| 19  | One dead roll-up row (`section-count`)[^1105]                                                                                                                            | `SidebarChrome.tsx:239-244` (DOR-1105)                                                                                              |
| 20  | `SidebarGroup` gets `px-0` over base `p-2` → hidden `py-2` per section stacking with `gap-1` and `py-1`                                                                  | `SidebarSection.tsx:143`, `sidebar.tsx:384`                                                                                         |
| 21  | Prefs writes inside read hooks (`useDigestFacts`, `useGettingStartedRetirement`) — `useRef`-guarded, but one missing guard from a write→rebuild→write loop               | `use-digest-facts.ts:211-215`, `use-getting-started-retirement.ts:55-62`                                                            |
| 22  | Vocabulary leak: zone id `now` / label "Heads up" / `digest` vs `discovery` same glyph / section label `'Direct messages'` used as a container key while the id is `dms` | `build-sidebar-model.ts:60-70`, `SidebarModelRow.tsx:79-81`, `SidebarSection.tsx:25`                                                |
| 23  | Spec says "a DM has no cwd" — code passes `cwd: agentPath`                                                                                                               | `specs/rooms/02-specification.md:383`, `room-turn-runner.ts:268`                                                                    |

---

## 6. Performance

Budget: `buildSidebarModel` median ≤ 5 ms on ≥30 agents / ≥60 rooms / ≥40 sessions (`build-sidebar-model.performance.test.ts`). Rebuild triggers: 60 s clock tick, any room/session/thread query settle, any prefs write, any navigation, attention changes, the automated fold. Guards: `useShallowStable`, `useStableList`, `useShallow` on lifecycle-only selectors. That's sound. What isn't:

1. **`RoomRow` mounts ~11 hooks per room row** — six mutation hooks that only feed menu items, plus `useSidebarPrefs()` — and is **not memoised**, so _any_ prefs write re-renders every room row. Lift prefs + mutations into the chrome context (or a per-row lazy menu), memo the row.
2. **`useSectionChrome` walks the whole fleet and all rooms once per section** (unread ids, smart-group candidates) — N+4 fleet walks per render; `SmartGroupRuleDialog` mounts per smart group. Compute once in `SidebarZones`, pass down.
3. **`SidebarChrome` builds a second `buildSidebarItems` index** over fleet + rooms just for `roomVisualOf` (#15). Reuse the model's index.
4. **`useRovingFocus.sync` runs on every commit with no deps** (two `querySelectorAll` per section subtree, re-stamping `tabIndex`). Give it deps or a mutation observer.
5. `useReservationGuard` runs every commit (dev-only; fine).
6. The 20-dependency snapshot memo is honest but brittle; consider splitting "slow" (prefs, agents, rooms) from "fast" (clock, attention) inputs so a clock tick doesn't re-derive everything.

---

## 7. DX

- The feature is big (13k LOC incl. tests, ~60 model files) but **legible**: one pure function, rules in `model/rules/`, fixtures (`first-run`, `quiet`, `busy`, `power`), contract tests, guarded invariants (one create surface, one menu implementation, no inline session panel, file-size guard on `DashboardSidebar.tsx`). Keep that.
- Four row renderers (`SidebarModelRow` generic, `RoomRow`, `AgentListItem`, plus `SessionRowSidebar` outside the tree) and the ⌘K row share "three constants, not a layout" (DOR-1094). A single `SidebarRow` grammar with slots would remove the dead glyph kinds (#3) and the agent row's different arithmetic.
- There is no indent token; there will be one after 1B (`--sidebar-row-x`, `--sidebar-header-x`, `--sidebar-nested-x`) and the gutter e2e test should assert those, not `16px`.
- Vocabulary cleanup (#22) is cheap and stops the next reader from learning three names for one thing.
- Agents can write `ui.sidebar.sections` but not read them (DOR-1097) — the `z.partialRecord` disclosure gap.
- Playground: add "promo slot inside a 272px overflowing panel", "Library states", and the group-defects states; the existing `Sidebar Model Journeys` page is the right home.

---

## 8. Open Linear issues touching the sidebar (2026-08-19)

| Issue               | State                       | What                                                                                              |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| DOR-1220            | Triage P0                   | Sidebar truncation-budget test flakes on font metrics (0.5px tolerance)                           |
| DOR-1105            | Backlog P2                  | Four sidebar roll-up rows look pressable and do nothing                                           |
| DOR-1098            | Backlog P2                  | Muted rows fall below 4.5:1 — dimming is the wrong mechanism                                      |
| DOR-906             | Backlog P0                  | Channels header Sort menu needs a real preference + conf migration                                |
| DOR-1143            | Backlog P4                  | Sidebar/DM rows hash `projectPath` until manifest loads → face flips                              |
| DOR-1140            | Backlog P4                  | Hashed emoji hue-locked to disc color                                                             |
| DOR-1097            | Backlog P3                  | Agents can write sidebar section prefs but not read them                                          |
| DOR-1094 / DOR-1095 | Backlog P3/P4               | Sidebar row vs palette row share constants not a layout; `row-grammar` not in barrel              |
| DOR-772             | Backlog P4                  | A DM's title does not follow its roster                                                           |
| DOR-588             | Todo P3                     | Remove one-release sidebar back-compat (`tolerateLegacySidebarEncoding`, `normalizeSidebarPrefs`) |
| DOR-341             | Backlog P4                  | Polish pack: group emoji, density toggle, dot-vs-count                                            |
| DOR-329             | In Progress (done-labelled) | Agent sidebar organization epic — close it                                                        |
| DOR-654             | Backlog P4                  | Channel-creation merge follow-ups (stale e2e manifest path)                                       |
| DOR-1160            | Todo P2                     | Attention routing idea                                                                            |
| DOR-1056            | In Progress P0              | Workspaces direction (make real or hide the ghost page) — relevant to "agents double as projects" |
| DOR-603             | —                           | Room slash commands — designed, unbuilt (the biggest session-only capability)                     |

---

## 9. Suggested program

**Wave 0 — honesty fixes (small PRs, no design dependency):** #1/#2 DM stack · #6/#7/#8/#9 group controls · #10/#11 promo × + move out of scroller (even before the arbiter) · #12 verbs · #3/#4/#5/#13/#14/#16/#17 dead code/docs · DOR-1105 destinations · #18 keyboard `+`.

**Wave 1 — 1B structure:** one header component for all five sections, indent tokens, drop the Library `<h2>` (keep id + `aria-label`), decide fold-all-headers, update gutter e2e, mobile tab name, spec amendment (`sidebar-now-today-library` §2/§8/§9, BC-1..3/28..33), capture fresh product media.

**Wave 2 — bottom slot (4A):** arbiter component, priority order, config-persisted dismissals, `remote-access` trigger, playground state, test assertion.

**Wave 3 — one door (2A):** New-menu + picker rule, remove hand-made 1:1 DM creation, archive empty 1:1s, Today/agent-row dot for agent-initiated DMs, rename verbs, amend `rooms` §8.5/§14.4 + `sidebar-now-today-library` BC-34/45, docs `concepts/rooms.mdx`.

**Wave 4 — sections + short agent list (3A + 5):** rename, top-level render, always-offered, "All N agents →", recent threshold, spec amendment (`sidebar-groups`, `sidebar-now-today-library` BC-28), e2e `sidebar-groups.spec.ts` (+ room drag coverage).

**Wave 5 — motion:** the four additions, `layout` on moving rows, reduced-motion audit.

**Performance** items ride along with whichever wave touches the file (RoomRow memo in Wave 3; section chrome walks in Wave 4; second index in Wave 1).

---

## Appendix A — measurements (live cockpit, 2026-08-19, 1440×900)

| Element                                   | Label x | Notes                                                                                 |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| Zone `<h2>` (Heads up / Today / Library)  | 16px    | `px-2 pt-1 pb-0.5 text-[11px]` in an 8px-padded scroller                              |
| Section header (Channels / DMs / Agents)  | 36px    | icon at 16, `size-3.5`, gap 6, `text-xs`, h-8                                         |
| Group sub-header                          | 50px    | `+ pl-[14px]`                                                                         |
| Channel row                               | 42px    | `#` 14px in 18px slot at 18                                                           |
| DM row, 1 face                            | 42px    | 20px disc at 15                                                                       |
| DM row, 2 faces                           | 42px    | stack 34px, first face at **8**                                                       |
| DM row, 3 faces                           | 42px    | stack 48px, first face at **1**, right edge ≈49 (over the title)                      |
| Agent row                                 | 42px    | no glyph slot; 20px disc at 16, `gap-1.5`; name is `text-xs` (12px) vs 13px elsewhere |
| Generic rows (session / digest / roll-up) | 42px    | icon 14px or avatar 20px in 18px slot                                                 |

Scroller: `SidebarContent` (`flex min-h-0 flex-1 flex-col gap-2 overflow-auto`, `px-2 py-3`), 2165px tall content in a 735px viewport on this profile.

## Appendix B — what breaks if the Library _zone_ (not just its label) were removed — for the record, we are not doing this

Model: `SIDEBAR_ZONE_IDS`, `librarySectionId()`, `bodyZone`'s `Exclude<…,'library'>`, the `zones.push({id:'library'})` block; `build-library-sections.ts` reason strings. Fold-all: `SidebarZones.tsx:111-137` enumerates the Library zone. DnD: unaffected (no `library` container). Persisted collapse state: unaffected (section ids, not zone id). Tests: `library-rules.test.ts`, `build-sidebar-model.contracts.test.ts:401,445`, `today-rules.test.ts:412,422`, `DashboardSidebar.test.tsx:510,1150,1201,1688`, `SidebarZones.damping-seam.test.tsx`, `app-shell-slots.test.tsx`, `one-live-definition.test.ts:106`, `MobileTabsLayout.test.tsx` (11 sites). E2E: `DashboardSidebarPage.ts:173-203`, `mobile-sidebar-navigation.spec.ts`, `mobile-touch.spec.ts`, capture pipeline `surfaces-mobile.ts`, `seed.ts:169`. Mobile IA: `mobile-tabs.ts:16,48,59-75`, `MobileTabsLayout.tsx:252-262`. Playground: `SidebarModelShowcases.tsx:74,485-521`.

## Appendix C — initial load (traced 2026-08-19, code only)

Decision record: `specs/sidebar-simplification/design-decisions.md` §6. Defects, most visible first, with the file the fix lives in:

1. "Pending" and "empty" are the same value everywhere in the model → the panel pops in from an empty `<div>`; nothing reads `isLoading`/`isPending` (`use-sidebar-state.ts:159,183,185,191`, `build-sidebar-model.ts:418-421`, `build-library-sections.ts:234`). `SidebarMenuSkeleton` (`shared/ui/sidebar.tsx:599-611`) exists and is unused.
2. First thing drawn in the scroller is the always-on promo card, alone (`DashboardSidebar.tsx:61`, `promo-registry.ts:44`).
3. Agents renders ~30 rows (`lastActivityAt === null ⇒ 'fresh'`, `agent-attention.ts:98-99`) then collapses to a handful + "N inactive" when recents land.
4. Every agent name and face flips once (DOR-1143): `resolve-agent-visual.ts:25-30` hashes the manifest ULID; the fallback hashes the path (`sidebar-item.ts:136`, `use-agent-visual.ts:29-32`, `identity-mark.ts:89`). The comment at `sidebar-item.ts:116-118` claims the opposite.
5. The sidebar's config is a second, sequential fetch: `['config']` (shell gate, `use-onboarding.ts:7`) vs `['config','current']` (`use-config.ts:19`) → pins/groups/collapse/mute restructure a round trip late; `useSidebarPrefs()` returns defaults at first render.
6. Heads up's "N working" arrives first, from the WS snapshot (`routes/events.ts:92-94`), pushing everything down.
7. Two `recent-sessions` requests (limit 10 in `use-sidebar-state.ts:158`, limit 24 in `use-jump-back-in.ts:28,31,84`) → Today rows grow a second line in a separate beat.
8. Whole-app 200 ms fade after a blank hold (`AppShell.tsx:433-461`; the `AnimatePresence` at `:440` lacks `initial={false}`).
9. `ProgressCard` (t0) and `ProfilePromptCard` (after `useProfile()`) animate up in the footer at different times, each shrinking the scroller.
10. The digest's once-a-day latch reads `undefined` prefs at mount (`use-digest-facts.ts:169,209`) — same root as #5.
11. `use-scroll-to-active.ts:51-58` latches at `TodayZone` mount; on `/channels` a late room anchor reads as a switch and smooth-scrolls unprompted.
12. Header says "Your team" then the operator's name (`SidebarHeaderBlock.tsx:59-63,78-79`).
13. Ask DorkBot renders disabled until mesh lands (`SidebarFooterStrip.tsx:277-290,304`).
14. Obsidian embed: the promo entrance animation plays on load (`EmbedSidebar.tsx:117`); header shows the literal `'Agent'` first (`:93`).
15. `PromoCard` carries `layout` ungated (`PromoCard.tsx:55`).
16. BC-49 welcome-back glow is built (`sidebar-row.tsx:164,481,519`, `index.css:1054-1065`) and wired to nothing.
17. No TanStack Query persistence, no `placeholderData`/`initialData` on any sidebar query, only one `persist`ed Zustand store (`interaction-store.ts`); the WS connect snapshot carries lifecycles only.

Verified correct on load: `rosterResolved` + `NOTHING_TO_SUGGEST` prevent a Getting-started flash; `useAllClearBeat` and `useGettingStartedReturn` do not fire on first paint; the sidebar body swap and header cross-fade are `initial={false}`.

[^1105]:
    **Corrected 2026-08-22 (DOR-1376 close-out).** As first written, this report said four roll-up
    rows were dead. Only one was: `section-count` (the "N inactive" row). `now-overflow`, `working`
    and `automated` already had working targets on `main` before this programme began
    (`SidebarChrome.tsx:339-352`, landed in PRs #922 and #942). The programme removed the one inert
    row in task 2.2 by replacing it with `All N agents →`; it did not have to give the other three
    a destination. The original sentences are left in place with this note rather than rewritten.
