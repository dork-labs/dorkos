---
slug: dashboard-content
number: 147
status: draft
created: 2026-03-20
---

# Dashboard Content — Mission Control for Your Agent Workforce

**Status:** Draft
**Authors:** Claude Code, 2026-03-20
**Spec Number:** 147
**Branch:** preflight/dashboard-content
**Ideation:** `specs/dashboard-content/01-ideation.md`

---

## Overview

Build the dashboard content for DorkOS — a calm, glanceable mission control where a user operating an AI agent workforce understands the state of everything in 3 seconds. The dashboard is the first thing users see at `/`. It answers four questions in priority order: (1) Does anything need my attention? (2) What is active right now? (3) Is the system healthy? (4) What happened while I was away?

This spec replaces the three placeholder components created by the `dynamic-sidebar-content` spec: `DashboardPage`, `DashboardSidebar`, and `DashboardHeader`.

## Background / Problem Statement

The dashboard route exists but renders only a centered placeholder ("DorkOS — Mission control for your agents"). The `dynamic-sidebar-content` spec established the route-aware sidebar/header slot system with `useSidebarSlot()` / `useHeaderSlot()` in AppShell, cross-fade animations, and placeholder components ready to fill. All entity hooks for sessions, Pulse, Relay, Mesh, and agents exist and provide real-time data. The dashboard has all the plumbing — it needs content.

The primary user (Kai) runs 10-20 agent sessions per week across 5 projects. His core scenario: open DorkOS with morning coffee, understand in 3 seconds what his overnight agents accomplished and what needs his attention. The dashboard must serve this workflow — status board, not analytics board.

## Goals

- Replace `DashboardPage` with four content sections: Needs Attention, Active Sessions, System Status, Recent Activity
- Replace `DashboardSidebar` with navigation links + recent agents list
- Augment `DashboardHeader` with system health dot + quick action buttons
- Create 4 new FSD feature modules with clean data hooks and composable UI
- Follow calm technology principles: neutral when healthy, color for exceptions only
- Provide intentional, beautiful empty states for every section
- Support real-time updates via conditional TanStack Query polling

## Non-Goals

- AI-generated briefing summaries (future — requires agent calls)
- New server API endpoints (all data available through existing entity hooks)
- Token usage, cost metrics, or historical trend charts (analytics, not operations)
- Session transcript excerpts (detail belongs in `/session`)
- Configuration forms or adapter setup (link to subsystem panels instead)
- Mesh topology graph (belongs in Mesh panel)
- User-customizable widget grid (opinionated, curated view)
- Infinite scroll on activity feed (cap at 20 items)
- Server-side changes of any kind

## Technical Dependencies

No new packages required. Uses existing:

| Package                  | Version           | Purpose                             |
| ------------------------ | ----------------- | ----------------------------------- |
| `motion/react`           | Already installed | AnimatePresence, stagger animations |
| `@tanstack/react-router` | Already installed | `useNavigate` for navigation        |
| `@tanstack/react-query`  | Already installed | Entity hooks, conditional polling   |
| `lucide-react`           | Already installed | Section icons                       |

## Detailed Design

### 1. Architecture Overview

```
DashboardPage (widgets layer — orchestrator)
├── NeedsAttentionSection (features/dashboard-attention)
│   └── useAttentionItems() → derives from sessions + pulse + relay + mesh
├── ActiveSessionsSection (features/dashboard-sessions)
│   └── useActiveSessions() → derives from useSessions()
├── SystemStatusRow (features/dashboard-status)
│   ├── SubsystemCard (Pulse / Relay / Mesh)
│   │   └── useSubsystemStatus() → derives from subsystem hooks
│   └── ActivitySparkline
│       └── useSessionActivity() → derives from useSessions()
└── RecentActivityFeed (features/dashboard-activity)
    └── useActivityFeed() → aggregates sessions + pulse runs + relay messages
```

All feature modules follow FSD rules: they can import from `entities` and `shared` only. `DashboardPage` (widgets layer) composes the feature-level sections.

### 2. File Structure

```
apps/client/src/layers/
  widgets/
    dashboard/
      ui/
        DashboardPage.tsx          ← replace entirely (orchestrator)
      index.ts                     ← already exports DashboardPage
  features/
    dashboard-attention/
      model/
        use-attention-items.ts     ← derives attention items
      ui/
        NeedsAttentionSection.tsx  ← conditional attention zone
        AttentionItem.tsx          ← single attention row
      index.ts                     ← barrel
    dashboard-sessions/
      model/
        use-active-sessions.ts    ← filters sessions to active states
      ui/
        ActiveSessionsSection.tsx  ← grid of session cards
        ActiveSessionCard.tsx      ← single session card
      index.ts                     ← barrel
    dashboard-status/
      model/
        use-subsystem-status.ts   ← aggregates Pulse/Relay/Mesh health
        use-session-activity.ts   ← 7-day session count data
      ui/
        SystemStatusRow.tsx        ← 4-column card row
        SubsystemCard.tsx          ← single subsystem status card
        ActivitySparkline.tsx      ← inline SVG sparkline
      index.ts                     ← barrel
    dashboard-activity/
      model/
        use-activity-feed.ts      ← time-grouped event aggregation
        use-last-visited.ts       ← localStorage timestamp tracking
      ui/
        RecentActivityFeed.tsx    ← time-grouped feed
        ActivityFeedGroup.tsx     ← single time group (Today / Yesterday / etc.)
        ActivityFeedItem.tsx      ← single event row
      index.ts                     ← barrel
    dashboard-sidebar/
      ui/
        DashboardSidebar.tsx       ← replace entirely
        RecentAgentItem.tsx        ← single agent row in sidebar
      index.ts                     ← update barrel
    top-nav/
      ui/
        DashboardHeader.tsx        ← augment with health dot + actions
```

### 3. Dashboard Main Content — DashboardPage

The page orchestrator composes four sections in a scrollable container with consistent spacing.

```tsx
// widgets/dashboard/ui/DashboardPage.tsx
export function DashboardPage() {
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-4xl space-y-8 px-6 py-8">
        <NeedsAttentionSection />
        <ActiveSessionsSection />
        <SystemStatusRow />
        <RecentActivityFeed />
      </div>
    </ScrollArea>
  );
}
```

**Layout constraints:**

- `max-w-4xl` (896px) centers content with comfortable reading width
- `space-y-8` (32px) between sections for visual breathing room
- `px-6 py-8` padding from container edges
- `ScrollArea` wraps the entire page for scrollable overflow

### 4. Section 1: Needs Attention

**Visibility rule:** Renders **nothing** when empty — zero DOM presence. Its appearance is the signal. Uses `AnimatePresence` to animate in/out.

**Data derivation** (`useAttentionItems()`):

```typescript
interface AttentionItem {
  id: string;
  type: 'tool-approval' | 'stalled-session' | 'failed-run' | 'dead-letter' | 'offline-agent';
  icon: LucideIcon;
  title: string;
  description: string;
  timestamp: string; // ISO — for "Xm ago" display
  action: {
    label: string;
    onClick: () => void; // navigate to session, open Pulse panel, etc.
  };
  severity: 'warning' | 'error';
}
```

Sources:

- **Stalled sessions**: `useSessions()` → filter sessions where `updatedAt` is >30min ago and no recent messages (proxy for `waiting` state — exact streaming state is only available for the current session via Zustand)
- **Failed Pulse runs**: `useRuns({ status: 'failed' })` → runs with `status === 'failed'` from the last 24h
- **Dead Relay letters**: `useAggregatedDeadLetters()` → groups with `count > 0`
- **Offline Mesh agents**: `useMeshStatus()` → `unreachableCount > 0`

Note: Cross-session tool approvals are not currently exposed by the server API (tool approval state is per-session SSE). This is deferred to a future iteration. The attention section will focus on the other four item types for v1.

**UI anatomy:**

```
┌─────────────────────────────────────────────────────────────┐
│  ⚠  NEEDS ATTENTION                                         │
│                                                              │
│  [⏱]  Session "researcher" idle for 47 minutes    47m  [Open →] │
│  [✕]  Pulse: "daily-digest" failed               2h   [View →]  │
│  [✉]  3 undeliverable Relay messages              1h   [View →]  │
└─────────────────────────────────────────────────────────────┘
```

Each `AttentionItem` row:

- Icon (16px, `size-[--size-icon-sm]`)
- Description text (`text-sm text-foreground`)
- Relative timestamp (`text-xs text-muted-foreground tabular-nums`)
- Action button (`variant="ghost"` with `text-xs`)

Section header: `text-xs tracking-widest font-medium uppercase` with amber color (`text-amber-600 dark:text-amber-500`)

**Animation:**

- Section entrance: `height: 0 → 'auto'`, `opacity: 0 → 1`, duration 0.25s, ease `[0, 0, 0.2, 1]`
- Individual items: stagger with `staggerChildren: 0.04`, limit 8

**Polling:** Depends on constituent hooks — Pulse runs at 10s when active, dead letters at 30s, mesh status at 30s. No additional polling needed.

### 5. Section 2: Active Sessions

**Data derivation** (`useActiveSessions()`):

```typescript
interface ActiveSession {
  id: string;
  title: string;
  cwd: string;
  agentName: string;
  agentEmoji: string;
  agentColor: string;
  lastActivity: string; // lastMessagePreview, truncated to 1 line
  elapsedTime: string; // formatted from createdAt
  status: 'active' | 'idle'; // based on updatedAt recency
}
```

Source: `useSessions()` → filter to sessions updated within the last 2 hours (proxy for "active"). Resolve agent identity via `useResolvedAgents()` using the unique `cwd` values from active sessions.

**Limitation:** The server does not track per-session streaming state across sessions. Only the current session's streaming state is known (via Zustand). For other sessions, we use `updatedAt` recency as a heuristic: sessions updated in the last 5 minutes are considered "active", others are "idle".

**UI layout:**

```
ACTIVE NOW                                        [New session →]
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ 🔬 researcher    │  │ 💻 coder         │  │ 🏗️ devops        │
│ Analyzing logs   │  │ idle             │  │ Running tests    │
│ ● 14m            │  │ ○ 23m            │  │ ● 8m             │
│          [Open]  │  │          [Open]  │  │          [Open]  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

**Card anatomy** (`ActiveSessionCard`):

- Agent emoji + name (from `useAgentVisual`)
- Activity line: `lastMessagePreview` truncated to 1 line, or "idle" if no recent activity
- Status dot + elapsed time: `size-2 rounded-full` — `bg-blue-500 animate-pulse` for active, `bg-muted-foreground/30` for idle
- "Open" button: navigates to `/session?session={id}&dir={cwd}`

**Grid:** `grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3`. Max 6 cards visible. If more than 6, show "and N more active →" link that navigates to `/session`.

**Card styling:** `rounded-xl border bg-card p-4 shadow-soft` with `card-interactive` hover effect.

**Empty state:** Centered in section area — "No active sessions" in `text-sm text-muted-foreground` with "New session →" `Button variant="ghost"` that navigates to `/session`.

**Section header:** "ACTIVE NOW" in `text-xs tracking-widest font-medium text-muted-foreground uppercase` with "New session →" action button aligned right.

### 6. Section 3: System Status Row

Four cards in a responsive row. Each follows the PatternFly Aggregate Status Card pattern.

**Data derivation** (`useSubsystemStatus()`):

```typescript
interface SubsystemStatus {
  pulse: {
    enabled: boolean;
    scheduleCount: number;
    nextRunIn: string | null; // formatted relative time
    failedRunCount: number; // from last 24h
  };
  relay: {
    enabled: boolean;
    adapterCount: number;
    connectedNames: string[]; // display names of connected adapters
    deadLetterCount: number;
  };
  mesh: {
    totalAgents: number;
    offlineCount: number; // unreachableCount from MeshStatus
  };
}
```

Sources:

- Pulse: `usePulseEnabled()`, `useSchedules()`, `useRuns({ status: 'failed' })`
- Relay: `useRelayEnabled()`, `useRelayAdapters()`, `useAggregatedDeadLetters()`
- Mesh: `useMeshStatus()`

**Activity sparkline** (`useSessionActivity()`): Derives a 7-day array of session counts from `useSessions()` by bucketing `createdAt` into daily bins. Returns `number[]` of length 7.

**UI layout:**

```
SYSTEM STATUS
┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐
│ Pulse      │  │ Relay      │  │ Mesh       │  │ Activity       │
│ 3 sched.   │  │ 2 adapters │  │ 4 agents   │  │ ▁▃▅▂▇▄▆       │
│ Next: 47m  │  │ Tg · Slack │  │ all online │  │ 23 this week   │
│ ⚠ 1 failed │  │            │  │            │  │                │
└────────────┘  └────────────┘  └────────────┘  └────────────────┘
```

**SubsystemCard anatomy:**

- Title: `text-sm font-medium text-foreground`
- Primary metric: count + label (`text-xs text-muted-foreground`)
- Secondary info: next run time, adapter names, etc. (`text-xs text-muted-foreground`)
- Exception line (conditional): amber/red text, only when count > 0 (`text-xs text-amber-600 dark:text-amber-500` for warnings, `text-xs text-red-600 dark:text-red-500` for errors)
- Click action: opens the subsystem panel dialog (via `setPulseOpen`, `setRelayOpen`, `setMeshOpen` from app store)

**Card styling:** `rounded-xl border bg-card p-4 shadow-soft cursor-pointer` with `card-interactive` hover.

**Grid:** `grid grid-cols-2 gap-3 lg:grid-cols-4`.

**Disabled subsystems:** When `usePulseEnabled()` or `useRelayEnabled()` returns `false`, that card renders in a muted state: title + "Disabled" label in `text-muted-foreground/50`. Still clickable (opens the panel where the user can learn about enabling). The Mesh card always renders (mesh has no server feature gate per ADR-0062).

**ActivitySparkline:** A pure SVG component, no external charting library.

```tsx
interface ActivitySparklineProps {
  data: number[]; // 7 values, one per day
  className?: string;
}
```

Implementation: `<svg viewBox="0 0 100 30">` with `<polyline>` or vertical `<rect>` bars. Uses `stroke="currentColor"` and inherits `text-muted-foreground` for color. Bar heights normalized to max value. Each bar width: ~10px with 4px gap.

### 7. Section 4: Recent Activity Feed

**Data derivation** (`useActivityFeed()`):

```typescript
interface ActivityEvent {
  id: string;
  type: 'session' | 'pulse' | 'relay' | 'mesh' | 'system';
  timestamp: string; // ISO
  title: string; // e.g. "researcher completed (47m)"
  link?: { to: string; params?: Record<string, string> }; // navigation target
}

interface ActivityGroup {
  label: string; // "Today" | "Yesterday" | "Last 7 days"
  events: ActivityEvent[];
}
```

Sources (aggregated client-side):

- **Session events**: `useSessions()` → map each session to a "started" or "completed" event based on `createdAt`/`updatedAt`. Only sessions from the last 7 days.
- **Pulse events**: `useRuns()` → map each run to a "ran successfully" or "failed" event.
- **System events**: On initial load, one synthetic "DorkOS started" event based on server uptime from health check (if available). This is optional and can be deferred.

All events sorted reverse-chronologically, grouped into time buckets, capped at 20 total.

**"Since your last visit" separator** (`useLastVisited()`):

- Reads `localStorage.getItem('dorkos:lastVisitedDashboard')` on mount
- Writes current timestamp on mount (after reading)
- Returns `lastVisitedAt: string | null`
- In the feed, events after `lastVisitedAt` get a subtle left border accent (`border-l-2 border-blue-500/30 pl-3`)
- A separator line appears between "new since last visit" and older events: "Since your last visit · 2 days ago" in `text-xs text-muted-foreground`

**UI layout:**

```
RECENT ACTIVITY                                       [View all →]

Today
  2:14 PM   ● Session   researcher completed (47m)        [Open]
  9:02 AM   ● Pulse     daily-digest ran successfully

  ─── Since your last visit · 8 hours ago ───

Yesterday
  11:30 PM  ● Session   coder completed (1h 12m)          [Open]
  3:00 AM   ● Pulse     weekly-report failed               [View]
```

**ActivityFeedItem anatomy:**

- Timestamp: `text-xs tabular-nums text-muted-foreground w-16 shrink-0` — format `h:mm a` for today, `MMM d` for older
- Type badge: `size-2 rounded-full` with type-specific color:
  - Session: `bg-blue-500`
  - Pulse: `bg-purple-500`
  - Relay: `bg-teal-500`
  - Mesh: `bg-muted-foreground/40`
  - System: `bg-muted-foreground/30`
- Type label: `text-xs text-muted-foreground w-14 shrink-0` — "Session", "Pulse", etc.
- Description: `text-sm text-foreground/80 flex-1 truncate`
- Optional action: ghost button "Open" or "View"

**ActivityFeedGroup:** Group label ("Today", "Yesterday", "Last 7 days") as `text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 mt-4`.

**Empty state:** "No activity yet. Your agent history will appear here." centered in `text-sm text-muted-foreground`.

**Cap:** 20 items max. If more exist, show "View all →" in section header (links to full session list via `/session`).

**Animation:** Items enter with stagger — `staggerChildren: 0.03`, fade + slight y-offset (`y: 8 → 0, opacity: 0 → 1`), duration 0.2s.

### 8. Dashboard Sidebar

Replace the placeholder with navigation + recent agents.

```tsx
// features/dashboard-sidebar/ui/DashboardSidebar.tsx
export function DashboardSidebar() {
  const navigate = useNavigate();
  const recentCwds = useAppStore((s) => s.recentCwds);
  const paths = recentCwds.map((r) => r.path);
  const { data: agents } = useResolvedAgents(paths);

  return (
    <>
      <SidebarHeader className="border-b p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive className="...">
              <LayoutDashboard className="size-(--size-icon-sm)" />
              Dashboard
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => navigate({ to: '/session' })} className="...">
              <MessageSquare className="size-(--size-icon-sm)" />
              Sessions
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="p-3">
        {recentCwds.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase">
              Recent Agents
            </SidebarGroupLabel>
            <SidebarMenu>
              {recentCwds.slice(0, 8).map((recent) => (
                <RecentAgentItem
                  key={recent.path}
                  path={recent.path}
                  agent={agents?.[recent.path] ?? null}
                  onClick={() => navigate({ to: '/session', search: { dir: recent.path } })}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>
    </>
  );
}
```

**RecentAgentItem:** Shows agent color dot (from `useAgentVisual`), emoji, and name. Falls back to the last path segment if no agent manifest is found. Uses `SidebarMenuButton` for consistent styling.

**Limit:** Show at most 8 recent agents (matches stagger animation limit).

### 9. Dashboard Header

Augment the placeholder with system health dot and quick actions.

```tsx
// features/top-nav/ui/DashboardHeader.tsx
export function DashboardHeader() {
  const navigate = useNavigate();
  const healthState = useSystemHealth();
  const pulseEnabled = usePulseEnabled();
  const setPulseOpen = useAppStore((s) => s.setPulseOpen);

  return (
    <>
      <span className="text-muted-foreground text-sm font-medium">Dashboard</span>
      <SystemHealthDot state={healthState} />
      <div className="flex-1" />
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() => navigate({ to: '/session' })}
        >
          <Plus className="size-3" />
          New session
        </Button>
        {pulseEnabled && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => setPulseOpen(true)}
          >
            <Clock className="size-3" />
            Schedule
          </Button>
        )}
      </div>
      <CommandPaletteTrigger />
    </>
  );
}
```

**`useSystemHealth()`**: A simple derived hook that returns `'healthy' | 'degraded' | 'error'`:

- `error`: any failed Pulse runs in last 24h OR any dead letters OR any unreachable mesh agents
- `degraded`: any adapters disconnected
- `healthy`: everything else

This hook lives in `features/top-nav/model/use-system-health.ts` and pulls from entity hooks.

**`SystemHealthDot`**: A `size-2 rounded-full` dot:

- `healthy`: `bg-muted-foreground/30` (neutral — calm tech)
- `degraded`: `bg-amber-500`
- `error`: `bg-red-500`

With tooltip showing a plain-language message: "All systems operational" / "1 adapter disconnected" / "1 Pulse run failed".

### 10. Color Semantics

Following the user's decision (calm tech — neutral for healthy):

| State                           | Dot Color                   | Text Color                           |
| ------------------------------- | --------------------------- | ------------------------------------ |
| Healthy / active (running)      | `bg-blue-500 animate-pulse` | —                                    |
| Healthy / idle                  | `bg-muted-foreground/30`    | —                                    |
| Healthy (system)                | `bg-muted-foreground/30`    | `text-muted-foreground`              |
| Warning (stalled, disconnected) | `bg-amber-500`              | `text-amber-600 dark:text-amber-500` |
| Error (failed, unreachable)     | `bg-red-500`                | `text-red-600 dark:text-red-500`     |
| Session completed               | `bg-green-500`              | —                                    |

Note: `bg-green-500` is only used for the activity feed's "session completed" event badge — a historical fact, not a persistent state. The system status cards never show green for "healthy" — they show neutral gray.

### 11. Animation Specification

All animations use module-scope variants (not inline), following `contributing/animations.md`:

```typescript
// Shared across dashboard features
const sectionEntrance = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, ease: 'easeOut' },
} as const;

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.04 } },
} as const;

const staggerItem = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
} as const;

// For Needs Attention section show/hide
const conditionalSection = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.25, ease: [0, 0, 0.2, 1] },
} as const;
```

- `MotionConfig reducedMotion="user"` already wraps the app — no per-component work needed.
- Stagger limited to first 8 items per section.
- Needs Attention section uses `AnimatePresence initial={false}` so it doesn't animate on initial page load when empty.

### 12. Polling Strategy

| Data Source      | Hook                         | Poll Interval           | Condition                   |
| ---------------- | ---------------------------- | ----------------------- | --------------------------- |
| Sessions         | `useSessions()`              | Existing (configurable) | When `selectedCwd !== null` |
| Pulse schedules  | `useSchedules()`             | On demand               | When Pulse enabled          |
| Pulse runs       | `useRuns()`                  | 10s                     | When any run is `running`   |
| Relay adapters   | `useRelayAdapters()`         | 10s                     | When Relay enabled          |
| Dead letters     | `useAggregatedDeadLetters()` | 30s                     | When Relay enabled          |
| Mesh status      | `useMeshStatus()`            | 30s                     | Always                      |
| Agent resolution | `useResolvedAgents()`        | 60s stale               | When paths > 0              |

No additional polling is introduced. The dashboard reuses existing TanStack Query caches — if the user navigates to `/session` and back, data is already warm.

### 13. Empty State Design

Each section has an intentional empty state:

| Section         | Empty State                                                                        | CTA                                     |
| --------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| Needs Attention | Renders nothing — absence is the signal                                            | —                                       |
| Active Sessions | "No active sessions. Start a new session to get an agent working."                 | "New session →" navigates to `/session` |
| System Status   | Individual cards show "Disabled" for off subsystems; Activity shows flat sparkline | Card click opens subsystem panel        |
| Recent Activity | "No activity yet. Your agent history will appear here."                            | None — just wait                        |

**First-visit "zero state"**: When the entire dashboard is empty (no sessions, no schedules, no adapters), the page shows:

- Needs Attention: hidden
- Active Sessions: empty state with CTA
- System Status: shows all disabled cards with neutral styling
- Recent Activity: empty state

This feels calm and ready, not broken. The empty states collectively communicate "the system is ready for you to use" without a wizard or forced flow.

## User Experience

### Morning Workflow (Kai's Primary Scenario)

1. Kai opens DorkOS at 7am
2. **3-second scan:** Needs Attention shows "Pulse: daily-digest failed 5h ago" — he clicks "View →" to see the error
3. Active Sessions shows 2 cards: `researcher` is active (started at 2am, still running), `coder` is idle (completed at 4am)
4. System Status shows Pulse (3 schedules, 1 failed), Relay (2 adapters connected), Mesh (4 agents online), Activity sparkline shows a spike overnight
5. Recent Activity shows 8 events since his last visit, separated by the "Since your last visit" marker
6. He clicks "Open" on the `researcher` session card to check progress

### Mid-Work Check-In

1. After a 2-hour chat session, Kai clicks "Dashboard" in the session sidebar header
2. Sidebar cross-fades (100ms) to dashboard view with his recent agents
3. Main content shows current state — no Needs Attention items (good), his current session appears in Active Sessions
4. He glances at System Status, confirms all is well, clicks "Sessions" to go back

### Navigation Flow

- Dashboard → click session card → `/session?session={id}&dir={cwd}`
- Dashboard → click "New session" → `/session`
- Dashboard → click subsystem card → Opens dialog (Pulse/Relay/Mesh panel)
- Dashboard → click sidebar agent → `/session?dir={path}`
- Dashboard → click "Sessions" in sidebar → `/session`

## Testing Strategy

### Unit Tests — Feature Hooks

**`useAttentionItems.test.ts`**

- Returns empty array when no issues exist
- Returns failed Pulse runs from last 24h with correct severity
- Returns dead letter groups with count > 0
- Returns offline mesh agents when unreachableCount > 0
- Excludes stale sessions less than 30 minutes old
- Sorts items by timestamp (most recent first)

**`useActiveSessions.test.ts`**

- Returns empty array when no sessions exist
- Filters to sessions updated within 2 hours
- Resolves agent identity for each unique cwd
- Caps at 6 sessions
- Marks sessions updated in last 5 minutes as "active", others as "idle"

**`useSubsystemStatus.test.ts`**

- Returns correct schedule count and next run time from Pulse
- Returns adapter names and dead letter count from Relay
- Returns agent count and offline count from Mesh
- Returns disabled state when subsystem feature flag is off

**`useActivityFeed.test.ts`**

- Groups events into Today / Yesterday / Last 7 days
- Sorts events reverse-chronologically within groups
- Caps at 20 total events
- Includes session events from last 7 days
- Includes Pulse run events
- Handles empty state (no events)

**`useLastVisited.test.ts`**

- Reads from localStorage on mount
- Writes current timestamp on mount
- Returns null on first visit

### Unit Tests — UI Components

**`NeedsAttentionSection.test.tsx`**

- Renders nothing when items array is empty (verify zero DOM nodes)
- Renders correct number of items when non-empty
- Each item shows icon, description, timestamp, and action button
- Action button triggers onClick handler

**`ActiveSessionCard.test.tsx`**

- Renders agent emoji, name, activity line, status dot, and elapsed time
- "Open" button navigates to correct session URL
- Truncates long activity lines to single line

**`SubsystemCard.test.tsx`**

- Renders title and primary metric
- Shows exception count only when > 0
- Shows "Disabled" state when subsystem is off
- Click opens corresponding dialog

**`ActivitySparkline.test.tsx`**

- Renders SVG with 7 bars
- Handles all-zero data (flat line)
- Normalizes bar heights to max value

**`RecentAgentItem.test.tsx`**

- Renders agent color dot, emoji, and name
- Falls back to path basename when no agent manifest
- Click navigates to session with correct dir param

### Mock Strategy

All tests use `createMockTransport()` from `@dorkos/test-utils` via `TransportProvider`. Entity hooks return data through the transport mock. Zustand state is set directly via `useAppStore.setState()`.

Component tests use `vi.mock()` to mock entity hooks at the module level, providing controlled return values per test case.

## Performance Considerations

- **No new API calls**: All data comes from existing TanStack Query caches. Opening the dashboard after visiting `/session` is instant.
- **Conditional rendering**: Needs Attention section has zero DOM cost when empty.
- **Stagger limit**: Animation stagger limited to 8 items per section to prevent jank.
- **Session activity sparkline**: Computed via `useMemo` from the sessions list — no additional API call.
- **Agent resolution**: `useResolvedAgents()` batches all paths into a single API call with 60s stale time.
- **Polling reuse**: No additional polling intervals introduced — dashboard reuses existing entity hook intervals.
- **Layout stability**: Card heights are stable. Exception counts appear inline (don't shift card height). Skeleton loaders only for initial load, not subsequent updates.

## Security Considerations

- No new attack surface — all changes are client-side component composition
- No new data flows — dashboard reads existing entity hooks
- No sensitive data displayed — session previews are already truncated by the server
- localStorage for `lastVisitedDashboard` stores only a timestamp, no PII

## Documentation

- Update `contributing/project-structure.md` to document the 4 new feature modules
- Update `CLAUDE.md` client section to mention dashboard content sections

## Implementation Phases

### Phase 1: Infrastructure + System Status

1. Create `features/dashboard-status/` module: `useSubsystemStatus()`, `SubsystemCard`, `ActivitySparkline`, `SystemStatusRow`
2. Create `features/dashboard-sessions/` module: `useActiveSessions()`, `ActiveSessionCard`, `ActiveSessionsSection`
3. Replace `DashboardPage` with `ScrollArea` + `SystemStatusRow` + `ActiveSessionsSection`
4. Empty states for both sections

### Phase 2: Needs Attention + Header

5. Create `features/dashboard-attention/` module: `useAttentionItems()`, `AttentionItem`, `NeedsAttentionSection`
6. Wire `NeedsAttentionSection` into `DashboardPage` (above Active Sessions)
7. Augment `DashboardHeader` with `useSystemHealth()`, health dot, quick action buttons

### Phase 3: Activity Feed + Sidebar

8. Create `features/dashboard-activity/` module: `useActivityFeed()`, `useLastVisited()`, `ActivityFeedItem`, `ActivityFeedGroup`, `RecentActivityFeed`
9. Wire `RecentActivityFeed` into `DashboardPage` (bottom section)
10. Replace `DashboardSidebar` with navigation + `RecentAgentItem` list

### Phase 4: Polish + Tests

11. Add entrance animations to all sections (stagger, fade+slide)
12. Add all unit tests for hooks and components
13. Update documentation (`contributing/project-structure.md`, `CLAUDE.md`)
14. Verify light/dark mode, reduced motion, disabled subsystem states

## Open Questions

None — all decisions resolved during ideation (see Section 6 of `01-ideation.md`).

## Related ADRs

- ADR-0161: Route-Aware Sidebar & Header Slot Pattern — foundation this builds on
- ADR-0157: Pathless Layout Route for App Shell — routing infrastructure
- ADR-0154: Adopt TanStack Router for Client Routing — navigation
- ADR-0002: Adopt Feature-Sliced Design — layer rules for new feature modules
- ADR-0062 (referenced): Mesh has no server feature gate — mesh card always renders

## References

- `specs/dashboard-content/01-ideation.md` — Full ideation with research and decisions
- `specs/dashboard-content/00-brainstorm.md` — Wide brainstorm
- `specs/dynamic-sidebar-content/02-specification.md` — Infrastructure spec (implemented)
- `specs/dashboard-home-route/01-ideation.md` — Signal hierarchy (Tier 1/2/3)
- `research/20260320_dashboard_content_design_patterns.md` — Comprehensive design research
- `contributing/design-system.md` — Calm Tech design language
- `contributing/animations.md` — Motion library patterns
- `contributing/data-fetching.md` — TanStack Query patterns
