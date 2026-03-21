---
title: 'DorkOS Dashboard Content — Design Patterns & Recommendations'
date: 2026-03-20
type: external-best-practices
status: active
tags:
  [
    dashboard,
    mission-control,
    agent-status,
    activity-feed,
    status-cards,
    sparklines,
    empty-states,
    information-hierarchy,
    calm-technology,
    shadcn,
    tailwind,
  ]
feature_slug: dashboard-content
searches_performed: 12
sources_count: 38
---

# DorkOS Dashboard Content — Design Patterns & Recommendations

## Research Summary

This report synthesizes research from prior DorkOS design work, industry-leading developer tool dashboards, agent orchestration UIs, and foundational UX literature to produce concrete, actionable design direction for the DorkOS dashboard. The core finding is that the best developer dashboards are **state boards, not analytics boards** — they show what is happening and what needs attention, not what happened over time. For DorkOS, the dashboard should function as a calm, glanceable mission control that escalates from ambient awareness to urgent action only when the user's intervention is required. The report covers layout structure, card taxonomy, activity feed patterns, empty states, and anti-patterns to avoid.

Note: A significant prior report (`research/20260320_dashboard_route_navigation_architecture.md`) already covers the high-level dashboard philosophy, route naming, and content priority framework. This report builds on that foundation with greater specificity on visual design, card patterns, activity feeds, sparklines, and implementation guidance.

---

## Key Findings

### 1. The Best Developer Dashboards Are Status Boards, Not Analytics Boards

The strongest developer tool dashboards — Vercel, Linear, Railway, GitHub — share a single mental model: **"here is the state of your system right now — act on anything that needs your attention."** This is fundamentally different from analytics dashboards (which answer "how have things been over time") and monitoring dashboards (Grafana-style time series).

Vercel's dashboard redesign explicitly prioritized: production deployment status, latest preview deployments, git metadata (what triggered the change), and logs. They stated they aimed "to make the most crucial project elements easily accessible." Charts, historical trends, and usage metrics were deliberately excluded from the primary view. The dashboard favors **screenshots and status indicators** over graphs.

GitHub's post-2023 dashboard redesign similarly removed discovery content (trending repos, stars) in favor of "your work" and "what changed in your work." The signal-to-noise improvement came from subtraction, not addition.

**The actionable principle for DorkOS:** Show state and exceptions. Surface the four subsystems (Sessions, Pulse, Relay, Mesh) as status, not as data. Link to detail views rather than embedding them.

### 2. Calm Technology Principles Apply Directly

Mark Weiser and John Seely Brown's "calm technology" framework from Xerox PARC provides the design language for the DorkOS dashboard. Calm tech distinguishes between the **center of attention** (where focus is actively directed) and the **periphery** (ambient awareness that doesn't demand attention).

For DorkOS:

| Information Type                        | Calm Tech Category | Dashboard Behavior                    |
| --------------------------------------- | ------------------ | ------------------------------------- |
| All agents healthy, sessions running    | Periphery          | Small status indicators, muted colors |
| Active session in progress              | Periphery          | Visible but non-intrusive card        |
| Agent waiting for input >30 min         | Center → Periphery | Yellow/amber state change             |
| Pending tool approval blocking progress | Center             | Elevated to "Needs Attention"         |
| Failed Pulse run                        | Center             | Elevated to "Needs Attention"         |
| Dead letters in Relay                   | Center             | Elevated to "Needs Attention"         |

A well-designed DorkOS dashboard should feel **calm when everything is fine** and pull the user's attention when intervention is needed — not shout at them all the time.

### 3. Card Taxonomy: Five Distinct Card Types

The PatternFly design system (IBM's enterprise design language, extensively battle-tested) defines five card types for dashboards. All five map cleanly to DorkOS's data:

| PatternFly Card Type                  | DorkOS Application                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Aggregate Status**                  | Subsystem health roll-ups (Mesh: 4 agents · 1 offline, Relay: 2 adapters · all connected) |
| **Trend Card**                        | Session activity sparkline over the last 7 days                                           |
| **Events Card**                       | Recent activity feed (what happened while you were away)                                  |
| **Details Card**                      | Single active session card (agent name, task, elapsed time)                               |
| **Aggregate Status (Exception-only)** | "Needs Attention" section — only appears when non-empty                                   |

The PatternFly principle: **"Each card should be designed to display a single metric, a group of closely related metrics, or a summary of important information."** Multi-concern cards cause confusion about what to act on.

### 4. The "Needs Attention" Pattern Is the Most Critical Element

GitHub Copilot's Mission Control, Vercel's deployment dashboard, and Linear's Inbox all use a variant of the same pattern: a top-of-page zone that is **hidden when empty, visible when urgent**. This is the highest-signal element on the page.

For DorkOS, the "Needs Attention" zone surfaces:

1. Tool approval requests blocking agent progress (from any active session)
2. Sessions in `waiting` state for >30 minutes (agent stalled, needs human input)
3. Failed Pulse runs (last execution failed)
4. Dead letters in Relay (undeliverable messages)
5. Agents registered in Mesh that are marked offline/unreachable

**Critical implementation detail:** The section **must not render at all when empty** — not even as a collapsed section. Its presence is the signal. When it disappears, the user knows all is well.

### 5. Activity Feed: "What Happened While You Were Away"

The activity feed pattern solves the use case of a user opening DorkOS over their morning coffee: they want to know what happened since they were last active without reading full session transcripts.

Best-in-class patterns from developer tools:

- **Compact event rows**: timestamp | type badge | summary text. Each row is a single line. No paragraphs in feeds.
- **Grouping by time period**: "Today" / "Yesterday" / "Last 7 days" — separating time buckets avoids the cognitive work of parsing timestamps.
- **Aggregation over repetition**: Rather than "agent ran bash command" × 47, show "agent ran 47 commands in 3 minutes." GitHub Copilot's Mission Control surfaces this as aggregate counts.
- **Reverse chronological**: Most recent at top. Always.
- **Event type differentiation**: Color-coded badges (session completed = green, failure = red, tool approval = amber, Pulse run = blue) let users filter by scanning, not reading.

The activity feed is **distinct from the active sessions view**. Active sessions show current state; the activity feed shows historical events.

### 6. Sparklines for Vital Signs — Use Sparingly

Sparklines (mini inline line charts) communicate trend direction without the cognitive overhead of a full chart. They are appropriate for exactly one question: "is this trending better or worse?"

**When to use sparklines in DorkOS:**

- Session volume over the last 7 days (showing whether the user is using the system more or less)
- Potentially: Pulse run success rate trend

**When NOT to use sparklines:**

- Token counts (irrelevant to operations)
- Message volume in Relay (operational noise)
- Per-session statistics (too granular for dashboard)

PatternFly's guidance: "Trend cards display a trend of one or more metrics. The most common use case is in a dashboard." Critically, they are paired with a **current value** — the sparkline provides context, the number provides the answer.

For DorkOS, a single "System Activity" trend card (showing session count over 7 days) is appropriate. More than one or two sparklines turns the dashboard into an analytics view.

### 7. Subsystem Status Roll-Up Cards (Aggregate Status Pattern)

The PatternFly Aggregate Status Card pattern is the right model for DorkOS's four subsystem status indicators:

```
┌────────────────────┐
│  Pulse             │
│  3 schedules       │
│  ⚠ 1 failed       │   ← exception-only count, shown when non-zero
└────────────────────┘
```

Rules for aggregate status cards:

- Show the total count
- Show exception counts **only when non-zero** (zero exceptions = silence = healthy)
- Use semantic colors only for exceptions: amber for warnings, red for failures
- Neutral gray for healthy state (not green — green triggers positive attention you haven't earned)
- Link to the subsystem panel for detail

The Geist design system (Vercel's) uses a similar principle: healthy = neutral, degraded = amber, outage = red. Green is reserved for "just completed" transitions, not persistent "all good" state.

### 8. Empty States Must Feel Intentional

NNGroup research confirms that blank spaces without guidance cause user confusion and erode confidence — users interpret emptiness as "something is broken," not "the system is ready." This applies to every section of the DorkOS dashboard.

For DorkOS, the most likely first-visit state is: no sessions, no agents, no schedules. The dashboard must handle this gracefully.

**Recommendations per section:**

- **No active sessions**: Show an action card ("Start your first session →") with a short description of what a session is. Not a spinner, not an empty area.
- **No agents in Mesh**: Show a chip/pill "Discover agents" linking to the Mesh panel.
- **No Pulse schedules**: Show "No scheduled runs" with a "Create schedule →" link.
- **No recent activity**: "No activity yet. Your agent history will appear here." — centered, icon, muted.

The principle from the prior Mesh Panel research applies universally: **treat empty states as onboarding moments, not error conditions**. The user is not broken; they are new.

### 9. GitHub Copilot Mission Control — Specific Patterns Worth Adopting

GitHub Copilot's Mission Control (released October 2025) is the closest existing product to what DorkOS's dashboard needs to be. Key patterns worth adopting:

1. **Unified task list with status-at-a-glance**: Each running agent task gets one row with status badge, task title, and elapsed time. No full transcript inline.
2. **Real-time steering affordance**: "Pause / Refine / Restart" actions on running tasks. For DorkOS: "Open Session" button on active session cards.
3. **PR/output surfacing inline**: Completed tasks show their output artifact (for DorkOS: a link to the session with a summary of what was accomplished).
4. **Centralized approval queue**: All tool approval requests across sessions surfaced in one place — not buried in individual session views.

What Mission Control does that DorkOS should **not** copy:

- Continuous log monitoring as the primary interface. DorkOS users want ambient awareness, not a log tail.
- 32-panel sprawl (builderz-labs Mission Control). Too much. Follow Dieter Rams: "Less, but better."

### 10. Anti-Patterns to Avoid

These are confirmed anti-patterns from research, industry observation, and the prior dashboard architecture report:

1. **Charts on the main view**: Token usage, message volume, historical trends — these are analytics, not operations. They require interpretation and do not drive action.
2. **Full session transcripts inline**: Detail belongs in `/session`. Dashboard shows count and state.
3. **Configuration forms embedded**: Adapter setup, agent configuration, cron expression editors belong in their subsystem panels.
4. **Green = healthy**: Persistent green status indicators are visual noise. Use neutral gray for healthy. Reserve color for exception.
5. **"Show all" unguarded**: Always cap result sets. Even "Recent activity" should default to last 24 hours, with "View all →" link.
6. **Auto-redirect away from the dashboard**: Do not redirect first-time visitors to `/session`. The dashboard is home.
7. **User-customizable widget grid**: Out of scope. DorkOS presents an opinionated, curated view. Drag-and-drop dashboards are for consumer BI tools.
8. **Polling the API on every render**: Use conditional polling — poll active data only when sessions are running. Stop when idle.

---

## Detailed Analysis

### Layout Structure Recommendation

The dashboard follows a Z-pattern reading layout: **top-left gets maximum attention**, then right, then lower sections. Apply this to content priority:

```
┌──────────────────────────────────────────────────────────────────┐
│  HEADER: Identity + Command Palette shortcut          [Kai's env] │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ⚠ NEEDS ATTENTION  (renders only when non-empty)               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Tool approval pending — "researcher" wants to run bash   │   │
│  │ Pulse: last run of "daily-digest" failed 2h ago    [→]  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ACTIVE NOW                                    [Start session →] │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │ researcher       │  │ coder            │                     │
│  │ Analyzing logs   │  │ Waiting for you  │                     │
│  │ 14m · running    │  │ 23m · waiting    │  [Open]  [Open]     │
│  └──────────────────┘  └──────────────────┘                     │
│                                                                  │
│  SYSTEM STATUS                                                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐ │
│  │ Pulse      │  │ Relay      │  │ Mesh       │  │ Activity  │ │
│  │ 3 sched    │  │ 2 adapters │  │ 4 agents   │  │ ╱╲  ╱╲╱  │ │
│  │ Next: 47m  │  │ all live   │  │ all online │  │ 7d trend  │ │
│  └────────────┘  └────────────┘  └────────────┘  └───────────┘ │
│                                                                  │
│  RECENT ACTIVITY                                    [View all →] │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Today                                                    │   │
│  │  2:14 PM  ● Session  researcher completed (47m)  [Open] │   │
│  │  9:02 AM  ● Pulse    daily-digest ran successfully       │   │
│  │                                                          │   │
│  │ Yesterday                                                │   │
│  │  11:30 PM ● Session  coder completed (1h 12m)   [Open]  │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

**Column count**: 4-column grid for system status cards (Pulse, Relay, Mesh, Activity). 2-column grid for active session cards. Full-width for Needs Attention and Recent Activity.

**Cognitive load discipline**: Maximum 6-8 active session cards. Overflow with "and N more active →" link. Following Miller's Law (7±2 working memory slots), showing more than 8 active items requires prioritization rather than showing all.

---

### The "Needs Attention" Section

This is the highest-priority engineering and design element. It must:

1. **Render conditionally**: Zero height, zero DOM presence when empty. Not collapsed — absent.
2. **Support multiple item types**: Tool approvals, stalled sessions, failed Pulse runs, dead Relay letters, offline Mesh agents.
3. **Be actionable inline or via one click**: Tool approvals need an Approve/Deny button directly in the card. All others link to the relevant panel.
4. **Auto-dismiss when resolved**: When a tool approval is resolved or a Pulse run is re-run successfully, the item removes itself from the section.
5. **Never show stale items**: Items that were "needs attention" 3 hours ago but are now resolved should not reappear.

**Item row anatomy**:

```
[icon]  [description of what needs attention]  [time since event]  [primary action button]
```

Examples:

- `[⚙] Tool approval: "researcher" wants to run: rm -rf ./build/cache  · 4m ago  [Review →]`
- `[⏱] Session "coder" has been waiting for input for 47 minutes  · 47m ago  [Open →]`
- `[✕] Pulse: "daily-digest" failed with exit code 1  · 2h ago  [View logs →]`

---

### Active Session Cards

Each running or waiting session gets a card. The card contains exactly:

1. **Agent identifier**: Name or custom label (from the session's agent config)
2. **Current activity summary**: The most recent tool_use or text block, truncated to one line
3. **Status indicator**: dot + label (running / waiting / streaming)
4. **Elapsed time**: Time since session started (not time since last message)
5. **Primary action**: "Open" button that navigates to `/session?session=id&dir=path`

What the card does NOT show:

- Token count (operational noise)
- Full transcript excerpt (too much)
- Working directory (show on hover as tooltip)
- Cost estimate (analytics, not operations)

**Status semantics**:

- `running` — agent is actively streaming or processing (animated dot, neutral blue)
- `streaming` — live token stream active (animated dot, blue)
- `waiting` — agent sent a message and is waiting for human response (amber dot, static)
- `stalled` — waiting for >30 minutes (red dot + entry in "Needs Attention")

---

### Subsystem Status Cards (System Status Row)

Four cards in a row. Each card follows the Aggregate Status pattern:

**Pulse Card**:

```
Pulse
3 schedules · Next in 47m
⚠ 1 failed last run        ← shown only when non-zero
[→ Pulse]
```

**Relay Card**:

```
Relay
2 adapters connected
Telegram · Slack           ← names of connected adapters
[→ Relay]
```

**Mesh Card**:

```
Mesh
4 agents registered
⚠ 1 offline                ← shown only when non-zero
[→ Mesh]
```

**Activity Card** (the 7-day sparkline):

```
Activity
┌─────────────────┐
│ ╱╲  ╱╲ ╱╲╱╲    │  ← SVG sparkline
└─────────────────┘
23 sessions this week
[→ History]
```

**Color semantics**:

- Default state: neutral (no color — intentionally calm)
- Exception state: amber text for warnings, red text for failures
- Never use persistent green for "all healthy" — healthy = neutral

---

### Recent Activity Feed

The activity feed is a time-grouped, reverse-chronological list of system events. It is the "morning briefing" view.

**Time grouping**:

```
Today
Yesterday
Last 7 days        ← collapses older items
```

**Event row format** (compact, single line):

```
[HH:MM]  [● type badge]  [event description]  [link]
```

**Event types and badges**:
| Type | Color | Examples |
|---|---|---|
| Session | Blue | "researcher completed (47m)" / "coder started" |
| Pulse | Purple | "daily-digest ran successfully" / "weekly-report failed" |
| Relay | Teal | "Telegram: 3 messages received" |
| Mesh | Gray | "4 agents discovered in ~/projects" |
| System | Neutral | "DorkOS started" / "Config reloaded" |

**Aggregation rules**:

- Multiple tool calls within a session are not surfaced individually — they are already captured in the session history.
- Only session-level events (started, completed, failed, waiting) appear in the feed.
- Pulse: one row per run (success or failure).
- Relay: aggregate by time window ("Telegram: 3 messages received in the last hour").

**"What happened while you were away" detection**:

- Track the last-visited timestamp in localStorage.
- On dashboard load, show a subtle "Since your last visit (2 days ago)" separator in the feed above events that occurred after that timestamp.
- Events after the separator are visually distinguished (slightly bolder, or a thin left border accent).

**Feed cap**: Show 20 items by default. "View all →" link to a full history page (future feature). Never infinite scroll on the dashboard — it turns a status board into a log viewer.

---

### Empty State Design

Each dashboard section has a distinct empty state. The guiding principle (from NNGroup): **explain why it's empty and provide exactly one action to fix it**.

| Section                      | Empty State Copy                                                   | CTA                    |
| ---------------------------- | ------------------------------------------------------------------ | ---------------------- |
| Needs Attention (empty)      | _(renders nothing — the absence is the signal)_                    | —                      |
| Active Now (no sessions)     | "No active sessions. Start a new session to put an agent to work." | "New session →"        |
| Pulse (no schedules)         | "No schedules configured."                                         | "Create schedule →"    |
| Relay (no adapters)          | "No adapters connected."                                           | "Add adapter →"        |
| Mesh (no agents)             | "No agents registered. Discover agents in your projects."          | "Discover →"           |
| Recent Activity (no history) | "No activity yet. Your agent history will appear here."            | _(no CTA — just wait)_ |

**First-visit "zero state" (everything empty)**:
This is the most important empty state. When Kai opens DorkOS for the first time, the entire dashboard is empty. The dashboard should show a calm, confident welcome state — not a barren grid. Consider a centered "Get started" prompt that surfaces the three most important first actions in priority order:

1. Start a session (→ `/session`)
2. Create a Pulse schedule (→ Pulse panel)
3. Connect a Relay adapter (→ Relay panel)

This is not a wizard or a tutorial — it is three clearly labeled links. No modals, no forced flows.

---

### Real-Time Update Strategy

The dashboard must handle live data without overwhelming the user or causing jarring layout shifts.

**Polling strategy by section**:
| Section | Strategy | Interval |
|---|---|---|
| Needs Attention | TanStack Query + SSE fallback | Reactive to SSE events; poll 10s when active sessions exist |
| Active Now sessions | Conditional polling | 5s when sessions active, 30s when idle, false when no sessions |
| System Status (Pulse/Relay/Mesh) | Polling | 30s unconditionally |
| Recent Activity | On-demand (not auto-polling) | Refresh on return to tab |

**TanStack Query v5 pattern** (from prior research):

```typescript
refetchInterval: (query) => {
  const hasActiveSessions = query.state.data?.some(
    (s) => s.status === 'running' || s.status === 'streaming'
  );
  return hasActiveSessions ? 5000 : 30000;
},
```

**SSE integration for tool approvals**: Tool approval events are the most time-sensitive. The "Needs Attention" section should subscribe to a persistent SSE connection (`GET /api/sessions/stream` or similar) that emits when a new tool approval is pending. Polling alone is insufficient for this — a 5-second polling delay on a tool approval is bad UX.

**Layout stability during updates**: Use skeleton loaders only for the initial empty state (`isLoading && !data`). For subsequent updates, update data in-place without skeleton transitions. Card heights should be stable — avoid layout shifts when content updates.

---

### Typography and Visual Design

The DorkOS dashboard should feel like a control panel, not a consumer app. Typography is the primary design element.

**Type scale usage**:

- Section headers ("ACTIVE NOW", "SYSTEM STATUS"): `text-xs tracking-widest font-medium text-muted-foreground uppercase` — labels, not headings
- Card primary values: `text-2xl font-semibold tabular-nums` (for counts)
- Card secondary context: `text-sm text-muted-foreground`
- Activity feed timestamps: `text-xs tabular-nums text-muted-foreground w-16 shrink-0`
- Activity feed descriptions: `text-sm text-foreground/80`

**Motion**: Use the existing `motion` library for entrance animations on the "Needs Attention" section (items animate in when they appear) and session card transitions. Do not animate status dot colors — instant color changes are more legible than fades.

**Color semantics for status dots**:

```typescript
const statusDotClasses = {
  running: 'bg-blue-500 animate-pulse',
  streaming: 'bg-blue-500 animate-pulse',
  waiting: 'bg-amber-500', // static dot, attention-drawing but not alarming
  stalled: 'bg-red-500', // static, promoted to Needs Attention
  completed: 'bg-green-500', // brief flash, then fades to neutral
  failed: 'bg-red-500', // static, promoted to Needs Attention
};
```

---

### FSD Layer Placement

Following DorkOS's Feature-Sliced Design architecture:

```
apps/client/src/layers/
  widgets/
    dashboard/
      index.ts                        ← barrel export
      DashboardPage.tsx               ← page orchestrator, imports feature widgets
      ui/
        NeedsAttentionSection.tsx     ← conditional attention zone
        ActiveSessionsSection.tsx     ← grid of session cards
        SystemStatusRow.tsx           ← 4-column subsystem cards
        RecentActivityFeed.tsx        ← time-grouped event list
  features/
    dashboard-attention/
      model/
        use-attention-items.ts        ← derives attention items from sessions/pulse/relay/mesh
      ui/
        AttentionItem.tsx
    dashboard-sessions/
      model/
        use-active-sessions.ts        ← filtered session list (active states only)
      ui/
        SessionCard.tsx
    dashboard-subsystem-status/
      model/
        use-subsystem-status.ts       ← aggregates Pulse/Relay/Mesh health
      ui/
        SubsystemCard.tsx
    dashboard-activity-feed/
      model/
        use-activity-feed.ts          ← time-grouped event stream
      ui/
        ActivityFeedItem.tsx
        ActivityFeedGroup.tsx
  entities/
    session/
      ui/
        SessionStatusDot.tsx          ← reusable status dot for session status
    pulse-run/
      ui/
        PulseRunBadge.tsx
```

The `DashboardPage` widget composes feature-level widgets. Feature-level components own their data fetching hooks. The `entities` layer provides pure rendering components (status dots, badges) used by features.

---

## Recommendation: Overall Dashboard Approach

**The DorkOS dashboard should be a calm mission control — not a productivity analytics view.**

Its job is to answer three questions in 3 seconds:

1. **Does anything need my attention right now?** (Needs Attention section)
2. **What is running / active?** (Active Now section)
3. **Is the system healthy?** (System Status row)

Everything else is secondary. Recent activity answers the fourth question: "What happened while I was away?" but this is informational, not urgent.

**What makes this world-class:**

- The absence of "Needs Attention" content is meaningful — silence is signal, not emptiness.
- Session cards are self-contained action items — Kai can open the relevant session with one click from the dashboard, without navigating to the sidebar.
- System status cards surface health in a single glance — 3 seconds to know if Pulse, Relay, and Mesh are functioning.
- The activity feed provides context for the day's work without requiring the user to open session transcripts.
- Empty states are honest and actionable — they tell the user what to do, not just what is missing.
- Real-time updates happen quietly in the background, with SSE reserved for the most urgent events (tool approvals).

**What is explicitly excluded:**

- Token usage or cost metrics
- Historical trend charts beyond a single 7-day sparkline
- Session transcript excerpts
- Configuration forms or adapter setup
- Mesh topology graph (belongs in Mesh panel)
- Cron expression editing (belongs in Pulse panel)

---

## Research Gaps & Limitations

- GitHub Copilot Mission Control's specific visual design (exact card layouts, color usage) is not publicly documented in detail — patterns are inferred from blog posts and changelog descriptions.
- Vercel's dashboard redesign blog post describes principles but not specific component implementations.
- The "since last visit" timestamp pattern for activity feeds is a recommendation based on general UX principles, not a specifically documented developer tool pattern.
- Sparkline implementation specifics (recharts vs. custom SVG vs. shadcn blocks) require hands-on evaluation — the decision should be deferred to implementation.
- The exact polling intervals (5s active, 30s idle) are educated guesses. Real-world usage patterns for DorkOS will inform optimization.

## Contradictions & Disputes

- **Green for healthy vs. neutral for healthy**: Some design systems (GitHub, Vercel status pages) use green for "operational." This research recommends neutral gray for the default healthy state, following calm technology principles. This is a design philosophy choice, not a correctness issue. Either works; calm tech argues for neutral.
- **Real-time SSE vs. polling**: SSE is architecturally correct for tool approvals but adds connection complexity. Polling at 5s intervals would achieve 95% of the UX benefit with less complexity. For v1, polling is acceptable; SSE is the target for v2.
- **Card count limit (6-8 active sessions)**: Some operators may run 15+ agents simultaneously. The 6-8 limit is based on Miller's Law and the desire for a glanceable view. Power users may prefer to increase this limit. Consider making this user-configurable later.

---

## Sources & Evidence

- [Dashboard Route Navigation Architecture — DorkOS Research](research/20260320_dashboard_route_navigation_architecture.md) — Prior DorkOS research covering dashboard philosophy, content priority framework, and route naming
- [Scheduler Dashboard UI Best Practices — DorkOS Research](research/20260222_scheduler_dashboard_ui_best_practices.md) — Prior DorkOS research on timestamp patterns, conditional polling, skeleton loading, and status triggers
- [Subagent Activity & Streaming UI Patterns — DorkOS Research](research/20260316_subagent_activity_streaming_ui_patterns.md) — Prior DorkOS research on GitHub Copilot Mission Control UI, activity display patterns
- [UI Quality Improvements Research — DorkOS Research](research/20260311_ui_quality_improvements_research.md) — Event log UI patterns, empty state design, activity feed SSE patterns
- [Mesh Panel UX Overhaul — DorkOS Research](research/20260225_mesh_panel_ux_overhaul.md) — Empty state patterns, Linear's "anti-onboarding" philosophy
- [Dashboard Redesign — Vercel Blog](https://vercel.com/blog/dashboard-redesign) — Information hierarchy (production status first), design principle (remove analytics from operations view)
- [Vercel's New Dashboard UX — Medium / Bootcamp](https://medium.com/design-bootcamp/vercels-new-dashboard-ux-what-it-teaches-us-about-developer-centric-design-93117215fe31) — Developer-centric design analysis
- [How to Orchestrate Agents Using Mission Control — GitHub Blog](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/) — GitHub Copilot Mission Control patterns: centralized task list, inline PRs, real-time steering
- [Introducing Agent HQ — GitHub Blog](https://github.blog/news-insights/company-news/welcome-home-agents/) — Agent HQ: unified interface across platforms, task status at a glance
- [Mission Control (Builderz Labs)](https://mc.builderz.dev/) — Counter-example: 32 panels is too many
- [PatternFly Dashboard Design Guidelines](https://www.patternfly.org/patterns/dashboard/design-guidelines/) — Card taxonomy: aggregate status, trend, utilization, details, events cards
- [Aggregate Status Card — PatternFly v3](https://pf3.patternfly.org/v3/pattern-library/cards/aggregate-status-card/) — Exception-only counts (show non-zero only), neutral for healthy
- [Trend Card — PatternFly v3](https://pf3.patternfly.org/v3/pattern-library/cards/trend-card/) — Sparkline + current value pattern
- [Calm Technology — calmtech.com](https://calmtech.com/) — Center vs. periphery attention model
- [Ambient Analytics: Calm Technology for Immersive Visualization](https://arxiv.org/html/2602.19809) — Recent academic application of calm tech to data visualization
- [Designing Empty States in Complex Applications — Nielsen Norman Group](https://www.nngroup.com/articles/empty-state-interface-design/) — Three guidelines: explain why empty, guide next step, provide direct pathway
- [Activity Feed Design — GetStream.io](https://getstream.io/blog/activity-feed-design/) — Flat vs. aggregated feeds, remove redundancies, compact representation
- [Timeline Pattern — UX Patterns for Developers](https://uxpatterns.dev/patterns/data-display/timeline) — Timeline patterns for activity history, developer tool use cases
- [React Status Page Dashboard Block — shadcn/ui](https://www.shadcn.io/blocks/dashboard-status-page) — Colored dot indicators, staggered framer-motion entrance animations, 30-day uptime bars
- [React Table Block Sparkline Charts — shadcn/ui](https://www.shadcn.io/blocks/tables-sparkline) — Inline mini charts with trend indicators and hover tooltips

---

## Search Methodology

- Searches performed: 12
- Most productive search terms: "GitHub Copilot Mission Control multi-agent dashboard UI 2025", "PatternFly dashboard aggregate status card trend card", "Vercel dashboard redesign design principles", "calm technology peripheral vision developer tool status board", "activity feed UX patterns developer tools compact event timeline"
- Primary source categories: Prior DorkOS research reports (highest value — directly applicable), GitHub Blog (Mission Control specifics), PatternFly design system (card taxonomy), Nielsen Norman Group (empty state principles), Vercel blog (developer dashboard philosophy)
- Key gap: No direct access to Linear's internal dashboard design documentation — patterns inferred from public product behavior and secondary sources
