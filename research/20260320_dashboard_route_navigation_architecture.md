---
title: 'Dashboard Design, Route Naming, and Navigation Architecture for DorkOS'
date: 2026-03-20
type: internal-architecture
status: active
tags:
  [dashboard, routing, navigation, spa, react-router, ux, information-architecture, command-center]
searches_performed: 10
sources_count: 28
---

## Research Summary

This report covers four interconnected areas needed for the DorkOS home-dashboard feature: (1) what makes a great developer dashboard based on best-in-class examples, (2) the best route name for the chat/session view when it moves off `/`, (3) what content belongs on the dashboard vs. what is noise, and (4) how to introduce routing into an existing single-view React SPA. The core finding is that DorkOS should adopt a calm, status-first dashboard at `/` that surfaces agent health, active sessions, and actionable exceptions — not metrics or charts. The chat view should move to `/session`, matching the existing internal model. Routing should be introduced with React Router v7's `createBrowserRouter` using a shared layout shell with an `<Outlet>`, preserving the existing sidebar architecture.

---

## Key Findings

### 1. Great Developer Dashboards Are Status Boards, Not Analytics Boards

The strongest developer tool dashboards (Vercel, Linear, Railway, GitHub) have one thing in common: they answer "what happened / what's happening" rather than "how much". They show state and exceptions, not charts. Vercel's redesign explicitly prioritized making "the two most crucial project elements easily accessible: production deployment status and the latest preview deployments" — not traffic graphs or usage trends. Railway's canvas shows all running services and their relationships at a glance. Linear's home view is prioritized work, not analytics. This is the pattern DorkOS should follow.

### 2. Route Naming: `/session` Is the Correct Choice

Among the candidate routes (`/agent`, `/chat`, `/console`, `/session`, `/sessions`), `/session` best fits DorkOS's internal model (sessions are the core primitive), avoids semantic collision with Relay (the messaging subsystem), and works naturally with existing deep-link parameters (`?session=abc123&dir=/path`). `/console` is a close second but collides with the browser's DevTools console concept and is often reserved for server admin UIs.

### 3. Dashboard Content Follows a Clear Signal Hierarchy

The highest-signal content for a "mission control" operator view maps directly to DorkOS's existing subsystems. The rule is: surface state and exceptions, hide detail and configuration. Everything that requires drilling in belongs in its dedicated subsystem panel, not on the dashboard.

### 4. Routing Architecture: Layout Route with `<Outlet>` Is the Correct Pattern

The cleanest approach for introducing React Router into the existing App.tsx is to use `createBrowserRouter` with a single layout route that wraps the sidebar + header shell. Child routes render into an `<Outlet>` in the existing `<main>` area. This requires zero restructuring of the sidebar, zero restructuring of the `SidebarProvider` layout, and preserves the embedded mode entirely unchanged.

---

## Detailed Analysis

### Dashboard Design Patterns

#### What Works: The Status Board Mental Model

The best developer tool dashboards operate on a single mental model: **"here is the state of your system right now — act on anything that needs your attention."** This is distinct from analytics dashboards (which answer "how have things been over time") and from monitoring dashboards (which are Grafana-style time series). For DorkOS, the right frame is closer to an airline operations board or a CI/CD pipeline view.

**Vercel's dashboard redesign** (2023, then iterated) is the clearest case study. Their explicit priorities in order:

1. Production deployment status — is it live and healthy?
2. Latest preview deployments — what just changed?
3. Git metadata (commit, branch, author) — what triggered the change?
4. Logs and function status — secondary, accessible but not foregrounded

The browser favicon itself changes to reflect build status — a pattern Vercel pioneered that acknowledges developers have many tabs open and cannot stare at the dashboard. The implication for DorkOS: the dashboard should surface state in a way that works when the user glances at it, not just when they're actively looking.

**Railway's canvas** shows all services and databases in a spatial, relationship-visible layout. Not just a list — topology matters. This maps to DorkOS's Mesh panel concept. For the dashboard, the key insight from Railway is: **show the relationships and health of the whole, not just a flat list of running things.**

**Linear's home view** is the most disciplined about signal vs. noise. The view shows: My Issues (what I'm responsible for), Inbox (what needs attention), and My Projects (current context). Critically, Linear does not show: team metrics, velocity charts, burndown graphs, or anything that is "nice to know." The design principle they follow is that a dashboard checked daily should be "dense, glanceable, optimized for speed" — not annotated or explanatory.

**GitHub's home dashboard** (post-2023 redesign) prioritizes the activity feed and repository status. What's notable about GitHub's approach is what they removed: stars, trending repos, and other "discovery" content were de-emphasized or removed. The dashboard became more focused on "your work" and "what changed in your work."

**Grafana's best practices** offer the best documentation of the underlying principle: organize information from "overview to detail" (their terminology) or "large to small." The top row is always system health at the highest aggregation level. Each row below exposes one more level of detail. The user drills down by navigating, not by scrolling.

**Mission Control (builderz-labs)** — the open-source agent orchestration dashboard closest in spirit to DorkOS — shows: tasks, agents, skills, logs, tokens, memory, security, cron, alerts, webhooks, pipelines across 32 panels. This is instructive as a counter-example: 32 panels is too many for a dashboard. Mission Control is more of an operations console than a glanceable overview. DorkOS should be more opinionated about what the default view contains.

#### What Does Not Work: Common Anti-Patterns

1. **Charts on the main view**: Unless a developer needs to act on a trend, charts are noise. "Tokens used this week" or "Messages sent" should not be on the dashboard. They require interpretation and do not drive action.
2. **Full configuration exposed**: Settings, adapter setup, agent configuration — all of these have their dedicated panels. The dashboard should link to them, not embed them.
3. **Detail without context**: Showing the full session transcript inline, or all Relay messages, is overwhelming. Show counts and state; link to the full view.
4. **Static layout**: The best modern dashboards (Linear, Vercel) update in real time or near-real-time. For DorkOS, a polling interval of 5-10 seconds for session status is appropriate. SSE for live events (tool approvals) is required.

#### The Calm Tech Principle Applied to Dashboard Design

Calm technology, as articulated by Weiser & Brown (Xerox PARC), distinguishes between information at the "center of attention" and "periphery." A well-designed dashboard should move information from periphery to center only when action is required. For DorkOS:

- **Periphery** (always visible, not demanding attention): Agent count, healthy status, next scheduled run
- **Center** (pulled to attention on change): Active session with pending tool approval, failed Pulse run, dead letters in Relay, agent that has been waiting for input for >1 hour

This maps to the DorkOS design philosophy of "less, but better." The dashboard should feel calm when everything is fine, and alert when it isn't.

---

### Route Naming Analysis

#### Candidate Evaluation

| Route        | Pros                                                                                                        | Cons                                                                                            | Verdict     |
| ------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------- |
| `/agent`     | Short, relates to agents                                                                                    | DorkOS has multiple agents; singular is semantically odd; conflicts with agent settings concept | Reject      |
| `/agents`    | Plural is correct                                                                                           | Could be confused with the Mesh agent registry page                                             | Reject      |
| `/chat`      | Short, familiar                                                                                             | Collides with Relay (the messaging/chat subsystem); doesn't match internal model                | Reject      |
| `/session`   | Matches internal model exactly; works with `?session=id&dir=path` deep linking; standard in developer tools | None significant                                                                                | **Accept**  |
| `/sessions`  | Plural, descriptive                                                                                         | Sounds like a list view, not a single-session workspace                                         | Reject      |
| `/console`   | Evocative of "control panel"; DorkOS language uses "Console"                                                | Collides with browser DevTools console; often implies server admin                              | Weak second |
| `/workspace` | Common in VS Code, Linear context                                                                           | DorkOS doesn't use "workspace" as a term; adds new vocabulary                                   | Reject      |

#### Why `/session` Wins

1. **Internal model alignment**: The server already speaks in sessions. `GET /api/sessions`, `GET /api/sessions/:id`, `useSessionId()` hook. The URL should reflect the model.
2. **Deep link compatibility**: The existing `?session=abc123&dir=/path` query parameters continue to work unchanged. No migration of existing links.
3. **Unambiguous semantics**: `/session` clearly means "I am in a session with an agent." It does not collide with any other DorkOS concept.
4. **Industry precedent**: Cursor uses `/workspace`; Claude.ai uses `/` for chat directly. Among locally-hosted developer tools, session-centric naming is more common than feature-centric naming.
5. **Command palette integration**: The command palette can navigate to "Open session" → `/session?session=abc123`, which reads correctly.

#### URL Structure

```
/                           → Dashboard (the new home)
/session                    → Chat with no session selected (new session prompt)
/session?session=abc123     → Chat with specific session (deep link, existing behavior)
/session?dir=/path/to/proj  → Chat with directory context
```

The existing `useSessionId()` and `useDirectoryState()` hooks read from `nuqs` URL parameters and require no changes — they work identically on `/session` as they did on `/`.

---

### Dashboard Content Analysis

#### Priority Framework

Content is classified by two axes: **signal value** (does this drive action?) and **change frequency** (how often does this change?). High signal + high frequency = foreground. Low signal + low frequency = link or omit entirely.

```
                  High Signal      Low Signal
High Frequency  | FOREGROUND    | BACKGROUND    |
Low Frequency   | LINK TO PANEL | OMIT          |
```

#### What Belongs on the Dashboard (High Signal)

**Tier 1: Immediate Action Required (top of the page)**

- Pending tool approvals across all active sessions — these block agent progress
- Sessions in `waiting` state that have been waiting for >30 minutes (agent stalled, needs human input)
- Dead letters in Relay (messages that could not be delivered)
- Failed Pulse runs (last run failed, needs attention)
- Agents that are offline but should be running

**Tier 2: Active State (at-a-glance, center of page)**

- Currently active (streaming) sessions with agent name, current task description, and elapsed time
- Running Pulse jobs with ETA
- Connected Relay adapters with health status (green/amber/red dot)
- Registered agents in Mesh with their availability status

**Tier 3: Recent Activity (lower on page, glanceable)**

- Sessions completed in the last 24 hours (count + quick-access to most recent)
- Pulse runs completed recently (last run time + status badge per schedule)
- Next scheduled Pulse run (time + agent name)

#### What Does NOT Belong on the Dashboard

- **Full session transcripts**: Detail belongs in `/session`
- **Adapter configuration forms**: Belong in Relay panel
- **Mesh topology graph**: The full graph belongs in the Mesh panel; the dashboard shows only agent health counts
- **Agent settings**: Belong in agent settings dialog
- **Token usage / cost metrics**: No action is driven by this; it is analytics, not operations
- **Historical trend charts**: Same reason — analytics, not operations
- **Detailed Relay message log**: The message inspector belongs in Relay panel
- **Cron expression editor**: Belongs in Pulse panel

#### The Sidebar Question

DorkOS already has an `AgentSidebar` that lists sessions. This creates a potential redundancy: the sidebar shows sessions, and the dashboard would also surface sessions. The resolution:

- **Sidebar**: Recent sessions by timestamp (navigation list, optimized for switching contexts quickly)
- **Dashboard**: Active sessions by state (status board, optimized for seeing what needs attention)

These are different views of the same data, serving different intents. The sidebar is "take me there"; the dashboard is "tell me what's happening." They should coexist and complement each other.

#### Recommended Dashboard Layout

```
┌─────────────────────────────────────────────────────────┐
│  [Agent Identity Chip]           [Command Palette]       │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ⚠ NEEDS ATTENTION (shown only when non-empty)          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Tool approval: "researcher" wants to run bash...   │ │
│  │ Dead letter: 1 Slack message undeliverable    [→]  │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ACTIVE NOW                                              │
│  ┌─────────────────┐  ┌─────────────────┐               │
│  │ 🤖 researcher   │  │ 🤖 coder        │               │
│  │ Analyzing logs  │  │ Waiting for you │               │
│  │ 14m running     │  │ 23m waiting     │               │
│  └─────────────────┘  └─────────────────┘               │
│                                                          │
│  SYSTEM STATUS                                           │
│  Pulse: 3 schedules · Next in 47m                        │
│  Relay: 2 adapters connected (Telegram, Slack)           │
│  Mesh: 4 agents registered                               │
│                                                          │
│  RECENT                                                  │
│  ┌────────────────────────────────────────────────────┐ │
│  │ ✓ coder     finished 2h ago       [Open →]         │ │
│  │ ✓ writer    finished yesterday    [Open →]         │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Card count discipline**: Following cognitive load research (humans process 7±2 items in working memory), the dashboard should show at most 6-8 active session cards. If more than 8 agents are active simultaneously, group them with a "and N more active" overflow.

---

### Navigation Architecture

#### Current State

`App.tsx` today has no router. It is a single-view SPA: the sidebar shows on the left, `<ChatPanel>` fills the right. The view never changes. This is intentional for the embedded (Obsidian) use case, but creates the problem we are solving: there is no `<Dashboard>` view to navigate to.

```tsx
// Current: no routing, single main area
<SidebarInset>
  <header>...</header>
  <main>
    <ChatPanel sessionId={activeSessionId} /> {/* always */}
  </main>
</SidebarInset>
```

#### Target Architecture

React Router v7's `createBrowserRouter` with layout routes is the correct pattern. A single layout route wraps the entire shell (sidebar + header). An `<Outlet>` in the `<main>` area renders whichever route matches.

```tsx
// main.tsx
import { createBrowserRouter, RouterProvider } from 'react-router-dom';

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />, // Layout: SidebarProvider + header + Outlet
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'session', element: <SessionPage /> },
    ],
  },
]);

export function Root() {
  return <RouterProvider router={router} />;
}
```

```tsx
// AppShell.tsx (renamed from App.tsx, standalone path only)
<SidebarProvider ...>
  <Sidebar>
    <AgentSidebar />
  </Sidebar>
  <SidebarInset>
    <header>...</header>
    <main className="flex-1 overflow-hidden">
      <Outlet />   {/* DashboardPage or SessionPage renders here */}
    </main>
  </SidebarInset>
</SidebarProvider>
```

```tsx
// SessionPage.tsx — extracts exactly what was in <main> before
export function SessionPage() {
  const [activeSessionId] = useSessionId();
  const { transformContent } = useOutletContext<AppShellContext>();
  return <ChatPanel sessionId={activeSessionId} transformContent={transformContent} />;
}
```

#### Key Implementation Decisions

**1. Embedded mode is unaffected**

The embedded (Obsidian) path in `App.tsx` has no router and never will. It renders `<ChatPanel>` directly. The routing architecture only applies to the standalone path. The `App` component's `embedded` prop branch can remain entirely unchanged.

**2. URL parameter strategy with nuqs**

The existing `useSessionId()` and `useDirectoryState()` hooks use `nuqs` to read `?session=` and `?dir=` from the URL. With React Router, `nuqs` works with a React Router adapter:

```tsx
// main.tsx
import { NuqsAdapter } from 'nuqs/adapters/react-router/v7';

<NuqsAdapter>
  <RouterProvider router={router} />
</NuqsAdapter>;
```

No changes to any existing hooks or URL parameter usage. Existing deep links (`?session=abc123&dir=/path`) continue to work on the `/session` route.

**3. Sidebar navigation links**

The sidebar's navigation items (currently action buttons that open dialogs) should include at minimum a "Dashboard" link and a "New Session" link. These use `<Link>` (or `NavLink` for active state) from `react-router-dom`:

```tsx
// In AgentSidebar
import { NavLink } from 'react-router-dom';

<SidebarMenuButton asChild>
  <NavLink to="/" end>
    Dashboard
  </NavLink>
</SidebarMenuButton>

<SidebarMenuButton asChild>
  <NavLink to="/session">
    New Session
  </NavLink>
</SidebarMenuButton>
```

The `end` prop on the Dashboard link ensures it only shows as active on exactly `/`, not on `/session`.

**4. Clicking a session in the sidebar**

Currently, clicking a session in the sidebar sets `activeSessionId` in the URL via nuqs. With routing, this should navigate to `/session?session=abc123&dir=/path`. This is a one-line change in the click handler:

```tsx
// Before
setSessionId(session.id);

// After
navigate(`/session?session=${session.id}&dir=${encodeURIComponent(session.dir)}`);
```

**5. Browser history and back button**

With `createBrowserRouter`, the browser's back button works correctly out of the box. Navigating from the dashboard to a session and pressing back returns to the dashboard. This is correct behavior. The `?session=` and `?dir=` parameters in the session URL are preserved in history.

**6. Redirect from `/` to `/session` for direct URL access**

If a user navigates directly to `http://localhost:6241` and has a recent session, the dashboard should be the landing page (not auto-redirect). This is the correct behavior — the dashboard is the new home. No redirect needed.

**7. FSD layer placement**

Following FSD conventions:

- `DashboardPage` → `apps/client/src/layers/widgets/dashboard/` (widget, composes features)
- `SessionPage` → thin wrapper, could stay in `apps/client/src/layers/widgets/session/` or remain in the root `src/` as a page
- `AppShell` → remains at `apps/client/src/App.tsx` (the app shell is not an FSD layer artifact)
- Router setup → `apps/client/src/main.tsx`

#### Library: React Router v7 vs. TanStack Router

React Router v7 is the correct choice because:

1. DorkOS is React 19; React Router v7 officially supports React 19
2. No new dependency; the project can add `react-router-dom` without introducing an unfamiliar paradigm
3. TanStack Router has better TypeScript ergonomics but is a larger learning surface and the project does not currently use it
4. The routing requirements are simple (2-3 routes, shared layout, URL params) — no need for the full power of TanStack Router

---

## Recommendation

### Overall Approach

**Build a calm, state-first dashboard at `/`, move chat to `/session`.**

The dashboard is not a new concept in DorkOS — it is the frame that makes DorkOS feel like an operating system rather than a chat app. The four subsystems (Sessions, Pulse, Relay, Mesh) all exist and have data. The dashboard's job is to create a unified view of that data organized by urgency, not by subsystem.

**Specific recommendations:**

1. **Route structure**: `/` for dashboard, `/session` for chat. Use React Router v7's `createBrowserRouter` with a layout route at `/`. Add `nuqs/adapters/react-router/v7` adapter to `main.tsx`.

2. **Dashboard content priority**:
   - Top: "Needs Attention" — pending tool approvals, stalled sessions, failed Pulse runs, dead letters. Show only when non-empty.
   - Middle: Active sessions as cards (agent name, current activity, elapsed time). Running Pulse jobs.
   - Bottom: System status summary (Relay adapters: N connected, Mesh: N agents, Pulse: next run in Xm). Recent completed sessions.

3. **Dashboard content exclusions**: No charts, no config forms, no token usage, no topology graph, no full message logs.

4. **Sidebar navigation**: Add `Dashboard` and `New Session` as top nav items in the sidebar. Session items in the list navigate to `/session?session=id&dir=path`.

5. **Embedded mode**: No changes. The `embedded` path in `App.tsx` is untouched.

6. **FSD placement for `DashboardPage`**: `layers/widgets/dashboard/` — it composes from entities (sessions, pulse, relay, mesh) and features.

### Implementation Order

1. Add `react-router-dom` dependency
2. Add `nuqs/adapters/react-router/v7` adapter
3. Refactor `main.tsx` to use `RouterProvider` with `createBrowserRouter`
4. Extract standalone shell from `App.tsx` into `AppShell` component with `<Outlet>`
5. Create `SessionPage` wrapper around existing `<ChatPanel>` at `/session`
6. Create `DashboardPage` at `/`
7. Update `AgentSidebar` session click handlers to use `navigate()`
8. Add Dashboard and New Session links to sidebar

---

## Research Gaps and Limitations

- No direct access to Railway's or Linear's internal design documentation — patterns inferred from public-facing product behavior and secondary sources
- The "calm tech" framing for dashboard design is a recommended lens, not an externally validated pattern for this specific use case
- TanStack Router was not evaluated in depth — if the project eventually needs type-safe routes, that comparison should be revisited
- The dashboard layout sketch is conceptual; pixel-level design and responsive behavior require hands-on design iteration

## Contradictions and Disputes

- Mission Control (open-source agent dashboard) shows 32 panels — this contradicts the "calm, minimal" approach recommended here. The recommendation to minimize is based on DorkOS's design philosophy (Dieter Rams, Jony Ive) and persona needs (Kai wants a glance, not a console), not universal dashboard truth.
- Some UX sources advocate for user-customizable dashboards (drag-and-drop widgets). This is explicitly out of scope for DorkOS at this stage — our personas want a curated, opinionated view.

## Search Methodology

- Searches performed: 10
- Most productive terms: "Vercel dashboard redesign UX patterns", "mission control AI agent orchestration dashboard", "React Router v7 layout route Outlet sidebar SPA"
- Primary sources: vercel.com/blog, reactrouter.com, grafana.com docs, github.com/builderz-labs/mission-control, pencilandpaper.io, medium.com/design-bootcamp

## Sources

- [Vercel Dashboard Redesign — Vercel Blog](https://vercel.com/blog/dashboard-redesign)
- [Vercel's New Dashboard UX: Developer-Centric Design — Medium](https://medium.com/design-bootcamp/vercels-new-dashboard-ux-what-it-teaches-us-about-developer-centric-design-93117215fe31)
- [Mission Control — Open-Source Agent Orchestration Dashboard](https://mc.builderz.dev/)
- [How to orchestrate agents using mission control — GitHub Blog](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/)
- [Single Page App (SPA) — React Router](https://reactrouter.com/how-to/spa)
- [How to Create a Location Aware Sidebar with React Router — ui.dev](https://ui.dev/react-router-sidebar-breadcrumbs)
- [Grafana Dashboard Best Practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/)
- [Six Principles of Dashboard Information Architecture — GoodData](https://www.gooddata.com/blog/six-principles-of-dashboard-information-architecture/)
- [Dashboard Design UX Patterns — Pencil & Paper](https://www.pencilandpaper.io/articles/ux-pattern-analysis-data-dashboards)
- [Effective Dashboard Design Principles — UXPin](https://www.uxpin.com/studio/blog/dashboard-design-principles/)
- [Dashboard Design Best Practices — Toptal](https://www.toptal.com/designers/data-visualization/dashboard-design-best-practices)
- [Linear Dashboards Best Practices](https://linear.app/now/dashboards-best-practices)
- [React Router Fundamentals — Medium](https://medium.com/@yramcharanteja/react-router-fundamentals-and-concepts-8683f93e2674)
- [How to Structure a React App in 2025 — Medium](https://ramonprata.medium.com/how-to-structure-a-react-app-in-2025-spa-ssr-or-native-10d8de7a245a)
- [Six Factors for Better URL Path Design — Bits and Pieces](https://blog.bitsrc.io/six-factors-for-better-url-path-design-in-web-apps-5788499b0bbd)
- [Railway vs Render — Northflank](https://northflank.com/blog/railway-vs-render)
