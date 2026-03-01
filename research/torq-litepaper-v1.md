---
title: "Torq: The Autonomous Improvement Engine (v0.1)"
date: 2026-02-18
type: exploratory
status: superseded
superseded_by: research/torq-litepaper-v2.md
tags: [torq, loop, autonomous-improvement, litepaper, ideation]
---

# Torq: The Autonomous Improvement Engine

**Working title — name TBD**
**Version:** 0.1 (Draft)
**Author:** Dorian Collier
**Date:** February 2026

---

## One-Liner

An open-source autonomous improvement engine that collects signals, generates hypotheses, plans work, dispatches AI agents, and monitors outcomes — closing the feedback loop that turns software teams into self-improving systems.

---

## The Problem

We have incredible AI coding agents. Claude, Devin, and dozens of open-source alternatives can write code, fix bugs, and ship features autonomously. We also have excellent task management tools — Linear, Jira, GitHub Issues — that organize human work into trackable units.

**But there is no system that closes the loop.**

Today's workflow looks like this:

```
Human notices problem → Human writes ticket → Human (or agent) does work → Ship → ???
```

The "???" is where everything breaks down. After shipping:
- Who checks if the fix actually worked?
- Who notices the new regression?
- Who synthesizes the PostHog data, user feedback, and error logs into actionable next steps?
- Who decides what to work on next based on what we just learned?

**The answer is always a human.** A human who is context-switching, forgetting, and operating on gut feel rather than systematic analysis. The feedback loop exists in their head, and it runs once a week at best — during sprint retros that nobody pays attention to.

Height attempted to build an "autonomous project manager" and shut down in September 2025 after 3.5 years. Linear has positioned itself as the PM layer that *accepts* AI agents as task assignees via MCP. Factory.ai builds "Droids" that execute across the full SDLC. But none of them close the loop. They all assume a human is synthesizing feedback and deciding what to work on next.

**The missing piece is the engine that turns signals into hypotheses, hypotheses into plans, plans into tasks, and tasks into agent sessions — then monitors the outcomes and feeds them back in.**

---

## The Insight: Everything Is a Task

The key architectural insight is that the feedback loop doesn't need a separate workflow engine, state machine, or orchestration layer. **Everything is a task.**

- A signal arrives (user feedback, PostHog event, error spike) → **Create a task**: "Process this signal"
- An agent processes the signal → **Create a task**: "Generate hypothesis from these findings"
- A hypothesis is formed → **Create a task**: "Create implementation plan"
- A plan is created → **Create implementation tasks**
- Tasks are executed by agents → **Create a task**: "Monitor outcomes of [feature/fix]"
- Monitoring detects a change → **Create a task**: "Process this new signal"

The task queue IS the orchestration layer. This means:

1. **One unified data model** — everything is an issue/task with metadata
2. **One priority system** — signals, hypotheses, and implementation tasks compete in the same backlog
3. **Full auditability** — every decision the system makes is traceable as a task with a parent chain
4. **Human override at any point** — humans can create, modify, or cancel any task
5. **Agent sessions are always attached** — every piece of work has a full transcript of what the agent did

---

## How It Works

### The Loop

```
                    ┌─────────────┐
                    │   SIGNALS   │
                    │             │
                    │ PostHog     │
                    │ User feedback│
                    │ Error logs  │
                    │ Agent reports│
                    │ Git events  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   PROCESS   │
                    │             │
                    │ Agent picks │
                    │ up "process │
                    │ signal" task│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ HYPOTHESIZE │
                    │             │
                    │ Agent forms │
                    │ hypothesis  │
                    │ from signal │
                    │ + context   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │    PLAN     │
                    │             │
                    │ Agent breaks│
                    │ hypothesis  │
                    │ into tasks  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   EXECUTE   │
                    │             │
                    │ Agent picks │
                    │ up impl     │
                    │ tasks, codes│
                    │ PRs, deploys│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   MONITOR   │
                    │             │
                    │ Watch for   │
                    │ outcome     │
                    │ signals     │
                    └──────┬──────┘
                           │
                           └──────→ (back to SIGNALS)
```

### Concrete Example

1. **Signal**: PostHog webhook fires — "Sign-up conversion rate dropped 12% in the last 24 hours"
2. **Task created**: `[signal] PostHog: sign-up conversion -12% (24h)` — assigned to agent
3. **Agent processes**: Reads the PostHog data, checks recent deployments, git log, error rates. Produces a structured analysis.
4. **Hypothesis created**: `[hypothesis] Recent auth flow change (PR #847) likely caused conversion drop — new OAuth redirect adds friction`
5. **Plan created**: `[plan] Revert OAuth redirect change OR add loading state to reduce perceived latency`
6. **Implementation tasks created**:
   - `[task] Add loading spinner to OAuth redirect page`
   - `[task] Add PostHog event tracking to measure redirect latency`
   - `[task] Create monitoring rule: alert if conversion drops >5% in 12h`
7. **Agent executes**: Picks up tasks, writes code, creates PRs, CI passes, auto-merges, deploys
8. **Monitor**: The monitoring rule watches PostHog for the next 48 hours
9. **New signal**: "Sign-up conversion rate recovered to baseline +2%"
10. **Hypothesis validated**: System marks the hypothesis as confirmed, closes the loop

The entire chain is visible as linked tasks. Every agent session is recorded. Every decision is auditable.

---

## Core Concepts

### Signals

A signal is any piece of information that enters the system from the outside world. Signals are the raw inputs to the feedback loop.

**Built-in signal sources:**

| Source | How it connects | What it produces |
|--------|----------------|-----------------|
| **PostHog** | Webhook integration | Metric changes, funnel drops, feature adoption data |
| **User Feedback Widget** | Embeddable JS widget + API endpoint | Bug reports, feature requests, friction reports |
| **Agent Reports** | MCP tool / CLI command | Session summaries, encountered issues, improvement suggestions |
| **Git Events** | GitHub/GitLab webhooks | PR merges, CI failures, deployment events |
| **Error Tracking** | Sentry/similar webhook | Error spikes, new error classes, regression detection |
| **Custom** | REST API endpoint | Anything — Slack messages, support tickets, custom metrics |

Every signal creates a task. The task contains the raw signal data and metadata about the source, timestamp, and confidence level.

**Signal schema:**

```
Signal {
  id: uuid
  source: string           // "posthog", "feedback-widget", "agent", "github", "custom"
  sourceId: string          // External reference (PostHog event ID, PR number, etc.)
  type: string              // "metric-change", "user-feedback", "error-spike", "deployment", etc.
  severity: low | medium | high | critical
  payload: jsonb            // Raw signal data, source-specific
  processedAt: timestamp?   // null until an agent processes it
  taskId: uuid              // The "process signal" task that was created
  createdAt: timestamp
}
```

### Issues / Tasks

The universal work unit. Everything in the system is an issue — signals to process, hypotheses to validate, plans to execute, bugs to fix.

```
Issue {
  id: uuid
  key: string               // Human-readable key: "TORQ-142"
  title: string
  description: text
  type: signal | hypothesis | plan | task | bug | feature | improvement
  status: backlog | todo | in_progress | in_review | done | cancelled
  priority: urgent | high | medium | low | none
  assignee: user | agent

  // Hierarchy
  parentId: uuid?           // Links hypothesis → signal, plan → hypothesis, task → plan
  children: uuid[]

  // Agent execution
  sessions: AgentSession[]  // All agent sessions that worked on this issue
  commits: Commit[]         // Git commits attached to this issue
  pullRequests: PR[]        // PRs created for this issue

  // Lifecycle
  hypothesis: Hypothesis?   // Present when type = "hypothesis"
  signal: Signal?           // Present when type = "signal"

  // Metadata
  labels: string[]
  project: Project?
  cycle: Cycle?
  createdAt: timestamp
  updatedAt: timestamp
  completedAt: timestamp?
}
```

### Hypotheses

A hypothesis is a structured belief about cause and effect, generated by an agent from signal analysis.

```
Hypothesis {
  id: uuid
  issueId: uuid             // The issue of type "hypothesis"
  signalIds: uuid[]         // Signals that informed this hypothesis

  statement: string         // "OAuth redirect change caused conversion drop"
  evidence: Evidence[]      // Supporting data points
  confidence: 0.0-1.0       // Agent's confidence level

  prediction: string        // "Reverting/fixing will restore conversion to baseline"
  validationCriteria: string // "Conversion rate returns to >3.2% within 48h"
  validationSignal: string? // What signal source to watch

  status: proposed | testing | validated | invalidated | inconclusive
  outcome: text?            // What actually happened

  createdAt: timestamp
  resolvedAt: timestamp?
}
```

### Agent Sessions

Every time an agent works on an issue, the full session is recorded and linked.

```
AgentSession {
  id: uuid
  issueId: uuid

  // Execution context
  model: string             // "claude-opus-4-6", "claude-sonnet-4-5", etc.
  cwd: string               // Working directory
  permissionMode: string    // "acceptEdits", "bypassPermissions", etc.

  // Results
  status: running | completed | failed | cancelled
  summary: text             // Agent-generated summary of what happened
  tokensUsed: number
  costUsd: number
  durationMs: number

  // Artifacts
  commits: Commit[]
  pullRequests: PR[]
  filesModified: string[]

  // DorkOS integration
  dorkosSessionId: string?  // Session ID in connected DorkOS instance
  transcriptUrl: string?    // Link to full session transcript

  startedAt: timestamp
  finishedAt: timestamp?
}
```

### Projects and Cycles

Following Linear's methodology:

- **Projects** group related issues toward a goal (e.g., "Improve onboarding flow")
- **Cycles** are time-boxed periods (2-week default) for planning and execution
- **Initiatives** are high-level strategic directions that projects roll up to

The autonomous loop operates within this structure — agents work on issues that belong to projects within the current cycle. The system respects the team's strategic direction rather than optimizing purely on signal urgency.

---

## Integration with DorkOS

Torq integrates with DorkOS as its primary agent execution backend. The integration uses DorkOS's existing REST API and MCP tool server.

### How Torq dispatches work to DorkOS

```
Torq                                    DorkOS
  │                                       │
  │  POST /api/sessions                   │
  │  { permissionMode, cwd }              │
  │──────────────────────────────────────→│
  │  { id: "session-uuid" }              │
  │←──────────────────────────────────────│
  │                                       │
  │  POST /api/sessions/:id/messages      │
  │  { content: "task prompt + context" } │
  │──────────────────────────────────────→│
  │  SSE stream (text_delta, tool_call,   │
  │  approval_required, done, etc.)       │
  │←──────────────────────────────────────│
  │                                       │
  │  (accumulate results, store session)  │
  │                                       │
```

### What Torq sends as the task prompt

When dispatching an issue to an agent via DorkOS, Torq constructs a rich prompt:

```
=== TORQ CONTEXT ===
Issue: TORQ-142 — Add loading spinner to OAuth redirect page
Type: task
Priority: high
Project: Improve onboarding flow
Cycle: 2026-W08

Parent chain:
  - [plan] Revert or fix OAuth redirect friction
  - [hypothesis] OAuth redirect change caused conversion drop (confidence: 0.82)
  - [signal] PostHog: sign-up conversion -12% (24h)

Related issues:
  - TORQ-140: Add PostHog event tracking to redirect latency
  - TORQ-141: Create monitoring rule for conversion drops

Repository: github.com/acme/webapp
Branch strategy: Create feature branch from main

Requirements:
When you complete this task, report back with:
1. Summary of what you did
2. Files modified
3. Tests added/modified
4. PR URL (if created)
5. Any issues encountered
6. Suggestions for follow-up work
=== END TORQ CONTEXT ===

Add a loading spinner to the OAuth redirect page to reduce perceived latency.
The current implementation shows a blank white page during the OAuth redirect,
which takes 1.5-3 seconds. Add a centered spinner with "Signing you in..." text.
```

### MCP Tool Server

Torq exposes an MCP tool server that DorkOS agents can call during their sessions:

| Tool | Purpose |
|------|---------|
| `torq_get_issue` | Read issue details, parent chain, related issues |
| `torq_update_issue` | Update status, add comments, attach artifacts |
| `torq_create_issue` | Create child issues or follow-up work |
| `torq_submit_signal` | Report a signal (agent-discovered issue, improvement idea) |
| `torq_get_context` | Get project/cycle context for the current issue |
| `torq_attach_session` | Link the current DorkOS session to the issue |
| `torq_log_commit` | Attach a git commit to the issue |
| `torq_log_pr` | Attach a PR to the issue |

This means agents working through DorkOS can read their full task context and report back results without any human intermediary.

---

## Architecture

### Cloud-First Design

Torq runs as a cloud service with public endpoints, enabling:
- Webhooks from PostHog, GitHub, Sentry, etc.
- The feedback widget to POST from any website
- Multiple DorkOS instances to connect as agent backends
- Multiple team members to access the dashboard

### Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **API** | Node.js + Hono (or Express) | Fast, TypeScript-native, excellent middleware ecosystem |
| **Database** | PostgreSQL + Drizzle ORM | Relational integrity for issue hierarchies, JSONB for signal payloads |
| **Queue** | pg-boss (Postgres-backed) | No separate Redis/RabbitMQ needed; transactional job creation |
| **Auth** | Better Auth or Clerk | Team management, API keys for integrations |
| **Frontend** | React 19 + Vite + Tailwind + shadcn/ui | Consistent with DorkOS ecosystem |
| **Real-time** | Server-Sent Events | Dashboard updates, agent session streaming |
| **CLI** | Node.js binary | `torq` command for local interaction |
| **MCP Server** | @anthropic-ai/claude-agent-sdk | In-process MCP for agent tool access |

### System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         TORQ CLOUD                              │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Signal   │  │ Issue    │  │ Agent    │  │ Dashboard│       │
│  │ Ingestion│  │ Tracker  │  │ Dispatch │  │ (React)  │       │
│  │ API      │  │ API      │  │ Service  │  │          │       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────┘       │
│       │              │              │                            │
│  ┌────▼──────────────▼──────────────▼────┐                      │
│  │          PostgreSQL + pg-boss          │                      │
│  │                                        │                      │
│  │  signals │ issues │ sessions │ jobs    │                      │
│  └────────────────────────────────────────┘                      │
│                         │                                        │
│                    ┌────▼────┐                                   │
│                    │  Queue  │                                   │
│                    │ Workers │                                   │
│                    └────┬────┘                                   │
│                         │                                        │
└─────────────────────────┼────────────────────────────────────────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
         ┌────▼───┐  ┌───▼────┐  ┌──▼──────┐
         │ DorkOS │  │ DorkOS │  │ Future  │
         │ Inst 1 │  │ Inst 2 │  │ Agents  │
         └────────┘  └────────┘  └─────────┘
```

### Queue Workers

The queue is the heartbeat of the system. Workers process tasks in priority order:

| Worker | Trigger | Action |
|--------|---------|--------|
| `signal-ingest` | New signal received via API/webhook | Validate, deduplicate, create "process signal" issue |
| `signal-process` | "Process signal" issue assigned to agent | Dispatch to DorkOS, collect analysis, create hypothesis issue |
| `hypothesis-plan` | New hypothesis issue created | Dispatch to DorkOS, agent creates implementation plan + child issues |
| `task-dispatch` | Implementation issue becomes `todo` | Dispatch to DorkOS, agent executes, reports back |
| `monitor-check` | Monitoring issue scheduled check | Query signal sources, evaluate validation criteria |
| `session-sync` | Agent session completes | Sync results back to issue (commits, PRs, summary) |
| `auto-merge` | PR passes CI | Merge PR, update issue status, trigger deployment |
| `retention` | Scheduled (daily) | Archive old signals, prune completed cycles |

---

## The CLI

```bash
# View and manage issues
torq list                          # List issues in current cycle
torq show TORQ-142                 # Show issue details with full context chain
torq create "Fix login timeout"    # Create a new issue
torq assign TORQ-142 agent        # Assign to agent for autonomous execution

# Signal management
torq signals                       # List recent signals
torq signals --source posthog      # Filter by source
torq signal "Users reporting slow checkout"  # Submit a manual signal

# Hypothesis tracking
torq hypotheses                    # List active hypotheses
torq hypotheses --status testing   # Filter by status

# Agent interaction
torq dispatch TORQ-142             # Manually dispatch an issue to an agent
torq sessions                      # List recent agent sessions
torq session abc123 --transcript   # View full agent transcript

# Configuration
torq connect dorkos http://localhost:4242  # Connect a DorkOS instance
torq connect posthog --api-key pk_...      # Connect PostHog
torq config set cycle-length 14            # Set 2-week cycles

# Dashboard
torq dashboard                     # Open web dashboard in browser
torq status                        # Quick health check in terminal
```

---

## The Feedback Widget

A lightweight, embeddable JavaScript widget that collects user feedback and sends it to Torq as a signal.

```html
<script src="https://torq.example.com/widget.js"
        data-project="your-project-id"
        data-position="bottom-right">
</script>
```

Features:
- Feedback types: bug report, feature request, friction report, general feedback
- Optional screenshot capture
- Optional session replay link (PostHog integration)
- Customizable appearance (matches host site's theme)
- Minimal bundle size (<5KB gzipped)
- Works on any website (React, Vue, vanilla, etc.)

Each feedback submission becomes a signal → which becomes a "process signal" task → which an agent analyzes and triages into the appropriate project/category.

---

## Competitive Positioning

### What exists today

| Product | What it does | What's missing |
|---------|-------------|---------------|
| **Linear** | Best-in-class issue tracker + AI triage | No autonomous execution loop, no signal ingestion, no hypothesis layer |
| **Devin** | Autonomous coding agent | No PM layer, no feedback loop, no signal processing, no task management |
| **Factory.ai** | Full SDLC agent fleet ("Droids") | Closed-source, enterprise-only, no built-in PM, no feedback loop |
| **GitHub Copilot Workspace** | AI-assisted coding in IDE | IDE-bound, no autonomous loop, no signal processing |
| **Height** (shut down Sept 2025) | Autonomous project collaboration | Attempted this space, failed commercially. Market gap still open. |

### Where Torq sits

```
                    Issue Tracking ──────────────────────→
                    │
                    │    Linear          Torq
                    │      ●              ●
                    │
                    │
   Feedback         │                               Agent
   Loop ────────────┤                               Execution
                    │                                    │
                    │                                    │
                    │               Factory              │
                    │                 ●                   │
                    │    Jira                  Devin      │
                    │      ●                    ●         │
                    │                                    │
                    ──────────────────────────────────────
```

Torq occupies the unique intersection: **issue tracking + autonomous agent execution + closed feedback loop**. No existing product covers all three.

### Differentiation

1. **The loop is the product.** Not just task management. Not just agent execution. The feedback loop that connects outcomes back to decisions.
2. **Everything is a task.** No separate workflow engine. The task queue is the orchestration layer. Simple to understand, debug, and extend.
3. **Open source.** MIT licensed. No vendor lock-in. Community-driven signal source integrations.
4. **DorkOS-native.** First-class integration with the DorkOS agent execution platform, with a clear adapter interface for future agent backends.
5. **Scientific method, systematized.** Hypotheses are first-class objects with validation criteria, confidence levels, and outcome tracking. The system learns which types of signals lead to valid hypotheses.

---

## Naming Candidates

The product name should evoke continuous improvement, feedback loops, and mechanical/systematic momentum. Research identified these top candidates:

| Name | Metaphor | CLI | Rationale |
|------|----------|-----|-----------|
| **Torq** | Rotational force driving a flywheel | `torq` | Each cycle adds force; the system compounds momentum. 1 syllable, unique spelling. |
| **Ratchet** | Forward-only mechanism | `ratchet` | Gains lock in, no regression. Each click is permanent improvement. |
| **Sigma** | Continuous improvement + signal/noise | `sigma` | Six Sigma = DMAIC loop. σ = signal analysis. Σ = summation. Triple meaning. |
| **Keel** | Structural spine keeping course | `keel` | Directional stability with continuous correction. Kubernetes/Helm family. |
| **Arc** | Trajectory + electric discharge | `arc` | Improvement arcs upward. Energy arcs between signals and actions. |

Additional candidates worth considering:
- **Kaizen** (Japanese for "continuous improvement" — direct, but 3 syllables)
- **Kata** (Toyota Kata — the practice of improvement, 2 syllables)
- **Gyre** (a spiral motion — literary, distinctive)

---

## Roadmap

### Phase 1: Foundation

- PostgreSQL schema + Drizzle ORM setup
- Core issue CRUD (create, read, update, delete, list, filter)
- Issue hierarchy (parent/child linking, type system)
- Signal ingestion API (generic webhook endpoint)
- DorkOS integration (create session, send message, collect results)
- CLI (basic issue management + DorkOS dispatch)
- Web dashboard (issue list, detail view, Kanban board)

### Phase 2: The Loop

- Signal processing worker (agent analyzes signals via DorkOS)
- Hypothesis creation and tracking
- Plan generation (agent breaks hypotheses into tasks)
- Task auto-dispatch (priority queue → agent assignment)
- Session recording and linking (full audit trail)
- PostHog webhook integration
- GitHub webhook integration (PRs, CI, deployments)
- Auto-merge pipeline

### Phase 3: Intelligence

- Monitoring rules (watch signal sources for validation criteria)
- Hypothesis validation/invalidation automation
- Confidence scoring (which signal sources produce actionable hypotheses?)
- Pattern recognition (recurring signal types → automated responses)
- Feedback widget (embeddable JS)
- Sentry integration

### Phase 4: Team & Scale

- Multi-user auth and team management
- Role-based access (who can approve auto-merges, adjust autonomy levels)
- Multiple DorkOS instance support
- Cycle planning automation (suggest cycle contents based on signal priority)
- Reporting and analytics (loop velocity, hypothesis hit rate, agent efficiency)
- MCP server for external agent access

---

## Open Questions

1. **Agent backend abstraction**: How generic should the agent dispatch interface be in v1? DorkOS-specific with a clean adapter boundary, or fully abstract from day one?

2. **Hypothesis confidence calibration**: How do we calibrate the confidence scores over time? Track prediction accuracy per signal source? Per agent model?

3. **Autonomy guardrails**: What guardrails prevent the system from auto-merging something destructive? CI is necessary but not sufficient. Should there be a "blast radius" estimate per PR?

4. **Multi-repo support**: Should v1 support dispatching work across multiple repositories, or start with single-repo?

5. **Cost management**: With fully autonomous execution, API costs could spike. Should there be per-cycle cost budgets? Per-issue cost limits?

6. **Signal deduplication**: How aggressively should we deduplicate signals? A user reporting the same bug 10 times is valuable information (severity signal), not noise.

7. **Relationship to existing DorkOS Pulse scheduler**: Torq's task dispatch is conceptually similar to Pulse's cron-based scheduling. Should Torq replace Pulse, extend it, or operate independently?

---

## Why Now

Three things converged to make this possible:

1. **Agent capability**: Claude Opus 4, Sonnet 4.5, and competitors can now reliably write, test, and ship code autonomously. The 67% PR merge rate that Devin reports is real and improving.

2. **MCP standardization**: The Model Context Protocol (donated to Linux Foundation, backed by Anthropic, OpenAI, Google, Microsoft) means tools can expose capabilities to any agent. A Torq MCP server works with any MCP-compatible agent, not just DorkOS.

3. **The Height-shaped hole**: Height proved the market wants autonomous project management but couldn't make it work commercially. The open-source model (no revenue pressure, community contributions) may be the right approach for infrastructure this foundational.

The question isn't whether AI agents will manage their own work. It's whether the feedback loop that guides them will be built intentionally — with hypotheses, validation, and scientific rigor — or whether it'll be a mess of cron jobs, Slack notifications, and human intuition.

Torq is the intentional version.

---

## Additional Ideas and Observations

### Ideas that emerged during research

1. **"Loop velocity" as a key metric**: How fast does the system go from signal → hypothesis → plan → execution → validated outcome? This is the equivalent of "cycle time" but for the entire feedback loop. Teams should be able to measure and optimize this.

2. **Agent specialization**: Not all tasks should go to the same agent configuration. Signal processing might work best with a fast, cheap model (Haiku). Hypothesis generation might need deep reasoning (Opus). Implementation needs full tool access (Claude Code). The dispatch layer should support model routing per task type.

3. **"Hypothesis hit rate" as a learning signal**: Track what percentage of hypotheses are validated vs. invalidated. Over time, the system learns which signal patterns produce accurate hypotheses and can adjust confidence scores accordingly. This is meta-learning — the loop improving the loop.

4. **Observability-native design**: Borrow OpenTelemetry vocabulary. Each agent session is a "trace." Each tool call within a session is a "span." This makes the system natively compatible with existing observability infrastructure (Grafana, Datadog).

5. **"Friction reports" as a signal type**: The feedback widget shouldn't just collect bug reports and feature requests. "Friction reports" — "this was confusing" or "I expected X but got Y" — are the most valuable signal type because they reveal UX issues before they become bug reports or churn.

6. **Changelog generation from the loop**: Since every shipped change traces back to a signal → hypothesis → plan chain, the system can auto-generate changelogs that explain not just *what* changed but *why* — "Fixed OAuth redirect latency (detected via 12% conversion drop signal)."

7. **Linear Method alignment**: Following Linear's principles — work in cycles, scope issues small, measure progress with actual work, keep backlogs manageable — but automated. The system auto-prunes stale backlog items, auto-scopes large tasks into smaller ones, and measures progress via code diffs rather than status updates.
