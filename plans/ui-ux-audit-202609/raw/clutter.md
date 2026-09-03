# Lens 11 — Clutter, simplification & progressive disclosure

Auditor pass over `apps/client/src`, product-designer lens: what would a world-class designer
cut, merge, reorder, or hide behind disclosure? Judged against Kai (density with calm) and
Ikechi (must not be scared off), bounded by Calm Tech.

---

## Coverage

**Read in depth (every file cited below was opened and read):**

- **Settings** — `SettingsDialog.tsx` (the whole tab table), `AdvancedTab`, `tabs/PreferencesTab`,
  `ToolsTab`, `ServerTab`, `SecurityTab`, `PrivacyTab`, `CloudAccountTab`, `ExperimentsTab`,
  `tabs/AppearanceTab`, `tabs/NotificationsTab`, `RemoteAccessAction`, and the
  `shared/ui/tabbed-dialog.tsx` + `navigation-layout.tsx` primitives behind them.
- **Session / chat** — `ChatPanel.tsx` (full render tree), `SessionComposer.tsx`,
  `features/composer/ui/ComposerInput.tsx`, `features/conversation/ui/ComposerHost.tsx`,
  `ChatStatusSection.tsx`, `features/status/model/status-bar-registry.ts`,
  `features/status/ui/SessionPopover.tsx`, `chat/ui/tasks/TaskListPanel.tsx`,
  `chat/model/use-task-state.ts`, `notifications/ui/PermissionPrimer.tsx`.
- **Home / team room** — `app/HomeRoomPage.tsx`, `widgets/home/ui/PinnedTriageHeaderView.tsx`.
- **Right panel** — `right-panel/ui/RightPanelHeader.tsx`, `model/use-right-panel-sizing.ts`,
  the contribution registry in `app/init-extensions.ts`, `widgets/pulse/*`.
- **One bar / nav** — `widgets/one-bar/ui/OneBar.tsx`, `SessionHeader.tsx`, `HomeSurfaceBar.tsx`,
  `dashboard-sidebar/ui/SidebarFooterStrip.tsx`, `NewMenu.tsx`,
  `dashboard-sidebar/ui/rooms/RoomRowMenuItems.tsx`, `widgets/mobile-tabs/ui/MobileTabBar.tsx`.
- **Marketplace** — `Marketplace.tsx`, `MarketplaceToolbar.tsx`, `MarketplaceSidebar.tsx`,
  `InstallConfirmationDialog.tsx`, `PermissionPreviewSection.tsx`.
- **Tasks** — `features/tasks/ui/TaskFormInner.tsx`. **Activity** — `ActivityPage.tsx`,
  `ActivityFilterBar.tsx`. **Team** — `TeamPage.tsx`. **Connections** — `ConnectionsPage.tsx`.
- **Onboarding** — `onboarding-script.ts`, `SystemRequirementsStep.tsx`.
  **Profile** — `ProfileRows.tsx`. **Rooms** — `RoomPanelBody.tsx` structure.
  **Agent settings** — `IdentityTab.tsx`.
- **shared/ui** — full directory inventory (89 entries) reviewed for disclosure primitives;
  `field-card.tsx`, `bottom-slot.tsx`, `collapsible.tsx`, `tabbed-dialog.tsx` read.
- **decisions/** — checked before flagging: ADR `260819-210153` (bottom-slot arbiter),
  `260822-083228` (one header row), `260822-083229` (room management in the right panel),
  `260819-234827..30` (notification kinds/tiers), plus the `sidebar-simplification`,
  `composer-status-redesign` and `trust-dial` decision records referenced inline in the source.

**Sampled only / not audited:** the dev playground (`src/dev/`, out of lens — lens 6 owns it),
extension/gen-ui/mcp-apps hosts, canvas, terminal, file-explorer internals, `agent-creation`,
`mesh` views, `relay` panel, `workspaces`, `feedback` / `report-issue`, `shapes`, `tours`, the
auth `SecurityPanel` internals, `diff-review`, and the Obsidian embed shell.

**Headline:** this codebase is unusually disciplined for this lens. The session status line
(`status-bar-registry.ts` — promotion rules + severity ranking + a measured width budget),
the sidebar's `BottomSlot` arbiter, the one-bar's fixed cluster, the `NewMenu` "one create
surface" rule and the profile's push-in stack are all _better_ than the industry norm and
should be treated as the internal standard. **There are no P1 findings.** Everything below is a
place where an existing internal standard has not yet been applied to a second surface.

---

## Findings

### [P2/S] The session to-do panel opens expanded, uncapped, directly above the composer

**Files:** `apps/client/src/layers/features/chat/ui/tasks/TaskListPanel.tsx:27,56,63,74`,
`apps/client/src/layers/features/chat/model/use-task-state.ts:78`,
`apps/client/src/layers/widgets/session/ui/ChatPanel.tsx:543-551`

**Current state.** `use-task-state.ts:78` initialises `const [isCollapsed, setIsCollapsed] =
useState(false)` — so the panel arrives **open**. `TaskListPanel.tsx:27` sets
`MAX_VISIBLE = 10`, and the `<motion.ul>` at line 74 has `className="mt-1 space-y-0.5"`: no
`max-h`, no internal scroll. Ten task rows plus the progress header plus the active-form line
render in flow between the transcript and the composer, on every device.

**Why it falls short.** The repo has already measured this exact failure once and fixed it
elsewhere. `PinnedTriageHeaderView.tsx:26-53` documents that at 375×812 "the room's masthead,
composer and presence line already spend ~180px, so a 50svh header leaves the conversation under
a third of the screen", and caps that header at `max-h-[40svh] sm:max-h-[50svh]`. The chat
panel's to-do list is the same shape of component in the same position with none of that
protection. An agent that emits a ten-item plan pushes the conversation Kai is reading off the
phone screen, and it does so by default rather than on request.

**Recommendation.** Two changes, both small: (a) give the list the same treatment the triage
header got — `max-h-[30svh] sm:max-h-[40svh]` plus `overflow-y-auto` on the `<ul>`, so a long
plan scrolls inside itself instead of growing the zone; (b) make `isCollapsed` default to `true`
once the turn that produced the list has ended, keeping it open only while the plan is actively
changing. The progress header already carries the counts, so a collapsed panel loses no signal —
the same argument `specs/sidebar-now-today-library` makes for a folded section keeping its
roll-up.

---

### [P2/M] The zone between the transcript and the composer has no arbiter

**Files:** `apps/client/src/layers/widgets/session/ui/ChatPanel.tsx:492-580`,
`apps/client/src/layers/shared/ui/bottom-slot.tsx:1-19`,
`apps/client/src/layers/features/notifications/ui/PermissionPrimer.tsx:94-102`,
`apps/client/src/layers/shared/ui/PromptSuggestionChips.tsx`

**Current state.** `ChatPanel.tsx` renders, in flow, between `SessionTranscript` and
`SessionComposer`: `TerminalReasonChip`, `Conversation.LiveLane`, `PromptSuggestionChips`, the
`chat.suggestion-chips` extension slot (N contributions), `TaskListPanel`, `TurnFailedNotice`, an
error block, and `PermissionPrimer` — eight independent blocks, each gating itself on its own
predicate, with no shared priority and no shared budget. `PromptSuggestionChips` (line 526) and
the extension chips (line 536) both fire on `status === 'idle'`; `TaskListPanel` (543) fires on
`tasks.length > 0`; `PermissionPrimer` (line 572) fires independently. They co-occur.

**Why it falls short.** ADR `260819-210153` decided exactly this question for the sidebar —
"four independent cards with no shared priority" — and shipped `shared/ui/bottom-slot.tsx`,
whose own header says "This is the one place they arbitrate: highest priority wins, and the next
card waits its turn." The primitive is already in `shared/ui`, already takes an ordered candidate
list, and already knows nothing about the features it renders. The chat panel is the second
instance of the problem the ADR solved, and it did not get the fix. The `LiveLane` beside it is
the counter-example done right: nine rungs, first match wins, one reserved 24px line
(`contributing/design-system.md` §Live lane).

**Recommendation.** Wrap the promotional and advisory blocks — `PromptSuggestionChips`, the
extension chip slot, `PermissionPrimer`, and any future card — in a `BottomSlot` with an explicit
priority order, so at most one speaks at a time. Leave the three that are not competing for
attention outside it: `LiveLane` (a reserved line by design), `TaskListPanel` (content about the
running turn, not an offer), and the error/turn-failed blocks (a failure must never be arbitrated
away). Document the priority beside the candidate list the way `useAppBanners` does.

---

### [P2/M] The right panel carries six competing tabs on `/session`, in a panel that floors at 320px

**Files:** `apps/client/src/app/init-extensions.ts:144-300`,
`apps/client/src/layers/features/right-panel/ui/RightPanelHeader.tsx:136-300`,
`apps/client/src/layers/features/right-panel/model/use-right-panel-sizing.ts:18`

**Current state.** `registerRightPanelTabs` registers six contributions visible on `/session`:
Pulse (global, priority 5), Profile (10), Session (12), Files (15), Canvas (20), Terminal (25);
a seventh, Room, is visible on `/` and `/channels`. The strip renders every one as
icon + label at `text-[10px]` (`RightPanelHeader.tsx:269`) inside a horizontally scrolling box
with edge fades, and the panel's floor is `MIN_WIDTH_PX = 320`. `RightPanelHeader.tsx:136-143`
states the problem in its own doc comment: "Six tabs are wider than a 375px overlay panel, and a
tab pushed past the edge with no way to reach it is a lost surface."

**Why it falls short.** A scroll-plus-fade is a mitigation, not a design. At the panel's own
minimum width roughly half the tabs are off-screen, so the answer to "where is the terminal"
depends on scroll position, and the mitigation itself needed a `ResizeObserver` over three boxes
plus an explicit reveal (lines 196-235) to stop being wrong. Two of the six also overlap by the
registry's own admission: the Session tab's comment (`init-extensions.ts:234-241`) says it and
the status line's `⋯` popover "answer the same question at two different commitments". Six
top-level destinations is more than a 320px column can teach — the same argument
`contributing/design-system.md` §Zones makes for the sidebar ("a 272px panel cannot teach three"
levels).

**Recommendation.** Get `/session` to four or fewer. The natural merge is a single **Workspace**
tab holding Files, Canvas and Terminal behind an inner segmented control — they are one concept
(this session's working directory), they are gated on the same route, and Terminal already
self-hides under the Obsidian transport, so the inner control is already variable-length. That
leaves Pulse · Profile · Session · Workspace. If a further cut is wanted, fold the Session
readout into Profile as a section rather than a peer, since the `⋯` popover already covers the
two-second peek.

---

### [P2/M] Settings → Advanced is a junk drawer, and its contents belong on three other tabs

**Files:** `apps/client/src/layers/features/settings/ui/AdvancedTab.tsx:57-217`,
`apps/client/src/layers/features/settings/ui/SettingsDialog.tsx:112`

**Current state.** One tab named "Advanced" holds four unrelated sections in a flat stack:
**Background Updates** (a polling switch, lines 59-73), **Message Box** (the rich-text switch,
lines 75-106), **Logging** (level, max file size in KB, rotated-files-kept, log location —
lines 108-173), and **Danger Zone** (Reset All Data, Restart Server — lines 175-205). Every row
is at the same visual level; nothing is collapsed.

**Why it falls short.** "Advanced" is not a category, it is the absence of one — and three of
these four sections have an obvious home. "Format text as you type" is a composer preference and
its own inline comment (lines 81-98) says it is now ON by default, i.e. it is not advanced at
all, it is the way out. "Background refresh" is a general app preference. Logging is a property
of this machine's server, which is what the Server tab is. What is left — Reset and Restart — is
a real danger zone and deserves to be the tab. Meanwhile `maxLogSizeKb` and `maxLogFiles` are
two numeric fields that matter to roughly nobody, rendered flat, above the destructive actions:
the classic "advanced options listed flat" the charter names.

**Recommendation.** Redistribute: Message Box → Preferences (beside the other chat-display
rows); Background refresh → Preferences; Logging → Server, inside a `CollapsibleFieldCard`
labelled "Logging" (log level visible in the summary, rotation fields inside). Rename the tab
**Danger zone** and let it hold only Reset and Restart. That is one fewer concept to scan and it
makes the tab's icon and name predict its contents.

---

### [P2/S] "Background refresh" is a machine-wide preference offered as a per-session control

**Files:** `apps/client/src/layers/features/status/model/status-bar-registry.ts:470-486`,
`apps/client/src/layers/features/status/ui/SessionPopover.tsx:252-260`,
`apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx:104-105,514-517`,
`apps/client/src/layers/features/settings/ui/AdvancedTab.tsx:30-31,66-71`

**Current state.** The `polling` registry entry sits in the **`controls`** group of the Session
popover and renders a `Switch` (`SessionPopover.tsx:253-259`). Its value comes from
`useAppStore((s) => s.enableMessagePolling)` (`ChatStatusSection.tsx:104`) — a global app-store
field, not session state — and the identical switch also exists in Settings → Advanced
(`AdvancedTab.tsx:66-71`).

**Why it falls short.** This is the defect the registry itself records having fixed for a sibling
row, seven lines above. `status-bar-registry.ts:470-475`: "`sound` used to live here as a switch.
It is gone (DOR-1385): it read as a per-session control and was not one — it flipped a preference
for every session on the machine." `polling` has exactly that property and was left in place. A
person toggling it inside the Session panel reasonably believes they changed this session; they
changed every window on the machine. It is also a second, undiscoverable path to a setting that
already has a home.

**Recommendation.** Remove the `polling` entry from the registry's `controls` group the way
`sound` was removed, leaving Settings as the one place it lives. If a shortcut from the session
is still wanted, make it a link into `?settings=…` rather than a switch — a deep link cannot
misrepresent its scope. The `controls` group then holds only `plan`, which genuinely is
per-session.

---

### [P2/M] Four different progressive-disclosure idioms, so "Advanced" looks different on every surface

**Files:** `apps/client/src/layers/shared/ui/field-card.tsx:57-91` (`CollapsibleFieldCard`),
`apps/client/src/layers/features/tasks/ui/TaskFormInner.tsx:363-369,413-418` (native `<details>`
with hand-rolled `<summary>` chrome), `apps/client/src/layers/features/marketplace/ui/PermissionPreviewSection.tsx:170-199`
(native `<details>`, a third summary style),
`apps/client/src/layers/features/settings/ui/runtimes/RuntimeCardView.tsx:379-386` and
`apps/client/src/layers/features/settings/ui/tools/ToolGroupRow.tsx:82-110` (Radix `Collapsible`,
two different trigger treatments), `apps/client/src/layers/features/chat/ui/tools/ToolCallCard.tsx:113`
(`CollapsibleCard`), `apps/client/src/layers/features/agent-settings/ui/IdentityTab.tsx:363`
(`CollapsibleFieldCard`).

**Current state.** The design system documents `CollapsibleFieldCard` as the disclosure primitive
for settings groups (`contributing/design-system.md` §FieldCard), and it has exactly three
production call sites. Everywhere else, disclosure is re-implemented: a native `<details>` with
`ChevronRight … group-open:rotate-90` in the task form, a _different_ native `<details>` with its
own summary typography in the install preview, a bare Radix `Collapsible` with an inline text
trigger in the runtime card, and another with an `asChild` row trigger in `ToolGroupRow`.

**Why it falls short.** Progressive disclosure only works if the affordance is learnable. A
person who learns that a chevron-and-uppercase-label opens a section in the install dialog gets
no help from that in the task form, the runtime card, or agent settings — four visual grammars
for one interaction. It also means the _behaviour_ differs invisibly: only
`CollapsibleFieldCard` supports a `badge` summarising what is inside, so the other three
disclose without saying what they are hiding, which is the half of disclosure that makes it safe.
(Overlaps lens 3/DRY; the finding here is about the affordance, not the code duplication.)

**Recommendation.** Settle on `CollapsibleFieldCard` for every **form or settings** disclosure —
including a trailing summary (`badge`) stating what is inside, e.g. "3 overrides", "7 files" —
and migrate the four hand-rolled ones. Keep native `<details>` only for disclosure _inside
content_ (a tool card's output, a stack trace in `route-error-fallback.tsx`), and say so in
`contributing/design-system.md` so the next author has a rule rather than five examples.

---

### [P2/S] Settings' first four tabs are an unnamed implicit group, and "Remote Access" is a dialog wearing a tab's clothes

**Files:** `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx:35-52,112,135,140`,
`apps/client/src/layers/features/settings/ui/RemoteAccessAction.tsx:28-38`,
`apps/client/src/layers/shared/ui/tabbed-dialog.tsx:126-131,191-212`

**Current state.** Thirteen tabs. Nine carry a `group` — "Agents & sessions", "Access & privacy",
"System" — and four (Profile, Appearance, Preferences, Notifications) carry none, so
`tabbed-dialog.tsx:126-131` renders them as a headerless run above the first section header.
Below the last group, `sidebarExtras` renders `RemoteAccessAction`, a button styled almost
exactly like a `NavigationLayoutItem` (icon + label + hover tint) that opens `TunnelDialog` — a
second modal on top of the settings modal.

**Why it falls short.** Three of the four sidebar regions are named; the first is not, so the
list reads as "four loose things, then three real sections" rather than four peers. And a control
that sits in a list of tabs, looks like a tab, and instead raises a dialog over the dialog breaks
the one promise a settings sidebar makes: clicking a row swaps the panel. On mobile
(`RemoteAccessAction.tsx:11-25`) it even renders with the drill-in `ChevronRight` that every
_tab_ row uses, so the disguise is strongest exactly where the recovery gesture is worst.

**Recommendation.** Name the first group ("You" or "Personal") so all four regions are labelled
peers. Move Remote Access into the **Access & privacy** group as a real tab whose panel is the
current `TunnelSettings` content — it is the same subject as Security and DorkOS account, and it
removes a dialog-over-dialog. `sidebarExtras` then has no production consumer and can go.

---

### [P2/S] Preferences is a leftover bucket

**Files:** `apps/client/src/layers/features/settings/ui/tabs/PreferencesTab.tsx:76-153`

**Current state.** One card holding six switches — Show timestamps, Expand tool calls, Auto-hide
tool calls, To-do celebrations, Feature suggestions, **Show dev tools** — then `WelcomeBackCard`,
then a second card with **Replay setup**. Four of the six are chat-display settings; one is a
promotion control; one turns on a developer panel; and the tail is a first-run flow you can
re-trigger.

**Why it falls short.** "Preferences" here means "settings that had nowhere else to go", which is
the same failure as Advanced one tab down. A developer-tools toggle sitting flat between
"To-do celebrations" and a re-run of onboarding is exactly what makes Ikechi feel he is in the
wrong room, and Kai has to read six unrelated labels to find the one about tool cards. The tab's
own comments (lines 107-117) already record two settings being moved _out_ for coherence, so the
direction of travel is established.

**Recommendation.** Group inside the tab rather than adding tabs: one **Chat** `FieldCard`
(timestamps, expand tool calls, auto-hide tool calls, celebrations, and the Message Box row
relocated from Advanced), one **Discovery** row (Feature suggestions, beside "Replay setup" —
both are about being shown things again). Move "Show dev tools" to the System group, where the
other developer-facing switches live.

---

### [P3/S] Pulse does not stand down on the surface that already shows its content

**Files:** `apps/client/src/layers/widgets/pulse/ui/PulseActivitySection.tsx:20-62`,
`apps/client/src/layers/widgets/pulse/ui/PulseAttentionSection.tsx`,
`apps/client/src/layers/widgets/pulse/ui/PulsePanel.tsx:29-35`,
`apps/client/src/layers/widgets/activity/ActivityPage.tsx:38-64`

**Current state.** `PulseActivitySection` already reads the pathname
(`useSafePathname()`, line 25) and uses it for exactly one thing: hiding the "Open activity →"
button when you are already on `/activity` (line 26). The five teaser rows themselves still
render. So on `/activity` with the right panel open, the same feed is drawn twice on one screen —
the full filterable page on the left, five rows of it in a 320px column on the right. The
attention section has the same relationship to Home's pinned triage header.

**Why it falls short.** A teaser exists to point at a place you are not. Pointing at the page you
are looking at spends a quarter of the panel to say nothing, and it does it while the panel's
purpose ("the shell is never a dead panel") is already satisfied by the other section. The code
knows enough to fix it — it already asks the question.

**Recommendation.** Extend the existing check: when `pathname === '/activity'`, `PulseActivitySection`
returns `null`; when the route shows the team room, `PulseAttentionSection` returns `null`. If
that would leave Pulse empty on those routes, that is the honest signal that the _contextual_ tab
should be the default there — which is already true on Home, where the Room tab wins auto-select
(`init-extensions.ts:186-196`, `routeShowsRoom`).

---

### [P3/S] Server settings mixes the one thing you came for with five diagnostics

**Files:** `apps/client/src/layers/features/settings/ui/ServerTab.tsx:41-83,141-174`

**Current state.** Eight flat rows: Version, (update notice), Address + MCP endpoint, Uptime,
Working Directory, Data Directory, Boundary, Node.js. Every one is a click-to-copy row at the
same weight.

**Why it falls short.** Two of these are why anyone opens this tab — the address to paste into an
MCP client, and the version. The other four are diagnostics you want once, when something is
wrong, and "Boundary" and "Node.js" are words Ikechi has no model for. Presenting them at the
same weight as the address costs the address its prominence, and the tab already has a
`CopyDiagnosticsButton` sibling in `features/status` proving the "copy the whole lot" pattern
exists in this codebase.

**Recommendation.** Keep Version, Address, MCP endpoint and Uptime at the top level. Put Working
Directory, Data Directory, Boundary and Node.js inside a `CollapsibleFieldCard` labelled
"Diagnostics", collapsed by default, with a single copy-all control in its header — so the
support path is one click and one paste rather than four separate copies.

---

### [P3/S] The install dialog decides seven times, independently, how much to open

**Files:** `apps/client/src/layers/features/marketplace/ui/PermissionPreviewSection.tsx:170-262`,
`apps/client/src/layers/features/marketplace/ui/InstallConfirmationDialog.tsx:202-275`

**Current state.** `PermissionPreviewSection` renders seven `<details>` sections. Each decides
its own initial state with `const open = defaultOpen ?? items.length <= 3` (line 173), and two
(Commands, Jobs) are forced open. So a package with three rows in each of five optional sections
opens all of them: the modal presents a scroll of ~20 rows across seven uppercase headings, above
a scope radio group and an agent picker.

**Why it falls short.** The per-section heuristic is locally sensible and globally unbounded —
there is no dialog-level budget, which is precisely the gap the composer status line closed with
`applyStatusBudget` (`ChatStatusSection.tsx:490-493`). For Ikechi this is the first security
decision the product asks him to make, and a wall of open sections reads as "this is
complicated", which is the opposite of the confidence an honest preview should produce. The
constraint is real, though: DorkOS is honest by design, so the fix must not _hide_ risk.

**Recommendation.** Keep **Commands** and **Conflicts** always expanded — those are the two the
component's own doc comment (lines 230-233) identifies as "what a person needs to see before
trusting a stranger's package". Collapse Effects, Secrets, Hosts and Dependencies by default,
each with its count in the summary so nothing is concealed, and add a one-line verdict above the
sections derived from the same data ("Adds 4 skills for all agents. Declares no commands.").
Nothing is removed; the reader is given an order to read it in.

---

### [P3/S] "Security" and "DorkOS account" are two tabs holding one question

**Files:** `apps/client/src/layers/features/settings/ui/SecurityTab.tsx:1-12`,
`apps/client/src/layers/features/settings/ui/CloudAccountTab.tsx`,
`apps/client/src/layers/features/settings/ui/SettingsDialog.tsx:78-98`

**Current state.** The "Access & privacy" group holds three tabs. Two of them are 12-line and
14-line wrappers: `SecurityTab` renders `SecurityPanel` (local login + API keys) and
`CloudAccountTab` renders the cloud link. Both answer "who can get into this install and as
whom".

**Why it falls short.** Two sidebar rows, two icons and two panel headers for a subject that is
one panel's worth of content, in a sidebar that already carries thirteen rows. Every element
justifies its existence (AGENTS.md §Quality Standard) — a tab whose whole body is one component
and whose subject is the neighbouring tab's subject does not.

**Recommendation.** Merge into one **Access** tab with two `FieldCard` sections ("On this
machine" — login and API keys; "DorkOS account" — the cloud link). Keep `?settings=security` and
`?settings=account` working through the legacy map in `use-dialog-deep-link.ts`, which already
exists for exactly this kind of move, and let it scroll to the section. Twelve rows instead of
thirteen, and one fewer place to look.

---

## Positive patterns worth naming (so other surfaces can copy them)

Not findings — recorded because the audit should say where the bar already is.

- **`features/status/model/status-bar-registry.ts`** — quiet by default, per-item `promote` and
  `severity` rules, a measured width budget, and overflow to a `⋯` rather than truncation. This
  is the reference implementation of this lens in the repo.
- **`shared/ui/bottom-slot.tsx` + ADR `260819-210153`** — a general arbiter primitive that knows
  nothing about its candidates. Reusable, and under-reused.
- **`widgets/home/ui/PinnedTriageHeaderView.tsx`** — "nothing waiting, nothing wrong draws
  nothing", plus a measured viewport cap and honest scroll-edge fades.
- **`features/dashboard-sidebar/ui/NewMenu.tsx`** — one create surface, guarded by a test
  (`one-create-surface.test.ts`), replacing "three menus and four `+` buttons".
- **`widgets/one-bar/ui/OneBar.tsx`** — one header row per route, with the fixed cluster
  structurally guaranteed to come last.
- **`features/marketplace/ui/MarketplaceSidebar.tsx`** — facets hidden when they cannot narrow
  anything, categories collapsed past a threshold while keeping active filters visible.
