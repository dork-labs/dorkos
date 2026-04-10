# Task Breakdown: Dashboard Content — Mission Control for Your Agent Workforce

Generated: 2026-03-20
Source: specs/dashboard-content/02-specification.md
Last Decompose: 2026-03-20

## Overview

Build the dashboard content for DorkOS — a calm, glanceable mission control where a user operating an AI agent workforce understands the state of everything in 3 seconds. The dashboard replaces three placeholder components (`DashboardPage`, `DashboardSidebar`, `DashboardHeader`) with four content sections (Needs Attention, Active Sessions, System Status, Recent Activity), an augmented header with system health dot and quick actions, and a sidebar with navigation and recent agents.

All data comes from existing entity hooks (sessions, Pulse, Relay, Mesh, agents) — no new server API endpoints required.

## Phase 1: Foundation

### Task 1.1: Create dashboard-status feature module with SubsystemCard and ActivitySparkline

**Size**: Large
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

Create the `features/dashboard-status/` FSD module containing:

- `useSubsystemStatus()` hook deriving Pulse/Relay/Mesh health from entity hooks
- `useSessionActivity()` hook computing 7-day session count bucketed by day
- `SubsystemCard` component with normal, exception, and disabled states
- `ActivitySparkline` pure SVG component rendering 7 vertical bars
- `SystemStatusRow` composing 4 cards in a `grid grid-cols-2 gap-3 lg:grid-cols-4` responsive grid

Tests for hooks (subsystem status derivation, disabled states) and components (SVG bar rendering, card states, click handlers).

**Acceptance Criteria**:

- [ ] `features/dashboard-status/` module exists with all files
- [ ] `useSubsystemStatus()` correctly derives Pulse/Relay/Mesh health
- [ ] `useSessionActivity()` returns 7-element daily count array
- [ ] `SubsystemCard` renders all states: normal, exception, disabled
- [ ] `ActivitySparkline` renders 7 SVG bars with normalized heights
- [ ] `SystemStatusRow` composes 4 cards in responsive grid
- [ ] All unit tests pass
- [ ] Barrel exports all public API

---

### Task 1.2: Create dashboard-sessions feature module with active session cards

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

Create the `features/dashboard-sessions/` FSD module containing:

- `useActiveSessions()` hook filtering sessions updated within 2 hours, resolving agent identity, deriving active/idle status
- `ActiveSessionCard` component showing agent emoji, name, activity line, status dot, elapsed time, and Open button
- `ActiveSessionsSection` component with responsive card grid (max 6), empty state, and overflow link

Tests for hooks (filtering, capping, status heuristic) and components (card anatomy, navigation, empty state).

**Acceptance Criteria**:

- [ ] `features/dashboard-sessions/` module exists with all files
- [ ] `useActiveSessions()` filters by 2-hour window and derives active/idle status
- [ ] `ActiveSessionCard` renders full card anatomy
- [ ] `ActiveSessionsSection` shows responsive grid with max 6 cards
- [ ] Empty state renders with "New session" CTA
- [ ] Overflow shows "and N more active" link
- [ ] All unit tests pass

---

### Task 1.3: Replace DashboardPage with ScrollArea orchestrator composing status and sessions

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

Replace the placeholder `DashboardPage` widget with a `ScrollArea`-wrapped orchestrator composing `ActiveSessionsSection` and `SystemStatusRow`. Container uses `max-w-4xl space-y-8 px-6 py-8`.

**Acceptance Criteria**:

- [ ] `DashboardPage` renders `ScrollArea` with centered container
- [ ] `ActiveSessionsSection` and `SystemStatusRow` composed inside
- [ ] No placeholder text remains
- [ ] FSD layer imports valid
- [ ] `pnpm typecheck` passes

---

## Phase 2: Needs Attention + Header

### Task 2.1: Create dashboard-attention feature module with conditional attention section

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.2

Create the `features/dashboard-attention/` FSD module containing:

- `useAttentionItems()` hook deriving attention items from stalled sessions (>30min idle), failed Pulse runs (last 24h), dead Relay letters (count > 0), and offline Mesh agents (unreachableCount > 0)
- `AttentionItemRow` component with icon, description, relative timestamp, and action button
- `NeedsAttentionSection` with zero DOM when empty, `AnimatePresence` animation, amber header, and stagger limited to 8 items

Tests for hooks (all item types, sorting, exclusions) and components (zero DOM empty, item rendering, action handlers).

**Acceptance Criteria**:

- [ ] `features/dashboard-attention/` module exists with all files
- [ ] `useAttentionItems()` derives items from all four sources
- [ ] Section renders zero DOM when empty
- [ ] Section animates in/out with `AnimatePresence`
- [ ] Items stagger with 0.04s delay, limited to 8
- [ ] Amber header text for section label
- [ ] All unit tests pass

---

### Task 2.2: Augment DashboardHeader with system health dot and quick action buttons

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.1

Add system health dot and quick actions to `DashboardHeader`:

- `useSystemHealth()` hook returning `'healthy' | 'degraded' | 'error'` based on failed runs, dead letters, unreachable agents, disconnected adapters
- `SystemHealthDot` component with colored dot and tooltip
- Updated `DashboardHeader` with health dot, "New session" button, conditional "Schedule" button (Pulse-enabled only)

Tests for hook (all three states, priority logic) and component (dot colors, tooltip messages, button visibility).

**Acceptance Criteria**:

- [ ] `useSystemHealth()` correctly derives health state
- [ ] `SystemHealthDot` renders with correct color and tooltip per state
- [ ] "New session" button navigates to `/session`
- [ ] "Schedule" button visible only when Pulse enabled
- [ ] `CommandPaletteTrigger` still present
- [ ] All unit tests pass

---

### Task 2.3: Wire NeedsAttentionSection into DashboardPage orchestrator

**Size**: Small
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: None

Add `NeedsAttentionSection` as the first child in `DashboardPage` container, above `ActiveSessionsSection`. Zero DOM when empty means `space-y-8` gap naturally collapses.

**Acceptance Criteria**:

- [ ] `NeedsAttentionSection` is first section
- [ ] Section order: Attention, Active Sessions, System Status
- [ ] No visual gap when attention section is empty
- [ ] `pnpm typecheck` passes

---

## Phase 3: Activity Feed + Sidebar

### Task 3.1: Create dashboard-activity feature module with time-grouped event feed

**Size**: Large
**Priority**: High
**Dependencies**: Task 2.3
**Can run parallel with**: Task 3.2

Create the `features/dashboard-activity/` FSD module containing:

- `useLastVisited()` hook reading/writing `localStorage` timestamp
- `useActivityFeed()` hook aggregating session and Pulse events into time-grouped feed (Today/Yesterday/Last 7 days), sorted reverse-chronologically, capped at 20
- `ActivityFeedItem` component with timestamp, type badge (color-coded dot), type label, title, and optional action button
- `ActivityFeedGroup` component with group label and "Since your last visit" separator
- `RecentActivityFeed` section with stagger animation, empty state, and "View all" overflow link

Tests for hooks (grouping, sorting, capping, localStorage) and components (type colors, time formatting, border accent).

**Acceptance Criteria**:

- [ ] `features/dashboard-activity/` module exists with all files
- [ ] `useActivityFeed()` aggregates and groups events correctly
- [ ] `useLastVisited()` reads/writes localStorage
- [ ] "Since your last visit" separator renders correctly
- [ ] New events have blue left border accent
- [ ] Feed capped at 20 with "View all" overflow
- [ ] Empty state renders correctly
- [ ] All unit tests pass

---

### Task 3.2: Replace DashboardSidebar with navigation and recent agents list

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.3
**Can run parallel with**: Task 3.1

Replace placeholder `DashboardSidebar` with:

- Dashboard/Sessions navigation links (Dashboard is active)
- "Recent Agents" section showing up to 8 agents from `recentCwds` app store
- `RecentAgentItem` component with color dot, emoji, name (falls back to path basename)

Tests for components (navigation links, agent rendering, fallback behavior, click handlers).

**Acceptance Criteria**:

- [ ] Dashboard and Sessions navigation links present
- [ ] Recent Agents section shows up to 8 agents
- [ ] Agent items navigate to `/session?dir={path}`
- [ ] Falls back to path basename when no agent manifest
- [ ] Empty recentCwds hides Recent Agents section
- [ ] All unit tests pass

---

### Task 3.3: Wire RecentActivityFeed into DashboardPage and finalize section order

**Size**: Small
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: None

Add `RecentActivityFeed` as the last section in `DashboardPage`, completing the full four-section layout: Needs Attention, Active Sessions, System Status, Recent Activity.

**Acceptance Criteria**:

- [ ] All four sections present in correct order
- [ ] `RecentActivityFeed` is the last section
- [ ] Full page scrolls with all sections populated
- [ ] `pnpm typecheck` passes

---

## Phase 4: Polish + Verification

### Task 4.1: Add entrance animations with stagger to all dashboard sections

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 3.3
**Can run parallel with**: Task 4.2, Task 4.3

Add consistent entrance animations to all sections using module-scope motion variants: `sectionEntrance` (fade + y-offset), `staggerContainer` (0.04s children delay), `staggerItem` (fade + slight y-offset). Stagger limited to 8 items per section.

**Acceptance Criteria**:

- [ ] All sections animate in with fade + y-offset
- [ ] Session and status cards stagger with 0.04s delay
- [ ] Needs Attention animates height 0 to auto
- [ ] Activity feed groups stagger with 0.03s delay
- [ ] Reduced motion preference respected
- [ ] Variants defined at module scope

---

### Task 4.2: Verify light/dark mode, reduced motion, and disabled subsystem states

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 3.3
**Can run parallel with**: Task 4.1, Task 4.3

Verify all visual states: color semantics match spec (neutral for healthy, amber for warning, red for error, green only for completed session badge), dark mode rendering, disabled subsystem card muted state, reduced motion, and first-visit zero state.

**Acceptance Criteria**:

- [ ] All color semantics match specification
- [ ] Components render correctly in light and dark mode
- [ ] Disabled subsystem cards show muted "Disabled" label and remain clickable
- [ ] Mesh card always renders (no feature gate)
- [ ] Reduced motion respected
- [ ] Zero state looks calm and intentional

---

### Task 4.3: Update project-structure documentation for new feature modules

**Size**: Small
**Priority**: Low
**Dependencies**: Task 3.3
**Can run parallel with**: Task 4.1, Task 4.2

Update `contributing/project-structure.md` to document the 4 new feature modules. Update `AGENTS.md` client section to describe dashboard content sections.

**Acceptance Criteria**:

- [ ] `contributing/project-structure.md` documents all 4 new feature modules
- [ ] `AGENTS.md` client section updated
- [ ] No stale placeholder references remain
