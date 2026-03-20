---
title: 'Sidebar Tabbed Views — Sessions, Schedules, Connections UX Research'
date: 2026-03-10
type: external-best-practices
status: active
tags:
  [
    sidebar,
    tabs,
    navigation,
    ux,
    react,
    activity,
    keep-alive,
    state-persistence,
    pulse,
    relay,
    mesh,
    sessions,
  ]
feature_slug: sidebar-tabbed-views
searches_performed: 10
sources_count: 22
---

## Research Summary

The sidebar should become a three-tab control panel — Sessions, Schedules (Pulse), Connections (Relay + Mesh) — using icon-only tabs at the top of the sidebar, styled as a compact segmented-style row. View state must persist when switching (no unmounting), achievable via React 19.2's `<Activity>` component or CSS-based display toggling. Tabs should surface glanceable badge counts (active run count, unread adapter status) without requiring a click. The recommended pattern draws from VS Code's Activity Bar concept adapted to horizontal compact tabs — matching DorkOS's "control panel, not consumer app" brand voice.

---

## Key Findings

### 1. Persona Analysis: Kai and Priya's Actual Workflows

**Kai (primary — The Autonomous Builder):**

- Runs 10-20 agent sessions per week across 5 projects. Sessions are his active chat context.
- Has scheduled Pulse runs running overnight — he wants to see their status _without leaving the chat view_. He'd glance at "3 active runs" badge and feel confident, not need to click in to verify.
- Relay/Mesh connections are infrastructure-level — he set them up once, now just needs to see green/red health status at a glance. He should not need to navigate away to diagnose.
- Critical workflow: Tab-switching mid-session should never lose his scroll position in the Sessions list. He was just looking at a session from 3 days ago — if he checks Schedules and comes back, that session must still be visible.
- The "15-tab juggle" pain point is the Sessions view's entire reason for existing. Kai lives there. He should be able to switch to Schedules, check run status, and return to Sessions in under 3 keystrokes total.

**Priya (secondary — The Knowledge Architect):**

- Flow preservation is her core need. Tab-switching must have zero cognitive cost.
- She may want to query an agent mid-architecture review and _simultaneously_ check Relay health to confirm a connection she just configured. A tab switch that destroys her message draft or scroll position would break flow.
- She reads source code before adopting tools. She would notice if the tab implementation used conditional rendering that destroys state — if a scroll position resets, she loses trust.
- Badge counts are her friends: they let her assess system state without context-switching.

**Anti-persona (Jordan — The Prompt Dabbler):**

- Would expect labeled tabs like "Chat", "Scheduler", "Integrations" with full text labels, big icons, and tooltips explaining everything.
- Would want a "Setup wizard" in the Connections tab.
- We should NOT do: tutorial text in view headers, hover-to-reveal explanations for what each view does, any onboarding UI embedded in tab content beyond the existing ProgressCard.

### 2. Tab State Persistence — React Activity vs CSS Toggle

Three viable approaches, ranked best to worst for DorkOS:

**Option A: React `<Activity>` Component (React 19.2)**

```tsx
<Activity mode={activeTab === 'sessions' ? 'visible' : 'hidden'}>
  <SessionsView />
</Activity>
<Activity mode={activeTab === 'schedules' ? 'visible' : 'hidden'}>
  <SchedulesView />
</Activity>
<Activity mode={activeTab === 'connections' ? 'visible' : 'hidden'}>
  <ConnectionsView />
</Activity>
```

- State preserved: scroll position, form inputs, expanded/collapsed state — all survive tab switching.
- Effects are cleaned up when hidden (unlike display:none), so no zombie timers or subscriptions.
- Hidden content pre-renders at lower priority, potentially making first-click faster.
- **Requires React 19.2** — check current React version in project. DorkOS already uses React 19 (Vite 6 SPA), but 19.2 specifically introduced `<Activity>`. This is the most semantically correct approach.
- Caveat: any DOM element with side effects (e.g., auto-playing `<video>`) needs explicit cleanup in `useLayoutEffect`. Not applicable here.

**Option B: CSS Hidden Toggle (display: none / visibility pattern)**

```tsx
<div className={cn(activeTab !== 'sessions' && 'hidden')}>
  <SessionsView />
</div>
```

- Simpler, works with current React 19 (pre-19.2).
- Preserves DOM state (scroll position, input values) but does NOT clean up Effects.
- "Zombie component" risk: a hidden Schedules view might still poll for run updates.
- Mitigation: use `hidden` Tailwind class (maps to `display: none`), and ensure data-fetching hooks use conditional enabling based on whether the view is active.
- Fine for the current scale — three views with known, bounded TanStack Query hooks.

**Option C: Zustand State Lifting + Conditional Rendering**

- All state lifted to Zustand, views conditionally rendered.
- Destroys DOM on tab switch — scroll position is lost.
- Would require explicit serialization of scroll offset for Sessions list.
- More code complexity, worse UX. Not recommended.

**Recommendation: Option B (CSS Toggle) now, migrate to Option A when React 19.2 is confirmed in the project.** Option B is simpler, already works, and can be migrated to Activity with a minimal diff later.

### 3. Tab Navigation Patterns — 4 Approaches Compared

**Approach 1: Icon-Only Compact Horizontal Tabs (RECOMMENDED)**

```
[─────────────────────────────────]
[ ≡  Sessions  |  ⏱  |  ⚡ 2  ]  ← tab row at top of SidebarContent
[─────────────────────────────────]
```

- Three icon buttons in a tight horizontal strip, replacing or sitting below `SidebarHeader`.
- Active tab has a sliding indicator (layoutId animation from the existing sidebar active indicator pattern).
- Badge count (e.g., "2 active runs") rendered as a small number overlay on the Schedules icon.
- Sessions gets the text label (it's primary and users spend 90% of time there). Schedules and Connections are icon-only with tooltips.
- **Pros:** Minimal vertical space, matches DorkOS "instrument/control panel" brand direction, fits the existing narrow 320px sidebar width, familiar to developers (VS Code, JetBrains model), badge count surfaced without click.
- **Cons:** Requires icon clarity — the three icons must be instantly recognizable (MessageSquare/Clock/Network). Tooltips required for keyboard/a11y.
- **Persona fit:** Kai would recognize this immediately; Priya would approve of the information density. Jordan would find it "confusing" — which is correct.

**Approach 2: Icon-Only Vertical Activity Bar (VS Code pattern)**

```
  [ ≡ ]
  [ ⏱ 3]
  [ ⚡ ]
```

- Vertical column of icons on the left edge of the sidebar.
- Classic VS Code model.
- **Pros:** Already established mental model for developers, excellent badge support, very efficient.
- **Cons:** Would require adding a second column to the sidebar (activity bar + content panel), eating into the already narrow 320px. Would need to widen sidebar or accept very narrow content area. Architecturally more complex — sidebar becomes a two-column layout.
- **Persona fit:** Good for Kai, neutral for Priya. But the implementation complexity outweighs the benefit vs. horizontal tabs for a 3-view sidebar.

**Approach 3: Text Tabs (Horizontal, Below Header)**

```
[─────────────────────────────────]
[ Sessions  | Schedules | Connect ]
[─────────────────────────────────]
```

- Full text labels, like a standard browser tab strip.
- **Pros:** Maximally clear. No tooltip needed. Self-labeling.
- **Cons:** In a 320px sidebar, three text labels are tight. "Connections" alone is 11 characters. Would either overflow or require truncation. Looks like a consumer app, not a control panel. Anti-persona (Jordan) would love it — bad signal.
- **Persona fit:** Jordan-bait. Priya would accept it but find it slightly verbose. Kai would prefer icon density.

**Approach 4: Segmented Control (iOS-style compact toggle)**

```
[─────────────────────────────────]
[ ≡  ·  ⏱  ·  ⚡ 2 ]  ← connected pill control
[─────────────────────────────────]
```

- Three-item pill with connected borders (no separation between items).
- **Pros:** Very compact, familiar from Apple HIG and modern web UIs, strong visual affordance for "mutually exclusive selection."
- **Cons:** Tight on available space for three items. The "connected" visual implies the three items are variants of the same thing (like font size S/M/L), not three distinct views. Semantically slightly misleading for navigation between substantially different views.
- **Persona fit:** Priya would recognize Apple HIG. Kai might prefer the VS Code icon rail model. Acceptable but not optimal.

### 4. Which Icon Per Tab

| Tab         | Icon (Lucide)              | Rationale                                |
| ----------- | -------------------------- | ---------------------------------------- |
| Sessions    | `MessageSquare`            | Direct mapping to conversations/sessions |
| Schedules   | `CalendarClock` or `Timer` | Pulse = time-based scheduling            |
| Connections | `Network` or `GitBranch`   | Relay + Mesh = network topology          |

The current sidebar already uses `HeartPulse` for Pulse in AgentContextChips. For tab navigation (which is a different context — primary view nav, not status chip), using `CalendarClock` or `Timer` may be clearer as a tab label since it implies "runs that happen on a schedule" vs "health pulse."

### 5. Glanceable Information Without Clicking

The power of the tab design is badge counts surfaced before the user opens a view:

| Tab         | Badge / Indicator             | Data Source                                     |
| ----------- | ----------------------------- | ----------------------------------------------- |
| Sessions    | None (or new session dot)     | N/A — you're here                               |
| Schedules   | `activeRunCount` number badge | `useCompletedRunBadge` + active runs from Pulse |
| Connections | Green/amber/red dot           | Relay connection health + Mesh agent count      |

**Badge design principles (from Material Design 3 + Apple HIG):**

- Number badges: small rounded pill, 16px min-width, `text-2xs`, positioned top-right of icon.
- Status dot (no number): 6px circle, semantic color (green=connected, amber=degraded, red=error/disconnected).
- Badge visibility: Only show when count > 0 or status is non-nominal. Clear the badge when the user navigates to that tab.
- DorkOS already has the `unviewedCount` / `clearBadge` pattern in `useCompletedRunBadge` — reuse this directly for the Schedules badge.

### 6. Animation Patterns for Tab Transitions

From the existing design system:

- **Tab indicator sliding:** Use `layoutId` on the active tab background/underline. Same spring preset as sidebar active indicator: `stiffness: 280, damping: 32`. This creates the deliberate, smooth slide the design system already uses.
- **View transition:** The view content should NOT animate between tabs (would feel slow/disorienting). Simply switch the CSS display state. The tab indicator animation is sufficient affordance.
- **Badge appearance:** Fade in + scale from 0.8, `stiffness: 400, damping: 30` (same as button tap feedback). Remove with fade out.

What NOT to do:

- No slide-left / slide-right page transitions between views (disorienting in a narrow sidebar).
- No crossfade between view content (adds delay, unnecessary complexity).
- No bounce or elastic effects.

### 7. Keyboard Shortcuts

DorkOS uses `Cmd+B` for sidebar toggle. Consistent extension:

| Action                | Shortcut           | Rationale                         |
| --------------------- | ------------------ | --------------------------------- |
| Focus sidebar         | `Cmd+B` (existing) | Opens sidebar, focuses active tab |
| Switch to Sessions    | `Cmd+1`            | First tab, standard numbering     |
| Switch to Schedules   | `Cmd+2`            | Second tab                        |
| Switch to Connections | `Cmd+3`            | Third tab                         |
| Cycle tabs            | `Cmd+]` / `Cmd+[`  | Browser-familiar tab cycling      |

VS Code uses `Ctrl+Shift+E` (Explorer), `Ctrl+Shift+G` (Git), etc. for view switching — function-named shortcuts. For DorkOS with only 3 views, numbered shortcuts are simpler and more memorable.

The shortcuts should be registered in `useEffect` in the sidebar component (or in the global keyboard handler, if one exists). They should only fire when the sidebar is open.

### 8. Accessibility — ARIA Tab Pattern

WAI-ARIA requires for proper tab accessibility:

```tsx
<div role="tablist" aria-label="Sidebar views">
  <button
    role="tab"
    id="tab-sessions"
    aria-controls="panel-sessions"
    aria-selected={activeTab === 'sessions'}
  >
    {/* icon */}
  </button>
  {/* repeat for other tabs */}
</div>

<div
  role="tabpanel"
  id="panel-sessions"
  aria-labelledby="tab-sessions"
  tabIndex={0}
  hidden={activeTab !== 'sessions'}
>
  <SessionsView />
</div>
```

Key requirements:

- `role="tablist"` on the container, `role="tab"` on each button.
- `aria-selected="true"` on the active tab.
- `aria-controls` pointing to the panel `id`.
- Arrow keys (left/right) navigate between tabs in the tablist.
- `Tab` key moves focus from the tablist to the active panel.
- Icon-only tabs must have `aria-label` or `title` for screen readers.

### 9. What Views Should Contain

**Sessions view (primary, unchanged):**

- Current `SidebarContent` with temporal session grouping.
- `+ New session` button stays in `SidebarHeader` (always visible regardless of active tab).
- Scroll position must be preserved on tab switch.

**Schedules view (Pulse in sidebar):**

- Currently, Pulse is a modal dialog opened from `AgentContextChips`. The question is how much Pulse content lives in the sidebar tab vs the dialog.
- **Recommended scope:** Show a read-only summary of upcoming/active runs, with a "Open Pulse" button that triggers the existing full Pulse dialog. Don't duplicate the full Pulse UI in the sidebar — it's complex and the sidebar is narrow.
- Glanceable content: list of upcoming scheduled runs with next-fire time + status. Active runs with a progress indicator.
- This replaces the Pulse chip in `AgentContextChips` as the primary entry point.

**Connections view (Relay + Mesh):**

- Currently, Relay and Mesh are separate modal dialogs from `AgentContextChips`.
- **Recommended scope:** Show Relay adapter health (connected/disconnected status per adapter) + Mesh agent roster (registered agents, online/offline). Two sections within one view.
- "Open Relay" and "Open Mesh" buttons for the full management dialogs.
- This is the "glance at the network" view — see that everything is green, not manage connections.

### 10. What Happens to AgentContextChips

The existing `AgentContextChips` in `SidebarFooter` shows Pulse/Relay/Mesh/Adapter status icons. With dedicated tabs, these chips become redundant for status — their primary remaining value is as quick-open triggers for the dialogs.

**Options:**

1. Keep AgentContextChips as dialog launchers only (remove status indicators, since they move to the tab badges).
2. Remove AgentContextChips entirely — their dialog-open role moves to the "Open Pulse" / "Open Relay" / "Open Mesh" buttons inside the tab views.
3. Keep them but simplify to icon-only without status dots (since status is now on the tab badges).

**Recommendation:** Remove `AgentContextChips` — the tab badges and view summaries replace the status dots; the dialog-open buttons inside the views replace the click-to-open behavior. Simplify the footer. The footer bar (`SidebarFooterBar`) with branding/settings/theme stays.

---

## Detailed Analysis

### Sidebar Architecture After Tabbed Views

```
SidebarHeader
  └── "+ New session" button (always visible — creating sessions is the primary action)

[Tab Row]
  ├── [≡ Sessions]  [⏱ 2]  [⚡ ●]
  └── (sliding layoutId indicator)

SidebarContent
  ├── <SessionsView />  (hidden when not active, scroll preserved)
  ├── <SchedulesView />  (hidden when not active)
  └── <ConnectionsView />  (hidden when not active)

SidebarFooter
  ├── ProgressCard (onboarding, conditional)
  └── SidebarFooterBar (branding, settings, theme)
  ─── AgentContextChips REMOVED (replaced by tab content)
```

The `+ New session` button stays in `SidebarHeader` above the tabs because:

1. Creating a new session is the most common action in the app — it must never be behind a tab click.
2. It doesn't belong to the Sessions tab only — it's an app-level action.
3. It keeps the header clean and consistent regardless of which tab is active.

### Tab Row Implementation Sketch

```tsx
// Tab configuration — drives both the tab row and the view rendering
const SIDEBAR_TABS = [
  {
    id: 'sessions',
    label: 'Sessions',
    icon: MessageSquare,
    ariaLabel: 'Sessions',
    badge: null, // never badged — you're always in sessions
  },
  {
    id: 'schedules',
    label: 'Schedules',
    icon: CalendarClock,
    ariaLabel: 'Schedules — Pulse',
    badge: 'activeRunCount', // numeric from useCompletedRunBadge
  },
  {
    id: 'connections',
    label: 'Connections',
    icon: Network,
    ariaLabel: 'Connections — Relay & Mesh',
    badge: 'connectionStatus', // dot indicator (green/amber/red)
  },
] as const

// Sliding indicator via layoutId
<LayoutGroup>
  {SIDEBAR_TABS.map((tab) => (
    <button
      key={tab.id}
      role="tab"
      aria-selected={activeTab === tab.id}
      onClick={() => setActiveTab(tab.id)}
      className="relative flex-1 flex items-center justify-center py-2"
    >
      {activeTab === tab.id && (
        <motion.div
          layoutId="sidebar-tab-indicator"
          className="absolute inset-0 bg-accent rounded-md"
          transition={{ type: 'spring', stiffness: 280, damping: 32 }}
        />
      )}
      <tab.icon className="relative z-10 size-[--size-icon-sm]" />
      {tab.badge && <BadgeCount value={...} />}
    </button>
  ))}
</LayoutGroup>
```

### State Management

The active tab should live in Zustand (`app-store.ts`) as `sidebarActiveTab: 'sessions' | 'schedules' | 'connections'`, defaulting to `'sessions'`. This allows:

- Keyboard shortcuts from any component to switch tabs.
- The tab to persist across sidebar open/close cycles.
- Future deep-linking via URL if ever needed.

It should NOT be stored in `localStorage` separately — Zustand already handles app state persistence.

### Metrics for Success

From Kai's perspective: "I can check how many Pulse runs are queued without leaving a session, and the counter is right there on the tab." From Priya's: "I switched to Connections, confirmed Relay was connected, switched back to Sessions, and my scroll position was exactly where I left it."

---

## Delight Opportunities

### Micro-Interactions That Would Surprise Kai

1. **Badge clear animation:** When Kai navigates to the Schedules tab, the badge count fades out with a subtle scale-down (`scale: 1 → 0.5, opacity: 1 → 0`, 150ms). Communicates "you've seen it."

2. **Active run pulse indicator:** On the Schedules badge, a very subtle pulsing ring around the badge when a run is actively executing (CSS animation, not motion.dev — it's continuous). Like a live indicator. Kai would notice and understand: "something is running right now."

3. **Connection status dot on hover:** Hovering the Connections tab shows a tooltip with a one-line summary: "Relay: 2 adapters connected · Mesh: 4 agents online." This is glanceable detail without clicking.

4. **First-open animation for Schedules/Connections views:** On first navigation to a view (tracked by a ref, not state), animate the content items in with a subtle stagger (40ms per item, first 5 items only). Subsequent visits are instant. Makes the view feel responsive on first open without being distracting.

5. **Tab keyboard shortcut hint in tooltip:** The Schedules tab tooltip reads "Schedules ⌘2" — the shortcut is discoverable without documentation.

### What Control Panel Feel Actually Means

"Control panel" vs "consumer app" manifests in these specific decisions:

- **Icon-only tabs** (not labeled "Chat" / "Scheduler" / "Network") — operators know their tools.
- **Badge counts as raw numbers**, not "You have 3 notifications!" copy.
- **Status as color signal** (green dot = good), not status text ("Connected").
- **No tooltips for basic function** (Sessions, Schedules, Connections are self-evident to target users).
- **No onboarding copy inside the views** — the ProgressCard handles onboarding.
- **Precise information density:** The Schedules view shows next-fire time, last-run status, run count. Not "Your schedule is active!"

---

## Potential Solutions / Approaches (Summary)

### Solution 1: Icon-Only Horizontal Tabs with CSS Toggle (RECOMMENDED)

**Implementation:** A 3-button `role="tablist"` row between `SidebarHeader` and `SidebarContent`. Views rendered simultaneously, toggled with `hidden` class. Motion `layoutId` sliding indicator on active tab. Badge counts on Schedules and Connections tabs.

**Pros:**

- Minimal implementation complexity (builds on existing patterns).
- Works with current React 19 (no 19.2 dependency).
- Matches brand direction (operator, control panel, information-dense).
- Reuses existing animation presets (`layoutId`, spring `280/32`).
- Badge counts serve as glanceable system-status indicators.
- Keyboard accessible via ARIA tablist pattern + Cmd+1/2/3 shortcuts.

**Cons:**

- CSS `hidden` does NOT clean up Effects — need to ensure Schedules/Connections views don't over-fetch when not visible. Mitigated by TanStack Query's built-in deduplication.
- Three views simultaneously mounted increases initial render cost slightly (minor at this scale).

**Implementation complexity:** Low (2-3 days of focused work).

### Solution 2: Icon-Only Horizontal Tabs with React `<Activity>` (FORWARD-LOOKING)

**Same as Solution 1 but replaces `hidden` class with `<Activity mode="visible"|"hidden">`.**

**Pros:**

- Effects clean up when hidden (no zombie fetches).
- Pre-renders inactive views at low priority (faster first navigation).
- Semantically correct — the official React answer to keep-alive tabs.

**Cons:**

- Requires React 19.2 specifically. Current project version may be 19.0 or 19.1.
- Slightly more syntax overhead.

**Implementation complexity:** Same as Solution 1 once React version is confirmed.

### Solution 3: Vertical Activity Bar (VS Code Model) — NOT RECOMMENDED

**Adds a left icon column (20px wide) to the sidebar, content area narrows to 300px.**

**Pros:**

- Most established pattern for developer tooling.
- Easy to extend to more views later.

**Cons:**

- Implementation complexity significantly higher — sidebar becomes two-column layout.
- 320px total width leaves only 300px for content — very tight.
- Overkill for 3 views. VS Code has 8+ views in the activity bar.
- The `collapsible="offcanvas"` Shadcn sidebar would need structural changes.

**Implementation complexity:** High (5-7 days, requires sidebar layout refactor).

### Solution 4: Full Text Tab Bar (Horizontal, Labeled)

**Pros:** Most accessible, zero learning curve.

**Cons:** Consumer-app aesthetic, tight on 320px with 3 labels, anti-persona bait.

**Implementation complexity:** Low, but wrong choice.

---

## Security and Performance Considerations

**Performance:**

- Three simultaneously-mounted views: minimal overhead. Sessions view already renders the session list. Schedules and Connections views would be lightweight (read-only summaries, not the full management dialogs). TanStack Query handles deduplication — even if both views query the same endpoint, only one HTTP request fires.
- The CSS `hidden` approach keeps all three views in the DOM, increasing node count slightly. With `<Activity>`, the hidden nodes are removed from the browser's render tree, saving style recalculation cost. For a narrow sidebar panel, this difference is negligible.
- Scroll position preservation: automatic with CSS `hidden` (the scroll container remains in DOM). With `<Activity>`, also automatic.

**State synchronization:**

- `sidebarActiveTab` in Zustand ensures tab state survives sidebar open/close (mobile Sheet re-mounts would otherwise reset local component state).
- Badge clear (unviewedCount) must trigger when navigating TO the Schedules tab, not just when the Pulse dialog opens. Update `useCompletedRunBadge` usage accordingly.

---

## Research Gaps and Open Questions

1. **React version**: What is the exact React version in the project? If 19.2+, `<Activity>` is the preferred approach. If earlier, CSS toggle.
2. **Connections tab scope**: Should Connections show Relay + Mesh combined, or only one? Priya with 4+ registered agents might find a combined view cluttered. A sub-segmented control within the view (Relay | Mesh) might be appropriate.
3. **Schedules view content**: The existing Pulse dialog is feature-rich (create schedule, run history, approval gates). The sidebar tab should be read-only summary. What is the minimum useful information for Kai to glance at? Needs product decision.
4. **New session button visibility**: Current placement in `SidebarHeader` is correct. Should it be visible only when Sessions tab is active? No — it's an app-level action. This research confirms it stays always-visible.
5. **Mobile behavior**: On mobile, the sidebar is a Sheet (Vaul drawer). The 3-tab row still works in this context — same component. No special mobile handling needed.

---

## Contradictions and Disputes

- **"Three tabs is exactly the right number"**: The design converges on three views matching DorkOS's three subsystems (Engine/Console → Sessions, Pulse → Schedules, Relay+Mesh → Connections). However, this may create a "Connections" view that conflates two distinct systems (Relay = messaging, Mesh = discovery). Future consideration: if Mesh becomes complex enough, split into separate tabs (4 total). At current scale, combined is correct.
- **Icon-only vs. icon+text**: The recommendation is icon-only (with the Sessions tab potentially getting a text label since it's primary). Some might argue all three need text for clarity. Counter-argument: developers who adopt DorkOS understand "Sessions", "Pulse schedules", and "Relay/Mesh connections" — three icons are sufficient once learned in 5 minutes. The tooltip on hover provides disambiguation for new users.

---

## Recommendation

**Implement Approach 1 (Icon-Only Horizontal Tabs with CSS Toggle) with these specific decisions:**

1. Tab row sits between `SidebarHeader` and `SidebarContent` — a dedicated `SidebarTabRow` component at the `features/session-list` level (or a new `features/sidebar-tabs` feature module).
2. Sessions tab gets text label "Sessions" (primary view, benefits from clarity). Schedules and Connections are icon-only with tooltips.
3. Badge on Schedules: numeric count (`activeRunCount` from `useCompletedRunBadge`).
4. Badge on Connections: status dot (green/amber/red) from relay connection health.
5. Sliding `layoutId` indicator using spring `stiffness: 280, damping: 32` (matching existing sidebar active indicator).
6. Views toggled with Tailwind `hidden` class.
7. `sidebarActiveTab` added to Zustand `app-store.ts`.
8. Keyboard shortcuts: `Cmd+1/2/3` for tab switching (registered as global keyboard listener when sidebar is open).
9. `AgentContextChips` removed — its status and dialog-open roles move to the tab badges and view content.
10. ARIA `role="tablist"` / `role="tab"` / `role="tabpanel"` pattern fully implemented.

This solution is **low complexity, high impact**, consistent with existing patterns, and deliberately "operator-grade" — exactly what Kai wants and Priya would respect.

---

## Sources and Evidence

- [React `<Activity>` official docs](https://react.dev/reference/react/Activity) — keep-alive behavior, mode prop, Effects behavior
- [VS Code UX Guidelines: Activity Bar](https://code.visualstudio.com/api/ux-guidelines/activity-bar) — established developer tool navigation pattern
- [VS Code UX Guidelines: Sidebars](https://code.visualstudio.com/api/ux-guidelines/sidebars) — sidebar view container patterns
- [Zed panel system blog](https://zed.dev/blog/new-panel-system) — focus-toggle, dock system, state persistence
- [React Activity Component — deep dive (PAS7 Studio)](https://pas7.com.ua/blog/en/react-activity-component) — practical patterns and edge cases
- [React Activity vs display:none (Medium)](https://louisphang.medium.com/react-activity-api-vs-display-none-guide-3c863c33664a) — performance comparison
- [ARIA tablist role — MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/tablist_role) — accessibility requirements
- [ARIA tab role — MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/tab_role) — keyboard navigation spec
- [ARIA tabpanel role — MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/tabpanel_role) — panel accessibility
- [Tabs vs Segmented Controls (Medium)](https://medium.com/@errumaisha/when-ui-looks-alike-understanding-confusion-between-tabs-and-segmented-controls-fbdfa651f9d9) — semantic difference
- [Apple HIG: Segmented Controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls) — when to use segmented vs tab
- [Apple HIG: Tab Bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars) — badge count patterns, icon-only guidelines
- [Tabs UX Best Practices (Eleken)](https://www.eleken.co/blog-posts/tabs-ux) — general tab design guidance
- [Material Design 3: Badges](https://m3.material.io/components/badges) — badge count design patterns
- [Deque: ARIA Tab Panel Accessibility](https://www.deque.com/blog/a11y-support-series-part-1-aria-tab-panel-accessibility/) — focus management in tab interfaces
- [JetBrains IntelliJ Tool Windows](https://www.jetbrains.com/help/idea/tool-windows.html) — icon-based tool window navigation with keyboard shortcuts
- [DorkOS Shadcn Sidebar Redesign research](research/20260303_shadcn_sidebar_redesign.md) — internal, Shadcn Sidebar API details
- [React 19.2 Activity Component (Dev.to)](https://dev.to/preethi_dev/react-192-introduces-a-new-component-10cp) — React 19.2 release details
- [React Labs: View Transitions, Activity, and more](https://react.dev/blog/2025/04/23/react-labs-view-transitions-activity-and-more) — official React roadmap context
- [React Activity API guide (LearnWebCraft)](https://learnwebcraft.com/learn/react/react-19-2-activity-component-guide) — practical implementation guide
- [keepalive-for-react (GitHub)](https://github.com/irychen/keepalive-for-react) — third-party alternative if Activity not available

---

## Search Methodology

- Searches performed: 10
- Most productive search terms: "React Activity component concurrent mode tab keep-alive 2024 2025", "CSS visibility hidden vs display none React tab state preservation", "segmented control vs tabs developer tool sidebar UX"
- Primary source types: React official docs, VS Code UX guidelines, Apple HIG, MDN accessibility docs, developer tool design blog posts
