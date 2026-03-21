# Dashboard Content — Ideation

**Created**: 2026-03-20
**Status**: Ideation
**Depends on**: `dashboard-home-route` (completed), `dynamic-sidebar-content` (in progress)

---

## Context

The dashboard route exists (`/`) but renders only a centered placeholder: "DorkOS — Mission control for your agents." The AppShell provides a sidebar (sessions/schedules/connections tabs) and a header (agent identity, command palette trigger). This ideation explores what the dashboard should actually contain — in the main content area, the header, and the sidebar — to serve as the mission control screen for an AI workforce operator.

---

## Guiding Questions

### 1. First Thing After Onboarding

Users just named their first agent, maybe discovered a few projects, maybe set up a Pulse schedule or a Relay adapter. They're excited but uncertain. They need:

- **Confirmation that the system is alive** — their agent exists, it's reachable, the runtime is connected
- **A clear next action** — "Start your first conversation" or "Your agent is ready. Ask it something."
- **A sense of what's possible** — not a feature tour, but ambient evidence that this system does more than chat. A schedule card that says "No schedules yet." A connections section that says "No adapters connected." These empty states ARE the onboarding — they show the shape of what's coming.

**The anti-pattern**: A wall of empty widgets. That feels like software that's judging you for not configuring it yet.

**The ideal**: A dashboard that feels complete even with one agent and zero history. Like a new MacBook desktop — clean, calm, ready.

---

### 2. Morning — "What Happened While I Slept?"

This is Kai's core scenario. He set agents running overnight. He opens DorkOS with coffee. He wants:

- **A heartbeat summary** — "3 agents ran overnight. 2 completed. 1 needs your attention."
- **Completed work** — PRs created, tasks finished, sessions that ended successfully. Not the full transcript — just the outcomes. "Agent `frontend` created PR #47: Dark mode toggle" with a link.
- **Things that need him** — tool approvals waiting, sessions paused for input, errors that stopped execution. These should be visually distinct and urgent.
- **Relay messages received** — any inbound messages from other agents or external channels
- **A timeline** — a compact activity feed showing what happened, in order, while he was away. Like a git log for his agent team.

**The killer morning experience**: Open the dashboard and within 3 seconds, you know the state of everything. No clicking. No expanding. No navigating. The information hierarchy does the work.

---

### 3. After Key Actions — "What's Changed?"

**After setting up a new agent**: The dashboard should reflect the new agent. An agent roster card shows all registered agents with their status (idle, working, offline). The new one appears with a subtle entrance animation.

**After discovering agents**: The Mesh topology should be reflected — who knows about whom, what connections exist. A network visualization that grows as you add agents.

**After configuring adapters**: The connections section shows live adapter status — Telegram connected, webhook healthy, etc. Green dots. Confidence that the plumbing works.

**After a long chat session**: A session summary card — what was accomplished, how long it ran, tokens used. Maybe a "session highlight" that captures the most meaningful outcome.

---

### 4. Before Signing Off — "Is Everything Set?"

- **Scheduled runs coming up** — "Agent `backend` runs in 2 hours (triage issues). Agent `frontend` runs at 2am (implement next roadmap item)."
- **Active sessions** — anything still running that might need attention
- **System health** — runtime connected, API keys valid, adapters healthy
- **A sense of calm** — "Everything is set. 2 schedules will run tonight. You'll get a Telegram message when they finish." This is the emotional payoff. You can close the laptop.

---

### 5. Delight and Surprise

**Activity sparklines** — tiny inline charts showing agent activity over the past 24h/7d. Not analytics — ambient awareness. Like the Activity rings on Apple Watch. At a glance, you see patterns: "My agents are most active between 2-4am."

**Streak counters** — "Your agents have shipped code for 14 consecutive days." Gamification done right — not badges, just a quiet counter that makes you feel like you built something that works.

**The "while you were away" moment** — when you open the dashboard after being away for hours, a subtle animation reveals what happened. Not a notification bombardment — a calm unfolding. Like picking up a newspaper vs. being yelled at by a news ticker.

**Agent personality in the dashboard** — each agent's card uses its color, icon, and name. The dashboard feels like a team roster, not a database table. You see your team at a glance.

**Sound design** — optional, subtle audio cues. A soft chime when you open the dashboard and everything is healthy. Nothing when there are issues. The absence of the chime IS the alert.

**Celebration moments** — when all scheduled runs completed successfully overnight, a subtle visual celebration. Not confetti (we already have that for tasks). Something quieter. Maybe the whole dashboard breathes — a gentle pulse of color that fades.

---

### 6. World-Class Dashboard

**What makes dashboards world-class:**

- **Information density without clutter** — Linear's dashboard shows everything in a compact, scannable way. Every pixel earns its space.
- **Progressive disclosure** — the dashboard shows summaries. Click to expand. Click again for full detail. Three levels of depth, each useful on its own.
- **Real-time without anxiety** — SSE-powered live updates. Sessions appear, progress, complete. But no flashing, no bouncing, no "ALERT!" — calm real-time.
- **Responsive to YOUR patterns** — the dashboard learns what you care about. If you always check Pulse runs first, that section rises to prominence. If you never look at system health, it collapses.

**The Linear inspiration**: Linear's dashboard is a masterclass. Clean typography. Tight spacing. High information density. No decoration. Every element is functional. The design is so confident it doesn't need to explain itself.

**The Raycast inspiration**: Raycast's dashboard is a single surface that adapts to context. It shows what's relevant right now, not a static grid of widgets.

---

### 7. Viral Killer Feature Ideas

#### The Live Agent Map (Near-term, buildable now)

A real-time visualization of your agent network. Agents as nodes. Messages between them as animated lines. Active sessions glow. Scheduled runs pulse. It's a living, breathing map of your AI workforce. Screenshot-worthy. Tweet-worthy. "Look at my agent mesh running overnight."

This is the visual that sells DorkOS. Nobody else has it. It makes the invisible (agent coordination) visible.

#### The Morning Briefing (Near-term)

When you open the dashboard after being away for 4+ hours, an AI-generated natural language summary appears at the top: "While you were away, 3 agents ran. `backend` triaged 7 issues and closed 4. `frontend` created PR #52 (dark mode toggle). `research` found 3 relevant papers and saved them to your Obsidian vault. One run failed — `devops` hit a rate limit at 3:47am."

Not a list. A briefing. Written by an agent that reads the overnight transcripts and writes a human summary. This is the "your AI never sleeps" moment made tangible.

#### The Coordination Timeline (Medium-term)

A horizontal timeline showing all agent activity across all projects. Zoom in to see individual tool calls. Zoom out to see daily patterns. Like a recording studio's multitrack view — each agent is a track, each session is a clip. You can see, at a glance, when agents overlapped, when one waited for another, when the system was idle.

#### The Ship Log (Medium-term)

An auto-generated changelog of everything your agents shipped. PRs created, code deployed, issues triaged, tests written. Aggregated across all agents, all projects. A single page that answers "what did my AI team accomplish this week?" This is the artifact you show your co-founder, your investors, your team. "My agents shipped 47 PRs this week."

#### Agent Vital Signs (Near-term)

Each agent card shows vital signs like a patient monitor — session success rate, average duration, tokens per session, cost per day. Not analytics — vitals. The metaphor matters. These are your team members. You monitor their health.

#### The Command Center Mode (Ambitious)

A full-screen, dark-mode, information-dense view designed for a second monitor or a wall display. Think NASA mission control meets Bloomberg terminal. All agents visible. All sessions streaming. All schedules ticking. Designed to be glanced at from across the room. The kind of thing you'd put on a TV in your office. Pure ambient awareness.

#### Cross-Agent Memory Graph (Ambitious, Wing-dependent)

A knowledge graph visualization showing what your agents collectively know. Entities they've encountered, relationships they've discovered, patterns they've identified. Click a node to see which sessions contributed to that knowledge. This makes Wing's persistent memory tangible and visual.

#### The Autonomous Improvement Dashboard (Ambitious, Loop-dependent)

A live view of the Loop cycle: signals detected → hypotheses formed → tasks dispatched → outcomes measured. A visual feedback loop that shows your software improving itself in real-time. This is the "self-improving software" vision made concrete. Seeing the loop run is like watching evolution — mesmerizing.

---

### 8. What Would Jobs and Ive Do?

**Jobs would ask**: "What is the ONE thing the dashboard does?" Not seven things. One thing, done perfectly. Everything else is secondary. He'd look at every widget and ask "does this serve the one thing?"

The one thing: **Ambient awareness of your AI workforce.** You open it, you know the state of everything, you close it. Three seconds.

**Ive would focus on the materials**: The typography, the spacing, the way information breathes. He'd spend a week on the padding between agent cards. He'd insist that the empty state is as beautiful as the full state. He'd remove every border, every divider, every shadow that doesn't earn its existence. The dashboard would feel like a single sheet of paper with information printed on it — no chrome, no frames, no containers.

**They would eliminate**:

- Tab navigation within the dashboard (one view, not switchable panes)
- Configuration UI on the dashboard (that belongs in settings)
- Anything that requires reading to understand (use shape, color, position)
- Any widget that can't justify itself in the "one thing" frame

**They would insist on**:

- A dashboard that works at arm's length (readable from across the room)
- Typography as the primary design element (not cards, not borders — type)
- A single, breathtaking empty state (not "nothing to show" — a beautiful zero state)
- Color used sparingly and meaningfully (agent colors only, status colors only)
- Motion that communicates (a working agent pulses slowly, not spins — biological, not mechanical)

---

### 9. Beyond Anyone's Dreams

#### The Living System

The dashboard isn't a report. It's alive. Agents breathe — their cards subtly pulse when active, rest when idle. Messages flow between agents as gentle arcs of light. The whole dashboard has a heartbeat — a slow, system-wide pulse that speeds up when work is happening and slows when the system is idle. You don't read this dashboard. You feel it.

#### Natural Language Everything

No tables. No stats. No numbers. The entire dashboard is natural language. "Your team is working on 3 things right now. The most important is the authentication refactor — it's been running for 2 hours and is 70% done based on the task list. Nothing needs your attention."

The dashboard reads like a message from your chief of staff.

#### Predictive Scheduling

The system notices patterns. "You always start a chat session after checking the morning briefing. Should I have an agent start the first task before you sit down?" Not AI generating work — AI recognizing your patterns and preparing the runway.

#### The Digital Office

Your dashboard IS your workspace. Agent cards are arranged spatially — draggable, groupable, nestable. Your DorkOS dashboard is a digital room where your agents work. You arrange them the way you arrange your desk. The frontend team is on the left. The research agents are in the corner. DevOps is front and center. It's YOUR space, arranged YOUR way.

#### Cross-Machine Mesh View

You run DorkOS on your laptop, your home server, and a VPS. The dashboard shows all three instances as a unified view. A global mesh of all your agents, everywhere. Click a node to tunnel into that instance. Your agent network spans machines — and the dashboard makes that visible.

#### The Replay

Click "yesterday" and watch your agent network replay the entire day in accelerated time. Sessions starting, messages flowing, PRs being created, agents coordinating. Like a time-lapse of your AI team working. 24 hours compressed into 60 seconds. Beautiful. Informative. Shareable.

---

## Synthesis: Initial Direction

### Dashboard Header

- **Agent identity** (current, as-is) — name, color, icon
- **System health indicator** — a single dot: green (all good), amber (needs attention), red (something broken)
- **Quick actions** — New Session, Trigger Schedule, Compose Message
- Could be simplified compared to session header — the dashboard is about overview, not action

### Dashboard Sidebar

- Could remain the same AgentSidebar (sessions/schedules/connections)
- Or: a simplified sidebar showing **the agent roster** — all registered agents with live status, not sessions. The dashboard is about agents, not individual sessions.
- A "System" section showing Pulse/Relay/Mesh status at a glance

### Dashboard Main Content

**Top: The Briefing** (the killer feature)

- Natural language summary of recent activity
- Adapts to time of day and time since last visit
- Morning: "While you were away..." / During work: "Right now..." / Evening: "Tonight's schedule..."

**Middle: Agent Roster**

- Cards for each agent with: name, icon, color, status (working/idle/offline), current session if active, last activity timestamp, next scheduled run
- Vital signs sparklines (activity over 24h)
- Click to navigate to that agent's session

**Bottom: Activity Feed**

- Chronological timeline of system events
- Session completions, Pulse runs, Relay messages, Mesh discoveries
- Compact, scannable, real-time via SSE

**Empty State**

- Beautiful, calm, encouraging
- "Your agent is ready. Start a conversation or set up a schedule."
- Shows the shape of what the dashboard becomes, without feeling empty

---

## Open Questions

- Should the dashboard sidebar be the same as the session sidebar, or a different view entirely?
- Should the dashboard header differ from the session header?
- How much data can we actually surface today vs. what requires new server APIs?
- Should the briefing be AI-generated (requires agent call) or deterministic (assembled from data)?
- How do we handle the single-agent case vs. the multi-agent case gracefully?
- What's the right information density for v1 vs. what we grow into?
