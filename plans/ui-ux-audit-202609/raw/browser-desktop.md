# Browser Audit — Main Surfaces, Desktop (1440×900)

Auditor: live-browser pass against `http://localhost:6241` (operator's real dev data), Playwright MCP. Judged against `plans/ui-ux-audit-202609/00-charter.md`'s twelve lenses and the operator's fresh "no-wall-of-text" and "simplify, simplify, simplify" prime directives. No mutating actions were taken — navigation, hover, and dialog-open/Escape only.

Screenshots referenced below live in `/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/7e747ff4-181e-4e1e-b81d-0c31854b5004/scratchpad/audit-shots/` (files prefixed `01-` through `14-`).

---

## Findings, ranked

### 1. P1 · Composition & Consistency (lens 1) · Effort S — Marketplace package cards: author/source line truncates to unreadable single characters, on every one of 303 cards

**Files:** `apps/client/src/layers/features/marketplace/ui/PackageCard.tsx:153-179`

**Evidence:** `/marketplace`, desktop 1440×900, screenshot `09-marketplace.png`. The "Featured" rail and every card in "All Packages" show a metadata line combining author and marketplace source, e.g. `D... · dork...` on the featured cards and `C... · d` / `d... · d` on the 4-column grid cards below. This is not a rare edge case — it is the default rendering for the whole 303-package catalog at this viewport.

**Why it falls short:** Two independently-`truncate`d flex children (`authorLabel` at line 158, `pkg.marketplace` at line 169) share one row with no minimum-width guarantee on either. Both use `min-w-0 truncate` with no `flex-shrink-0` or reserved basis, so on a narrow card CSS's flex-shrink algorithm — which distributes negative space in proportion to each item's own natural (untruncated) width — crushes both to the point of uselessness. The line exists specifically so a reader can "tell a DorkOS package from a borrowed one" (the component's own doc comment); today it can't be read at all.

**Recommendation:** Reserve a sane minimum for each side (e.g. `min-w-[3.5rem]` or a fixed max-width split like 60/40), or drop to one visible fact on narrow cards (author OR source, not both) with the other in a tooltip/detail sheet. Test at the actual card width this grid produces at 1440px with the right rail open, not just at full-bleed.

---

### 2. P1 · UI States / Accessibility (lens 9) · Effort S — Schedule template cards: the button's accessible name is the entire card, including the full unclamped prompt text

**Files:** `apps/client/src/layers/features/tasks/ui/TaskTemplateCard.tsx:60-97` (see line 95 specifically)

**Evidence:** `/tasks`, screenshot `05-tasks-schedules.png`. Playwright's accessibility snapshot shows each of the four preset buttons' accessible name is the full concatenation of name + description + cron + the **entire** prompt, e.g. for `activity-summary`: _"activity-summary Summarize recent agent activity across all sessions Every weekday at 6:00 PM Summarize today's agent activity: 1. List sessions that were active today 2. Note any errors or failures 3. Highlight completed tasks and their outcomes 4. Flag anything that needs human attention Keep the summary concise — aim for a quick daily digest."_

**Why it falls short:** Line 95 renders the prompt with `line-clamp-2` for sighted users, but `line-clamp` is visual-only — the full text stays in the DOM and becomes part of the enclosing `<button>`'s (line 60) accessible name because no `aria-label` overrides it. A screen-reader user tabbing through this list hears the whole paragraph per card, four times. This is exactly the "accessibility failure" the charter marks P1 regardless of effort.

**Recommendation:** Give the button a concise `aria-label` (`"${preset.name}: ${preset.description}"`) and mark the cron line and prompt preview `aria-hidden`, or wrap the prompt in `aria-describedby` pointing only at the description — never let visually-truncated content still speak in full.

---

### 3. P1 · Composition & Consistency (lens 1) · Effort M — Repeated React `flushSync` console errors on every cold load

**Files:** `apps/client/src/layers/features/dashboard-sidebar/ui/rooms/RoomRow.tsx:200-204`, `apps/client/src/layers/shared/ui/sidebar-menu-node.tsx:758-763`

**Evidence:** Console on `/` (home) at first load: 7× `[ERROR] flushSync was called from inside a lifecycle method. React cannot flush when React is already rendering. Consider moving this call to a scheduler task or micro task.` Reproduced again on `/session` (2×) alongside two unrelated 404s. Verified via `browser_console_messages`.

**Why it falls short:** `RoomRow.tsx`'s `wake()` (line 203) calls `flushSync(() => setAwake(true))`, wired to `SidebarRow`'s `onMenuIntent`, which `sidebar-menu-node.tsx:763` binds to `onFocusCapture`. A capture-phase focus handler can fire synchronously during React's own commit/layout work (e.g. focus restoration on mount), which is exactly the situation React's own warning describes. Regardless of the documented intent (a deliberate synchronous "wake" latch, per the comment at `RoomRow.tsx:189-196`), it is firing in a disallowed context on ordinary page load — this is a real defect, not developer noise, and it is visible to every user who opens devtools.

**Recommendation:** Trace which row(s) are receiving programmatic focus at mount (virtualization remount? a currently-active row auto-focusing?) and move the `wake()` call out of the synchronous capture-phase path — e.g. defer with `queueMicrotask`/`requestAnimationFrame` when triggered by focus rather than by a real pointer event, keeping `flushSync` only for the pointerdown/contextmenu paths it was designed for.

---

### 4. P2 · Responsiveness / Overflow (lens 8) · Effort S — Command palette "Recent" row: the item's own NAME truncates harder than its secondary path

**Files:** `apps/client/src/layers/entities/agent/ui/AgentOptionRow.tsx:49-70`

**Evidence:** ⌘K on any page, screenshot `11-command-palette.png`. The "Recent" entry for the agent renders as `Dork...  ~/Keep/dork-os/dorkos/apps/desktop/.temp/.dork/agents/dor...` — the PRIMARY label ("DorkBot", 7 characters) is cut to 4 visible characters while the SECONDARY path metadata is given the lion's share of the row and shows ~55 characters before its own truncation.

**Why it falls short:** `name` (line 60) is `flex-auto` (grow:1, basis:auto) and `secondary` (line 66) is `shrink` only (basis:auto by default). The code comment at lines 51-59 explains this was chosen so `name` gets "its proportional share of the squeeze instead of vanishing first" versus a 0-basis sibling — true, but the CSS flex-shrink algorithm distributes negative space in proportion to each item's own _natural_ width, so the small, short, more-important name shrinks by a small absolute amount off a small base while the long, less-important path shrinks by a large absolute amount off a huge base and still has far more room left over. The result inverts the intended hierarchy: what the user is scanning for (the name) is the thing that disappears.

**Recommendation:** Give `name` a floor it can't cross before `secondary` gives up more (e.g. `shrink-0` on `name` combined with a `max-w-[...]` cap on `secondary`, or a fixed minimum character count via `min-w-[8ch]` on the name span). The path is provenance, not the primary scan target — it should be what yields first.

---

### 5. P2 · DRY (lens 3) / No-wall-of-text (charter directive) · Effort S — Workspaces page explains "what a worktree is" twice, back-to-back, in full prose

**Files:** `apps/client/src/layers/widgets/workspaces/ui/WorkspacesPage.tsx:161-164` and `:199-204`

**Evidence:** `/workspaces` with an empty worktree list, screenshot `07-workspaces.png`. Page-level intro: _"Every separate copy of your code found in your workspaces folder. Agents work in these so they never edit the same files at once. This page only reads them."_ Immediately below it, the empty-state card: _"A worktree is a second copy of your project, on its own branch, so one agent's edits can't collide with another's. They show up here once they exist in ~/Keep/dork-os/dorkos/apps/desktop/.temp/.dork/workspaces."_

**Why it falls short:** Both blocks say the same thing — a worktree/workspace is a separate copy so agents don't collide — in two different phrasings, stacked on one screen with no query in between. This is redundant explanatory prose exactly where the charter's no-wall-of-text rule (operator directive, 2026-09-03) asks for a short headline plus one path to detail, not two full paragraphs. The raw absolute path in the second block is also rendered as plain wrapped prose rather than as a `<code>`/path element, understating that it's a literal filesystem location.

**Recommendation:** Keep one explanation. Either drop the page-level intro (the empty state already carries the concept) or shrink it to a five-word gist ("Copies of your code, per agent.") and let the empty state carry the detail once. Style the path as code, not prose.

---

### 6. P2 · No-wall-of-text (charter directive) / Copy (lens 7) · Effort S — Message search's default panel is four sentences of prose shown before any query

**Files:** `apps/client/src/layers/features/command-palette/model/message-search-scope.ts:41-58` (rendered in the message-search dialog)

**Evidence:** ⌘⇧F on any page, screenshot `12-message-search.png`. Before typing anything, the dropdown shows a "What search covers" heading followed by four bulleted sentences, two of them two lines long: coverage of rooms, coverage of the three runtimes (with a "can take up to five minutes" caveat), what's never searched (tool output, with four named exclusions), and the whole-word matching rule with a worked example.

**Why it falls short:** This is legitimate, well-reasoned content — it exists to satisfy a documented product commitment (spec `message-search` §1.3 G4: a user must be able to learn search's limits without reading a spec) and is pinned by a copy-length test. But the operator's new prime directive is explicit: no surface shows a wall of text by default; the gist goes on screen, detail goes behind an affordance. Four multi-clause sentences, always visible, before the user has even started typing, is the pattern the rule targets.

**Recommendation:** Cut the default view to one line (`SEARCH_SCOPE_SUMMARY` at line 68-69 already exists and is exactly this — a one-line version used elsewhere) and move the four-bullet detail behind a small info affordance (a "?" icon, or reveal it once the user has typed and gotten zero results, which is the moment the whole-word caveat actually matters). This keeps G4's promise without keeping the prose on screen at all times.

---

### 7. P2 · No-wall-of-text (charter directive) · Effort M — Settings → Notifications is six stacked blocks of explanatory prose, one per control

**Files:** `apps/client/src/layers/features/settings/ui/tabs/NotificationsTab.tsx`

**Evidence:** Settings (via "Your team" menu → Workspace settings…) → Notifications tab, screenshot `14-settings-notifications.png`. A three-sentence intro paragraph sits above the controls: _"Agents work while you do something else, so DorkOS has to be able to reach you — and to stay quiet the rest of the time. A knock means something has stopped and is waiting on you. Everything else is news."_ Then every single toggle repeats the pattern — bold title plus a full sentence (some two sentences) underneath: "Chime every time a turn finishes" carries _"Plays whenever an agent finishes replying, in any session. Off to start with — with a few agents running it is a lot of sound."_ Six such blocks are visible without scrolling.

**Why it falls short:** Individually each sentence is well-written and useful; together, stacked six deep on one screen, this is the wall-of-text pattern the charter singles out. A settings panel should be scannable by its bold labels alone, with the "why" available on demand, not mandatory reading to find one toggle.

**Recommendation:** Keep the bold labels as the primary scan layer. Drop the per-toggle sentence to a `Tooltip`/info-icon rather than permanent secondary text, or cut each to under ten words and move the nuance (the "which mode fires when" reasoning) into a single collapsible "How this works" block at the top instead of repeating variations of it six times.

---

### 8. P2 · DRY / Clutter & Simplification (lens 3, 11) · Effort M — The Activity page's entire content is duplicated, on-screen, by the always-open Pulse panel beside it

**Files:** `apps/client/src/layers/widgets/activity/ActivityPage.tsx`, `apps/client/src/layers/widgets/pulse/ui/PulsePanel.tsx`, `apps/client/src/layers/widgets/pulse/ui/PulseActivitySection.tsx`

**Evidence:** `/activity`, screenshot `03-activity-duplicate-panel.png`. The main content area's "Today" table and the right-hand Pulse panel's "Activity" table show the **exact same three rows** (`DorkBot ran React to a message`, `DorkOS started`, `Claude Code adapter connected`) at the same timestamps, simultaneously, side by side on one screen.

**Why it falls short:** This is not wrong on Home or Team or Tasks, where Pulse is a persistent global companion panel and the main content is something else entirely. But on the page whose entire purpose IS the activity feed, having the identical feed rendered a second time three inches to the right — under a "Pulse" panel that also links "Open activity →" to the very page you're already on — is the clutter/simplification lens's core complaint: a page doing the same thing twice on one screen. The operator's "simplify, simplify, simplify" directive says the fix that removes something wins.

**Recommendation:** Auto-collapse or replace the Pulse panel's content on `/activity` specifically — either hide the panel's own Activity section there (since it's redundant with the page body) and show only "Needs attention," or don't open Pulse by default when navigating to `/activity`, since the page already answers exactly what Pulse's Activity section answers.

---

### 9. P2 · Clutter & Simplification (lens 11) / Overflow (lens 8) · Effort S — Team page (Cards view): "On this machine" truncates unnecessarily, and the page is mostly empty space

**Files:** `apps/client/src/layers/features/team-roster/ui/TeamMemberCard.tsx:351`, `apps/client/src/layers/features/team-roster/ui/TeamRosterGrid.tsx:18`

**Evidence:** `/team` (Cards view, default), screenshot `04-team-cards-sparse.png`. With only two team members (You, DorkBot), the grid renders `md:grid-cols-2` and the "You" card's secondary line reads `On this ma...` — "On this machine" (16 characters) truncated mid-word inside a card that visually has room for it. Below the two cards, roughly 700px of vertical space and most of the horizontal space is empty black background.

**Why it falls short:** Two things compound: (a) the secondary-line truncation (`text-muted-foreground mt-1.5 truncate text-xs` at line 351) is cutting a short, important fact well before the card's visible right edge, worth a direct investigation into the row's actual computed width at this grid size; (b) with a two-person roster, the page reads as broken/unfinished rather than intentionally minimal — there's no attempt to make a 2-card state feel complete (no suggested next action like "Add an agent," no cap on grid width, nothing anchoring the eye).

**Recommendation:** Confirm the actual rendered width of `TeamMemberCard`'s text column at `md` breakpoint and fix the truncation trigger (verify no fixed-width ancestor is starving it). Separately, for a near-empty roster, consider constraining the grid's max-width so 1-3 cards don't float in a mostly-black page, or add a lightweight "Add an agent" affordance in the empty space rather than leaving it bare.

---

### 10. P3 · Copy (lens 7) · Effort S — Settings → Appearance: font-family subtitle clips mid-word

**Files:** `apps/client/src/layers/features/settings/ui/tabs/AppearanceTab.tsx:63-71`

**Evidence:** Settings → Appearance, screenshot `13-settings.png`. The Font Family select shows "Inter" as the selected value and, below it, "Inter + JetBrains Mor" — the intended string (`font-config.ts:39`) is "Inter + JetBrains Mono"; the final two characters are simply clipped off with no ellipsis.

**Why it falls short:** `SelectTrigger className="w-40"` (160px) is too narrow to hold the stacked primary value plus muted description without wrapping or truncating, and the description span (`font.description` interpolation) has no `truncate`/`overflow-hidden` class, so the browser just clips it at the container edge mid-character.

**Recommendation:** Either widen the trigger slightly or add `truncate` (with `…`) to the description span so it degrades gracefully instead of hard-clipping a word.

---

### 11. P3 · UI States (lens 9) · Effort S — `/session` with no id silently resolves to a deleted session, producing two avoidable 404s before falling back cleanly

**Files:** route `/session` (session id resolution — not directly inspected; behavior observed via network/console)

**Evidence:** Navigating to `http://localhost:6241/session` with no query params redirected to `?session=464cad3a-0443-4d22-9404-a9f410264fb9`, which 404'd twice (`GET /api/sessions/.../messages`, `GET /api/sessions/...?cwd=...`) and logged two `[dorkos:query-error]` breadcrumbs ("Session not found", "Could not determine this session's working directory…") before the UI correctly fell back to a normal "Start a conversation" empty state. Screenshot `02-session-empty-stale-id.png`.

**Why it falls short:** The end-user experience recovers gracefully and nothing is visibly broken — this is squarely a P3 rather than higher. But it's avoidable console noise and two wasted round-trips on every cold visit to a bare `/session` route once the "last session" a client remembers has been deleted server-side.

**Recommendation:** Before issuing the `?session=` redirect, either validate the remembered session id is still resolvable, or catch the resulting 404 without escalating it to `console.error`/a breadcrumb, since a "the remembered session is gone, fall back to new" case is expected steady-state behavior, not an error.

---

### 12. P3 · Copy (lens 7) · Effort S — Team page filter button "Group: manager" is ambiguous at a glance

**Files:** `/team` toolbar (component not individually traced — cite via screenshot)

**Evidence:** `/team`, screenshot `04-team-cards-sparse.png`. The grouping control reads "Group: manager" with no other context on the page about what "manager" groups by (it groups agents under the person who owns them).

**Why it falls short:** "Manager" is programmer/org-chart jargon that doesn't match the product's own vocabulary elsewhere on this exact page (which says "owner," e.g. `TeamRosterGrid.tsx`'s own doc comments consistently say "owner," never "manager"). A newcomer reading "Group: manager" has no way to guess this means "cluster agents under the person they belong to."

**Recommendation:** Rename to match the rest of the surface's own vocabulary — "Group: owner" or simply "Group by owner" — so the control's word matches every other place this concept is named on the same page.

---

### 13. P3 · Clutter & Simplification (lens 11) · Effort S — Channels empty state describes an action it doesn't offer a button for

**Files:** `/channels` empty state (component not individually traced — cite via screenshot)

**Evidence:** `/channels` with no room selected, screenshot `06-channels.png`. Copy reads: _"Channels and direct messages live in the sidebar. Open one to read it, or make a new channel to get a few agents talking in the same place."_ There is no "New channel" button in the empty state itself — the only path is the small `+` affordance already sitting in the sidebar's Channels section header, off-screen from this text.

**Why it falls short:** The empty state names an action ("make a new channel") without placing a control for it nearby, forcing the reader to hunt the sidebar for the equivalent button they were just told about in prose.

**Recommendation:** Either add a small "New channel" button directly in the empty state, or reword to point at the sidebar explicitly ("Use + next to Channels to start one") rather than describing an action with no adjacent affordance.

---

## Not filed as findings (observed, but working as designed)

- **`DorkOS can't reach its server.` transient screen** — appeared twice mid-audit (once on a full-page `/connections` capture, once on ⌘K at `/feedback-requests`) with zero console errors, and both times cleared itself within seconds on a normal navigation/retry, exactly as its own copy promises ("this screen clears as soon as the server answers"). Consistent with known dev-server contention under concurrent multi-agent load noted in project memory — not a UI defect, the resilience screen is doing its job.

---

## Coverage

**Viewport:** 1440×900 desktop only (this auditor's assigned beat).

**Pages visited (all loaded successfully, console checked on each):**

- `/` (home / #team room) — screenshot `01-home-team-room.png`
- `/session` (bare, no id — resolved to a stale session) — screenshot `02-session-empty-stale-id.png`
- `/activity` — screenshot `03-activity-duplicate-panel.png`
- `/team` (Cards view, default) — screenshot `04-team-cards-sparse.png`
- `/tasks` (Schedules, empty state + 4 presets) — screenshot `05-tasks-schedules.png`
- `/channels` (empty state) — screenshot `06-channels.png`
- `/workspaces` (empty state) — screenshot `07-workspaces.png`
- `/connections` (Messaging tab, full scroll) — screenshots `08-connections.png`, `08b-connections-full.png`
- `/marketplace` (Browse, Featured + All Packages) — screenshot `09-marketplace.png`
- `/feedback-requests` (empty state) — screenshot `10-feedback-requests.png`
- Command palette (⌘K) — screenshot `11-command-palette.png`
- Message search (⌘⇧F) — screenshot `12-message-search.png`
- Settings → Appearance (via "Your team" menu → Workspace settings…) — screenshot `13-settings.png`
- Settings → Notifications — screenshot `14-settings-notifications.png`

**Skipped / not exercised at this viewport:**

- Team page's Table, Topology, Denied, and Access views (only Cards, the default, was audited).
- Settings tabs beyond Appearance and Notifications (Profile, Preferences, Tools, Runtimes, Rooms, Security, Privacy & Data, DorkOS account, Server, Experiments, Advanced, Extensions, Remote Access) were not opened.
- No interactive marketplace package detail sheet, no session with live message history, no room with more than the seeded #team conversation, no multi-agent state — this account's real data was small (2 team members, 1 channel, 1 agent), so states like a large roster, a busy multi-session queue, or an active turn-in-progress were not observable and are not covered here.
- Mobile/tablet breakpoints are explicitly out of this auditor's beat (covered by the responsive-focused pass per the charter's lens assignment).
- No copy audit of Connections page's full provider list beyond what's visible in the two screenshots taken (Telegram, Webhook, Slack were seen; any providers below the fold beyond the full-page capture were not individually re-inspected for copy quality).
