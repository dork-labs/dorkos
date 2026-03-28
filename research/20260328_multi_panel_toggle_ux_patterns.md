---
title: 'Multi-Panel Toggle UX Patterns — Right Panel, Consistency, Mobile, Indicators'
date: 2026-03-28
type: external-best-practices
status: active
tags:
  [
    panel-toggle,
    sidebar,
    right-panel,
    canvas,
    ux-patterns,
    keyboard-shortcuts,
    mobile,
    state-indicators,
    vs-code,
    figma,
    linear,
    obsidian,
    cursor,
    progressive-disclosure,
  ]
searches_performed: 14
sources_count: 28
---

# Multi-Panel Toggle UX Patterns — Right Panel, Consistency, Mobile, Indicators

## Research Summary

This report synthesizes findings from 14 searches covering five distinct facets of multi-panel toggle UX in developer and productivity tools. The dominant pattern across all surveyed tools is **dual-access toggle** — a dedicated button in the header/toolbar that is always visible (not hidden inside the panel itself), backed by a keyboard shortcut. Right-panel toggles are overwhelmingly placed in the top-right corner of the main toolbar, mirroring the left sidebar toggle placed in the top-left, creating visual symmetry that aids discoverability. The biggest UX failure mode, documented concretely in both Notion and Cursor, is hiding the toggle button inside the panel — this breaks the user's ability to reopen it without knowing the keyboard shortcut.

---

## Key Findings

### 1. Right-Panel Toggle Button Placement

The near-universal pattern for developer tools is: **button in the application toolbar/title bar, far right, always visible regardless of panel state**.

- **VS Code Secondary Sidebar (right panel)**: Toggle button sits in the title bar alongside buttons for the primary sidebar and bottom panel. The command is `View: Toggle Secondary Side Bar Visibility`, shortcut `⌥⌘B` (macOS) / `Ctrl+Alt+B` (Windows/Linux). The title bar button row is the primary toggle surface; keyboard shortcut is secondary. The button is always rendered in the title bar whether the sidebar is open or closed.

- **Xcode Inspector (right panel)**: Toggle button located in the toolbar area above the inspector pane. Keyboard shortcut is `⌘⌥0`. Additional shortcuts `⌘⌥1` through `⌘⌥5` switch between inspector tabs (Attributes, Size, Identity, etc.) — the tab-level shortcuts presuppose the panel is open.

- **Figma Design/Inspect panel (right panel)**: No dedicated right-panel-only keyboard shortcut in UI3. `Shift + \` toggles both left and right panels simultaneously. `Cmd + \` hides the entire UI. There is no button dedicated specifically to the right panel. This is a known friction point — a Figma forum feature request for an independent right-panel shortcut received 29 upvotes, with users noting the right panel can be less important than layers and should be independently dismissible.

- **Figma panel switching (within the right panel)**: `Alt + 8` opens the Design panel, `Alt + 9` the Prototype panel. Panel mode switching is keyboard-accessible even though panel visibility is not. `Shift + D` toggles Dev Mode, which also changes the right panel's context.

- **Cursor AI Chat**: Originally had a Cursor logo icon button in the top-right corner of the title bar to toggle the chat panel. This button was removed in a version update, causing significant community backlash (multiple forum threads in 2025-2026). The button was later restored. The keyboard shortcut `⌥⌘B` (inheriting from VS Code's secondary sidebar) works but fails when focus is inside the chat input field — a persistent usability bug. The lesson: keyboard-only toggle is insufficient; the always-visible button is load-bearing.

- **Obsidian**: Both left and right sidebars have independent toggle commands (`Toggle left sidebar`, `Toggle right sidebar`) assignable to custom hotkeys. Default hotkeys are not pre-assigned — users must configure them. Visual button indicators exist in the sidebar header area. On mobile, sidebars appear as modal overlays rather than inline panels, with a different toggle mechanism (swipe from edge or button tap).

---

### 2. Consistency Between Left and Right Panel Toggles

**Strong industry consensus: symmetric toggle UX.** The pattern is always-visible button in the corresponding corner of the toolbar, with a keyboard shortcut. Left toggles from the top-left area, right toggles from the top-right area.

**VS Code implements this symmetrically:**

- Primary Sidebar toggle button: top-left region of title bar (`⌘B`)
- Secondary Sidebar (right) toggle button: top-right region of title bar (`⌥⌘B`)
- Both are always visible in the title bar regardless of panel state

**Xcode implements this symmetrically:**

- Navigator (left): `⌘0`
- Inspector (right): `⌘⌥0`
- Debug Area (bottom): `⌘⇧Y`
- The modifier key escalation (`⌘0` → `⌘⌥0`) clearly signals "same pattern, other side"

**Why the symmetry matters for DorkOS:** If the left sidebar toggle is a button in the header, users will immediately look in the header top-right corner for a right-panel toggle. This expectation is load-bearing. Breaking it forces users to discover the shortcut or hunt for the control.

**Legitimate reasons to differ:**

1. **Semantic difference in content**: If the right panel is a temporary overlay/peek (like Linear's spacebar preview or Notion's side peek) rather than a persistent workspace surface, it can use a different interaction model — hover-triggered, spacebar, or contextual button near the content trigger. This is appropriate when the panel is ephemeral by design.
2. **Different trigger contexts**: A right panel that only makes sense in certain views (e.g., an inspector that appears only when an item is selected) can have a contextual trigger (a "View details" button near the content) rather than a persistent toolbar button. But this should be _in addition to_ the toolbar toggle, not instead of it.
3. **The Notion anti-pattern**: Notion's Layout Details Panel has at minimum 4 different ways to toggle it — "Hide Details" button inside the page header, "Close page info" icon button in the panel itself, "Close panel" double-caret button in the panel, and a keyboard shortcut `Ctrl+Shift+\`. This redundancy without hierarchy confuses users. One critical reviewer noted "3 differently worded buttons, all in different locations and different sizes." This is a cautionary example of inconsistency caused by iterative accretion.

---

### 3. Mobile Panel Toggling

Developer productivity apps converge on two patterns for mobile panel access:

**Pattern A — Bottom Sheet (contextual, ephemeral content)**

- Used when the right panel content is supplementary to the main view (details, inspector, properties)
- Snaps to partial height (~40-50% screen) with drag-to-dismiss
- NN/G recommends: use for contextual details, NOT for stable areas users return to repeatedly
- Asana and Linear both use this pattern for issue details on narrow screens
- The panel animates up from the bottom; primary content scrolls behind it
- Dismiss via swipe down or tap-outside

**Pattern B — Tab Bar or Sheet with Navigation (primary sections)**

- Used when the "panel" content is actually a primary navigation section (e.g., Agents list, Schedules)
- On narrow screens, the left sidebar becomes a bottom sheet or a full-screen navigation stack
- Apple HIG and Material Design both recommend tab bars (3-5 items) for primary sections
- Obsidian on iOS: sidebars become swipe-triggered panels from screen edges (swipe from left = left sidebar, swipe from right = right sidebar)
- Arc Browser on mobile: the left sidebar collapses entirely; space-bar split view becomes unavailable; single-column layout with persistent bottom navigation

**What does NOT work on mobile:**

- Persistent side panels — any right panel that shows as a column next to the content on desktop should collapse into a modal/sheet or disappear entirely below ~768px
- Edge-swipe as the only access method — Android split-screen mode consumes edge swipes, breaking this pattern
- Hover-triggered panels (hover doesn't exist on touch)

**Shadcn Sidebar behavior (relevant to DorkOS)**: The shadcn `SidebarProvider` automatically switches to a `Sheet` component (modal overlay) at the 768px breakpoint via an internal `isMobile` hook. This is the correct baseline behavior. A right panel should follow the same breakpoint logic independently.

---

### 4. Emerging Patterns for Multi-Panel Layouts

**4.1 Peek/Quick Look pattern (Linear, Notion)**

- **Linear**: Press `Space` while hovering an issue in a list → preview panel appears (right side or overlay). Hold `Space` for temporary peek; press `Space` again to toggle. Navigate through items with `J/K` while peek is active. Essentially a keyboard-driven ephemeral panel, no button in the toolbar — the affordance is entirely in the list interaction. This works because the spacebar convention is established (macOS QuickLook) and the content (issue preview) is always ephemeral.
- **Linear command menu**: `Cmd/Ctrl + K` → right arrow key → triggers "quick look" on the highlighted item. Command palette integration for panel opening is a distinct emerging pattern.

**4.2 Always-visible toggle button (VS Code evolution)**

- The GitHub issue #282652 in VS Code requests redesigning the Copilot/agent sidebar hide button as "always visible toggle." Currently the sidebar's own hide button only appears when the sidebar is visible. The request is to put a persistent toggle button in a location that is always rendered. This is the direction the ecosystem is moving.

**4.3 Title bar layout controls / Customize Layout dropdown (VS Code)**

- VS Code added a "Customize Layout" button at the far right of the title bar that opens a dropdown showing all major UI sections (Side bars, Panel region, Status Bar, etc.) with toggles. This is a meta-panel for layout state management, separate from per-panel quick-toggles. Useful for power users; not the primary interaction for common show/hide.

**4.4 Resizable panels over fixed layouts**

- VS Code, Cursor, and Linear all support drag-to-resize panel widths. The trend in 2025 is away from fixed-width panels toward min/max constrained resizable panels. `react-resizable-panels` (shadcn's recommended primitive) enables this.

**4.5 Command palette as panel opener**

- VS Code's `View: Focus on Chat` and `View: Toggle Secondary Side Bar Visibility` are registered commands, accessible via `Cmd+Shift+P`. This means any panel can be opened/focused through the command palette. Figma's `Alt+8` (switch to Design panel) and `Shift+D` (Dev Mode) are panel-specific shortcuts that exist alongside command palette integration. For DorkOS, registering panel commands in the command palette (already researched in `research/20260303_command_palette_10x_elevation.md`) is a natural extension of the toggle pattern.

**4.6 Progressive disclosure via panel state memory**

- Figma's behavior: if you select an object while both panels are hidden (`Shift + \`), the right panel auto-expands to show properties for the selection, then collapses when deselected. This is "smart" panel state — the panel reveals itself when contextually relevant. Relevant for DorkOS if the canvas panel should auto-open when an agent is actively writing to it.

---

### 5. Panel State Indicators (When Closed)

This is an area where there is no single dominant pattern, and practices vary significantly.

**5.1 Toggle button with directional chevron**

- Most common: the toggle button itself uses a chevron/arrow icon that points in the direction of the closed panel. When right panel is closed, button shows `›` (pointing right toward the hidden panel). When open, shows `‹`. VS Code uses this approach on its Activity Bar and panel title bars.
- Advantage: The button itself communicates both the action (click to open) and the direction.

**5.2 Badge/dot on the toggle button**

- Used when the closed panel has actionable or unread content. VS Code's Activity Bar icons (Explorer, Git, Extensions) show numeric badges when there is content needing attention (e.g., "3 pending source control changes"). The badge appears on the icon in the Activity Bar regardless of whether the panel is open.
- VS Code's notification system uses a status bar item with a dot and count: a bell icon with a numeric badge in the bottom-right status bar, always visible.
- Linear's sidebar navigation uses this pattern for activity counts — a subtle number badge on the sidebar item indicates activity without requiring the user to open the panel.

**5.3 Color/status dot on the toggle button**

- Appears in observability tools (Grafana, Datadog) where panel content has a health status. The toggle button shows a green/yellow/red dot to indicate the state of content inside the panel without requiring the user to open it.
- Relevant for DorkOS: if the canvas panel contains an agent's active output, a subtle animated dot (matching the existing `background-agent-indicator` patterns in `research/20260323_background_agent_indicator_animation.md`) on the toggle button could indicate active content.

**5.4 Tooltip on closed panel toggle**

- Several tools use a tooltip on the closed-panel toggle button that previews what's inside: e.g., "Inspector: 2 items selected" or "Chat: Last message 3 minutes ago." This is rare but powerful — it surfaces key state without requiring the panel to be open.

**5.5 What does NOT work:**

- Pulse/glow animation on the panel toggle button — visually noisy, creates urgency where there may be none. Only appropriate for true alerts, not ambient state.
- Empty state text inside the panel that's only visible when open — the user has to open the panel to know if there's content. This is the "invisible mailbox" anti-pattern.
- Hiding the toggle button entirely when the panel is empty — this creates modal confusion where the panel cannot be reopened until content appears.

---

## Detailed Analysis

### How VS Code's Secondary Sidebar Resolves the Toggle Problem

VS Code's title bar has a structured row of layout toggle buttons at the far right. Left to right: Activity Bar toggle, Primary Sidebar toggle, Panel (bottom) toggle, Secondary Sidebar (right) toggle, Customize Layout dropdown. This is the most mature implementation studied. Key properties:

1. **Always visible**: Every toggle button renders regardless of the state of the region it controls. If the right sidebar is closed, the button is still present.
2. **Icon semantics**: Each button uses an icon that visually represents the region (a sidebar icon facing right for the secondary sidebar).
3. **Keyboard shortcut symmetry**: Primary sidebar is `⌘B`; secondary is `⌥⌘B`. The Option modifier is a clear "secondary" signal.
4. **Default placement of AI chat**: By default, Copilot Chat opens in the Secondary Sidebar (right). This is where all AI panel content goes in VS Code's model. Moving it to the primary sidebar is possible but non-default.

### Cursor's Toggle Button Saga as a Cautionary Tale

Cursor's chat panel toggle has been added, removed, changed, and restored multiple times in 2025-2026. Forum threads ("toggle chat panel button disappeared," "chat window toggle button disappeared," "guys stop messing around the UI") document real user frustration. The UX lesson: **users treat the always-visible toggle button as load-bearing infrastructure**. When it disappears, they lose access to the panel and file bugs. The button is not decorative; it is the primary recovery mechanism when the user has no muscle memory for the keyboard shortcut.

### Notion's Right Panel Naming Inconsistency as Anti-Pattern

Notion's detail panel has been called: "View details," "Hide Details," "Close page info," and uses a double-caret `«»` icon button. All four exist simultaneously on the same panel. Users cannot predict what clicking will do, because the button label describes the outcome ("Hide Details") or the action ("View details") or neither (icon button). The correct pattern is a single, consistently placed toggle that changes its icon direction (and optionally its tooltip) based on state.

### The Figma Independent Panel Problem

Figma UI3 eliminated independent left/right panel collapse (a regression from UI2). The community response has been strong: 29+ votes for restoring independent right-panel toggle. The friction: designers often want to keep the Layers panel visible while hiding the Design/Inspect panel to focus on the canvas. `Shift + \` collapses both, which loses their layers context. The lesson for DorkOS: if a left sidebar and right panel serve genuinely different purposes (navigation vs. inspection/canvas), they should have independent toggle controls. Coupling them is a UX regression.

---

## Synthesis for DorkOS

Given DorkOS's session page (`/session` route) and the emerging canvas panel, the following patterns apply directly:

**Toggle button placement**: Place the canvas toggle button in the `SessionHeader` (right end of the header bar), mirroring the left sidebar toggle (already in `DashboardHeader`/`DashboardSidebar`). The button should always be rendered, not conditionally shown. Use a `PanelRight` / `PanelRightOpen` icon (Lucide has both) with a chevron direction that indicates the closed state's location.

**Keyboard shortcut**: Assign a shortcut that follows the VS Code/Xcode modifier convention. If left sidebar toggle is `Cmd+[`, right panel toggle should be `Cmd+]` (symmetric bracket keys — a natural mnemonics). Or follow VS Code: left = `⌘B`, right = `⌥⌘B`.

**Mobile**: At or below 768px, the canvas panel should not render as a side column. It should either: (a) collapse entirely and be accessible via a bottom sheet triggered by the same header button, or (b) become a full-screen route. Use shadcn's Sheet component, consistent with how the existing `SessionSidebar` behaves at mobile breakpoints.

**State indicator**: When the canvas panel is closed but contains agent-generated content, show a small activity dot on the toggle button. This matches the `background-agent-indicator` motion pattern already established in the codebase. A numeric badge (e.g., count of canvas artifacts) could supplement the dot if the canvas supports multiple documents.

**Don't**: hide the toggle button inside the panel, create multiple differently-named buttons for the same action, couple canvas panel visibility to left sidebar visibility, or remove the toggle button without providing an equally discoverable replacement.

---

## Sources & Evidence

- VS Code Custom Layout documentation: toggle button in title bar, keyboard shortcuts for primary/secondary sidebars — [Custom Layout – VS Code Docs](https://code.visualstudio.com/docs/configure/custom-layout)
- VS Code UX Guidelines for Sidebars — [Sidebars | VS Code Extension API](https://code.visualstudio.com/api/ux-guidelines/sidebars)
- VS Code user interface overview confirming title bar layout buttons — [User Interface – VS Code Docs](https://code.visualstudio.com/docs/getstarted/userinterface)
- VS Code Secondary Sidebar Medium overview — [VS Code Secondary Side Bar | Medium](https://ash12rai-weblearning.medium.com/visual-studio-code-vs-code-secondary-side-bar-3455910e7a48)
- GitHub issue #282652: "Agent sessions: always visible toggle for sidebar" requesting redesign of hide button — [Issue #282652 · microsoft/vscode](https://github.com/microsoft/vscode/issues/282652)
- Cursor community thread: "Toggle AI Chat Panel with a single shortcut" — keyboard shortcuts, focus failure when in chat input — [Cursor Forum](https://forum.cursor.com/t/toggle-ai-chat-panel-with-a-single-shortcut/1637)
- Cursor community megathread: layout and UI feedback, toggle button disappearing and restoration — [Cursor Megathread](https://forum.cursor.com/t/megathread-cursor-layout-and-ui-feedback/146790)
- Cursor community: "chat window toggle button disappeared" bug report — [Cursor Forum Bug](https://forum.cursor.com/t/chat-window-toggle-button-disappeared/148094)
- Figma keyboard shortcuts documentation — `Shift+D` for Dev Mode, `Alt+8` for Design panel — [Figma Keyboard Shortcuts](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard)
- Figma forum request: independent right-panel hiding (29 votes) — [Figma Forum Feature Request](https://forum.figma.com/suggest-a-feature-11/option-to-hide-the-right-panel-20448)
- Figma forum: "Bring back independent left/right panel collapsing (as in UI2)" — [Figma Forum](https://forum.figma.com/suggest-a-feature-11/bring-back-independent-left-right-panel-collapsing-as-in-ui2-42703)
- Xcode keyboard shortcuts — `⌘⌥0` for Inspector toggle, `⌘0` for Navigator — [Xcode Tips – Keyboard Shortcuts](https://xcode-tips.github.io/keyboard-shortcuts.html)
- Obsidian sidebar documentation — independent left/right toggle commands, mobile edge-swipe — [Obsidian Sidebar Help](https://help.obsidian.md/sidebar)
- Obsidian forum: "Consistent sidebar toggle between mobile and desktop" — modal overlay behavior on mobile — [Obsidian Forum](https://forum.obsidian.md/t/consistent-sidebar-toggle-between-mobile-and-desktop/40128)
- Linear Peek documentation — spacebar trigger, hold-for-temporary, J/K navigation while peeking — [Linear Peek Docs](https://linear.app/docs/peek)
- Linear UI redesign blog — panel and sidebar adjustments, 8px spacing scale — [Linear UI Redesign Part II](https://linear.app/now/how-we-redesigned-the-linear-ui)
- Notion layouts: multiple toggle buttons, naming inconsistency, "at least 4 ways to close" — [Notion Broke Layouts – Medium](https://medium.com/@ianfirth/notion-broke-layouts-10b4aa159ed0)
- Notion side peek mode documentation — [How to Change Notion's Side Peek Setting](https://www.makeuseof.com/change-notion-side-peek-setting/)
- Arc Browser sidebar toggle — `Cmd+S` keyboard shortcut, split view creates a sidebar tab — [Arc Split View Help](https://resources.arc.net/hc/en-us/articles/19335393146775-Split-View-View-Multiple-Tabs-at-Once)
- NN/G bottom sheets guidelines — use for contextual details, not stable navigation — [Bottom Sheets: Definition and UX Guidelines](https://www.nngroup.com/articles/bottom-sheet/)
- Mobile navigation UX best practices 2026 — tab bar for primary, bottom sheet for contextual — [Mobile Navigation UX](https://www.designstudiouiux.com/blog/mobile-navigation-ux/)
- Shadcn Sidebar controlled state + mobile Sheet behavior — (prior research) [research/20260303_shadcn_sidebar_redesign.md]
- VS Code Status Bar UX guidelines — badge/dot indicators for unread state — [Status Bar | VS Code Extension API](https://code.visualstudio.com/api/ux-guidelines/status-bar)
- NN/G: Indicators, Validations, and Notifications — badge semantics and placement — [NN/G Article](https://www.nngroup.com/articles/indicators-validations-notifications/)

---

## Research Gaps & Limitations

- Could not access the Linear or Notion page sources directly due to 403 restrictions. Linear peek behavior was confirmed via official docs and search synthesis. Notion button naming inconsistency was confirmed via a secondary Medium analysis.
- No direct documentation found for Arc Browser's right-side panel UX (Arc primarily has a left sidebar only — no right panel in the conventional sense). Arc's "split view" creates a side-by-side tab layout, not a properties/canvas panel.
- Figma UI3's right panel toggle button specifics were confirmed via community forum posts, not official changelog. The independent collapse regression from UI2 is confirmed community knowledge.
- Cursor's toggle button history is confirmed via forum threads but changelog specifics are not publicly documented.

---

## Contradictions & Disputes

- **Figma**: In UI3, the right panel cannot be independently hidden from the left. This is disputed by the community as a regression and is in conflict with the broader industry pattern of independent panel toggles.
- **Coupling vs. independence**: There is a minority school of thought (reflected in some design tools) that hiding all panels at once (focus/zen mode) is cleaner UX than independent toggles. VS Code's `Ctrl+K Z` (Zen mode) does this. But this coexists with individual toggles — it is not a replacement for them.
- **Keyboard-only vs. button**: A small subset of power users (Cursor forum) prefer keyboard-only (no button) because they consider the button visual clutter. This is a minority position; the dominant industry pattern is both.

---

## Search Methodology

- Searches performed: 14
- Most productive terms: "VS Code secondary sidebar toggle", "Cursor chat panel toggle button disappeared", "Figma right panel hide independent", "Linear peek spacebar", "Notion detail panel toggle buttons"
- Primary sources: VS Code official docs, Cursor community forum, Figma community forum, Linear official docs, Obsidian help, NN/G
- Most signal-dense result: Cursor's forum megathread on layout feedback — documented real user behavior and consequences of removing the always-visible toggle button
