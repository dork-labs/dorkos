---
title: 'Torq: The Autonomous Improvement Engine (v0.2)'
date: 2026-02-18
type: exploratory
status: superseded
superseded_by: research/loop-litepaper.md
tags: [torq, loop, autonomous-improvement, litepaper, ideation]
---

# Torq: The Autonomous Improvement Engine

**Working title — name TBD**
**Version:** 0.2 (Draft)
**Author:** Dorian Collier
**Date:** February 2026

---

## One-Liner

An open-source autonomous improvement engine that collects signals, generates hypotheses, plans work, dispatches AI agents, and monitors outcomes — closing the feedback loop that turns software teams into self-improving systems.

---

## The Problem

We have incredible AI coding agents. Claude, Codex, and dozens of open-source alternatives can write code, fix bugs, and ship features autonomously. We also have excellent task management tools — Linear, Jira, GitHub Issues — that organize human work into trackable units.

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

**The answer is always a human.** A human who is context-switching, forgetting, and operating on gut feel rather than systematic analysis. The feedback loop exists in their head, and it runs once a week at best — during retros that nobody pays attention to.

Height attempted to build an "autonomous project manager" and shut down in September 2025 after 3.5 years. Linear has positioned itself as the PM layer that _accepts_ AI agents as task assignees via MCP. Factory.ai builds "Droids" that execute across the full SDLC. But none of them close the loop. They all assume a human is synthesizing feedback and deciding what to work on next.

**The missing piece is the engine that turns signals into hypotheses, hypotheses into plans, plans into tasks, and tasks into agent sessions — then monitors the outcomes and feeds them back in.**

---

## The Insight: Everything Is a Task

The key architectural insight is that the feedback loop doesn't need a separate workflow engine, state machine, or orchestration layer. **Everything is a task.**

- A signal arrives (user feedback, PostHog event, error spike) → **Create an issue**: "Process this signal"
- An agent processes the signal → **Create an issue**: "Generate hypothesis from these findings"
- A hypothesis is formed → **Create an issue**: "Create implementation plan"
- A plan is created → **Create implementation issues**
- Issues are executed by agents → **Create an issue**: "Monitor outcomes of [feature/fix]"
- Monitoring detects a change → **Create an issue**: "Process this new signal"

The issue queue IS the orchestration layer. This means:

1. **One unified data model** — everything is an issue with metadata, following Linear's principle that the issue is the atomic unit of work
2. **One priority system** — signals, hypotheses, and implementation issues compete in the same backlog
3. **Full auditability** — every decision the system makes is traceable as an issue with a parent chain
4. **Human override at any point** — humans can create, modify, or cancel any issue
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
                    │   TRIAGE    │
                    │             │
                    │ Agent picks │
                    │ up "process │
                    │ signal" issue│
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
                    │ into issues │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   EXECUTE   │
                    │             │
                    │ Agent picks │
                    │ up impl     │
                    │ issues, code│
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
2. **Triage issue created**: `[signal] PostHog: sign-up conversion -12% (24h)` — lands in Triage inbox
3. **Agent triages**: Reads the PostHog data, checks recent deployments, git log, error rates. Decides: accept (real problem) or decline (noise). Produces a structured analysis.
4. **Hypothesis issue created**: `[hypothesis] Recent auth flow change (PR #847) likely caused conversion drop — new OAuth redirect adds friction`
5. **Plan issue created**: `[plan] Revert OAuth redirect change OR add loading state to reduce perceived latency`
6. **Implementation sub-issues created**:
   - `Add loading spinner to OAuth redirect page`
   - `Add PostHog event tracking to measure redirect latency`
   - `Create monitoring rule: alert if conversion drops >5% in 12h`
7. **Agent executes**: Picks up issues, writes code, creates PRs, CI passes, auto-merges, deploys
8. **Monitor**: The monitoring rule watches PostHog for the next 48 hours
9. **New signal**: "Sign-up conversion rate recovered to baseline +2%"
10. **Hypothesis validated**: System marks the hypothesis as confirmed, closes the loop

The entire chain is visible as linked issues. Every agent session is recorded. Every decision is auditable.

---

## Principles (Inspired by the Linear Method)

Torq adopts and extends several principles from the Linear Method — practices that Linear developed for human teams, adapted for autonomous agent execution.

### 1. Build for the Loop, Not the Sprint

Linear says "generate momentum, don't sprint." Torq takes this further: the system doesn't operate in artificial time-boxes imposed by humans. Instead, it runs continuously. Cycles exist as **observation windows** — fixed periods for measuring loop velocity, hypothesis hit rates, and agent efficiency — not as planning rituals.

### 2. Write Issues, Not User Stories

Following Linear's stance: issues should be concrete and actionable. "As a user, I want..." templates obscure the actual work. Torq issues describe the problem or action directly:

- Good: `Fix OAuth redirect showing blank page for 1.5-3s`
- Bad: `As a user, I want a faster sign-in experience so that I don't abandon the flow`

When agents generate issues from hypotheses, they're trained to write concrete, scoped descriptions — not user stories.

### 3. Scope Issues Small

Every issue should be completable in a single agent session. If an agent can't finish an issue in one session, the issue was too big. The planning step should decompose hypotheses into sub-issues that are each independently shippable. This is Linear's "scope projects down" principle applied at the issue level.

### 4. Triage Is Signal Processing

Linear's Triage system — an opt-in inbox where incoming issues land before being accepted into the backlog — maps perfectly to signal processing. In Torq, every incoming signal creates an issue in the Triage state. An agent processes the triage queue: accepting real problems, declining noise, deduplicating duplicates, and snoozing items that need more data.

### 5. Say No to Busy Work

Not every signal deserves a hypothesis. Not every hypothesis deserves a plan. The system should actively prune: auto-close stale triage issues, auto-archive low-confidence hypotheses that haven't been validated within a cycle, and keep backlogs manageable. Linear's principle of maintaining clean backlogs applies to autonomous systems even more than human ones — agents are cheap, but context pollution degrades their output quality.

### 6. Decide and Move On

Linear emphasizes making decisions with incomplete information rather than over-analyzing. The autonomous loop embodies this: agents form hypotheses at 0.6-0.8 confidence, ship small fixes, and measure outcomes. The system learns from outcomes rather than trying to be right upfront. This is the scientific method applied to software: form hypothesis, test, measure, iterate.

### 7. Build in Public

Every agent action is logged. Every hypothesis is traceable to signals. Every outcome is measured. The system generates changelogs that explain not just _what_ changed but _why_ — tracing back to the signal that triggered the work. This radical transparency is both a debugging tool and a trust-building mechanism.

---

## Domain Model

The domain model borrows heavily from Linear's entity hierarchy — the most well-designed issue tracker in production. Linear's model has been refined over years of real-world use with hundreds of thousands of teams. We adapt it for autonomous agent execution while preserving the structural clarity.

### Entity Hierarchy

```
Workspace
├── Teams
│   ├── WorkflowStates (per-team, customizable, 6 type categories)
│   ├── Cycles (per-team observation windows)
│   ├── Labels (per-team, inheritable from workspace)
│   └── Issues (the atomic unit)
│       ├── Sub-Issues (recursive, via parentId)
│       ├── Comments (threaded)
│       ├── Attachments (external links, files)
│       ├── IssueRelations (blocks/blocked/related/duplicate)
│       └── AgentSessions (execution records)
├── Projects (cross-team, time-bound deliverables)
│   ├── ProjectMilestones
│   └── ProjectUpdates (health reports)
├── Initiatives (workspace-level strategic goals)
│   ├── Sub-Initiatives (nested, up to 5 levels)
│   └── Projects (many-to-many)
├── Signals (ingested external data)
├── Hypotheses (causal beliefs with validation criteria)
├── Customers (signal source entities)
│   └── CustomerRequests (feedback linked to issues)
└── CustomViews (saved filters)
```

### Structural Rules (Borrowed from Linear)

- An Issue **must** belong to exactly one Team
- An Issue belongs to **at most one Project** (not multiple)
- An Issue belongs to **at most one Cycle**
- An Issue can have **at most one parent** Issue (sub-issue relationship)
- Projects can span **multiple Teams**
- Initiatives are **workspace-level** and contain Projects
- WorkflowStates are **per-team** — each team defines its own state machine

### Issue

The atomic unit. Everything in the system is an issue — signals to process, hypotheses to validate, plans to execute, bugs to fix. Borrows Linear's field structure with extensions for autonomous execution.

```
Issue {
  // Identity (Linear pattern)
  id:               UUID
  number:           Int               // Sequential per-team, immutable
  identifier:       String            // "{TEAM_KEY}-{NUMBER}" e.g., "ENG-142"
  title:            String
  description:      Text              // Markdown

  // Classification
  type:             signal | hypothesis | plan | task | bug | feature | improvement | monitor
  priority:         Int               // 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low (Linear encoding)
  estimate:         Float?            // Team-configurable scale (fibonacci, linear, t-shirt, etc.)
  sortOrder:        Float             // Manual ordering within views

  // Workflow (Linear pattern: per-team states with 6 type categories)
  teamId:           UUID              // Required — owning team
  stateId:          UUID              // Required — current WorkflowState
  assigneeId:       UUID?             // User or Agent

  // Hierarchy
  parentId:         UUID?             // Sub-issue relationship
  projectId:        UUID?             // At most one Project
  cycleId:          UUID?             // At most one Cycle
  labelIds:         [UUID]            // Many-to-many

  // Agent execution (Torq extension)
  sessions:         [AgentSession]    // All agent sessions that worked on this issue

  // Autonomous loop metadata (Torq extension)
  signalId:         UUID?             // Present when type = "signal" — links to Signal record
  hypothesisId:     UUID?             // Present when type = "hypothesis" — links to Hypothesis record

  // Lifecycle timestamps (Linear pattern)
  createdAt:        DateTime
  updatedAt:        DateTime
  startedAt:        DateTime?         // Auto-set when moved to Started category
  completedAt:      DateTime?         // Auto-set when moved to Completed category
  canceledAt:       DateTime?         // Auto-set when moved to Canceled category
  archivedAt:       DateTime?
  dueDate:          Date?
  snoozedUntilAt:   DateTime?         // Triage snooze (Linear pattern)
}
```

### WorkflowState (Per-Team State Machine)

Directly borrowed from Linear. Each team defines custom named states, but every state maps to one of six fixed type categories. This gives teams flexibility while keeping the system's behavior predictable.

```
WorkflowState {
  id:           UUID
  name:         String              // Team-defined, e.g., "In Review", "Awaiting Deploy"
  type:         triage | backlog | unstarted | started | completed | canceled
  color:        String              // Hex color
  position:     Float               // Ordering within category
  teamId:       UUID
}
```

**Type categories and their autonomous loop roles:**

| Type        | Human meaning                     | Autonomous loop role                                        |
| ----------- | --------------------------------- | ----------------------------------------------------------- |
| `triage`    | Inbox, excluded from normal views | **Signal processing queue** — signals land here             |
| `backlog`   | Accepted, not yet prioritized     | Issues accepted from triage, awaiting cycle planning        |
| `unstarted` | Ready to work on                  | Queued for agent dispatch                                   |
| `started`   | In progress                       | Agent session active                                        |
| `completed` | Done                              | Work shipped, monitoring may follow                         |
| `canceled`  | Rejected/closed                   | Signal was noise, hypothesis invalidated, or issue obsolete |

**Default progression:**

```
[Signal arrives] → Triage → Backlog → Unstarted → Started → Completed
                                                           ↘ Canceled
```

**Triage behavior (adapted from Linear):**

- Signals create issues in the Triage state
- Agent processes triage queue: Accept (→ Backlog), Decline (→ Canceled), Duplicate (→ Canceled + link), or Snooze (revisit later)
- Triage issues are excluded from cycle views and backlogs by default

### Team

The primary organizational unit. Every issue belongs to exactly one team. Teams define their own workflow states, cycle cadence, and estimation approach.

```
Team {
  id:                UUID
  name:              String
  key:               String           // Short identifier, e.g., "ENG", "INFRA"
  description:       String?

  // Configuration (Linear pattern)
  cyclesEnabled:     Boolean
  triageEnabled:     Boolean
  estimateType:      notUsed | exponential | fibonacci | linear | tShirt
  autoArchivePeriod: Float?           // Days after completion before auto-archive
  autoClosePeriod:   Float?           // Days before auto-close stale issues
}
```

For a solo developer or small team, you might have a single team. For larger organizations, teams map to functional areas (Frontend, Backend, Infrastructure, etc.) — each with their own triage queue, workflow states, and cycle cadence.

### Project

Cross-team, time-bound deliverables. A project groups issues from one or more teams toward a specific goal. Borrowed directly from Linear.

```
Project {
  id:           UUID
  name:         String
  description:  Text?               // Markdown — the project spec (Linear recommends brief specs)

  // Status (Linear's 6 categories)
  state:        backlog | planned | started | paused | completed | canceled
  health:       onTrack | atRisk | offTrack    // Manually set or auto-derived
  progress:     Float               // 0.0 to 1.0, auto-calculated from issue completion

  // Timeline
  startDate:    Date?
  targetDate:   Date?
  completedAt:  DateTime?

  // Ownership
  leadId:       UUID?               // Project lead (User or Agent)

  // Hierarchy
  initiativeId: UUID?               // Parent initiative (via join table for many-to-many)
}
```

### Cycle

Per-team observation windows. Unlike traditional sprints, Torq cycles don't dictate _when_ work happens — agents work continuously. Cycles provide **measurement boundaries**: how much was accomplished, what was the hypothesis hit rate, how efficient were the agents.

```
Cycle {
  id:           UUID
  number:       Int                 // Sequential per team
  name:         String?
  startsAt:     DateTime
  endsAt:       DateTime
  teamId:       UUID
  progress:     Float               // 0.0 to 1.0

  // Metrics (Linear pattern: daily snapshots)
  scopeHistory:              [Float]  // Total scope points over time
  completedScopeHistory:     [Float]  // Completed scope over time
  issueCountHistory:         [Int]    // Total issue count over time
  completedIssueCountHistory:[Int]    // Completed issue count over time

  // Torq extensions
  hypothesisHitRate:         Float?   // % of hypotheses validated in this cycle
  loopVelocity:              Float?   // Avg time from signal → validated outcome
  agentEfficiency:           Float?   // Useful output per token spent
}
```

Incomplete issues auto-roll to the next cycle (Linear's default behavior). The cycle serves as a retrospective boundary — "what did the loop accomplish this period?"

### Initiative

Workspace-level strategic goals. Initiatives contain projects and can be nested up to 5 levels deep.

```
Initiative {
  id:                  UUID
  name:                String
  description:         Text?
  health:              onTrack | atRisk | offTrack
  status:              String?
  targetDate:          Date?
  leadId:              UUID?
  parentInitiativeId:  UUID?         // Nested initiatives (up to 5 levels)
}
```

Initiatives represent "what we're trying to achieve" — the strategic context that helps agents make good decisions about what to work on next. Without initiatives, agents optimize locally (fix the latest bug). With initiatives, they optimize toward goals (improve onboarding conversion).

### Signal

A signal is any piece of information that enters the system from the outside world. Every signal creates a triage issue.

```
Signal {
  id:             UUID
  source:         String             // "posthog", "feedback-widget", "agent", "github", "sentry", "custom"
  sourceId:       String?            // External reference (PostHog event ID, PR number, etc.)
  type:           String             // "metric-change", "user-feedback", "error-spike", "deployment", etc.
  severity:       low | medium | high | critical
  payload:        JSONB              // Raw signal data, source-specific

  issueId:        UUID               // The triage issue created for this signal
  processedAt:    DateTime?          // Null until an agent processes it

  createdAt:      DateTime
}
```

**Built-in signal sources:**

| Source                   | How it connects                     | What it produces                                               |
| ------------------------ | ----------------------------------- | -------------------------------------------------------------- |
| **PostHog**              | Webhook integration                 | Metric changes, funnel drops, feature adoption data            |
| **User Feedback Widget** | Embeddable JS widget + API endpoint | Bug reports, feature requests, friction reports                |
| **Agent Reports**        | MCP tool / CLI command              | Session summaries, encountered issues, improvement suggestions |
| **Git Events**           | GitHub/GitLab webhooks              | PR merges, CI failures, deployment events                      |
| **Error Tracking**       | Sentry/similar webhook              | Error spikes, new error classes, regression detection          |
| **Custom**               | REST API endpoint                   | Anything — Slack messages, support tickets, custom metrics     |

### Hypothesis

A structured belief about cause and effect, generated by an agent from signal analysis. Always linked to an issue of type "hypothesis."

```
Hypothesis {
  id:                   UUID
  issueId:              UUID            // The issue of type "hypothesis"
  signalIds:            [UUID]          // Signals that informed this hypothesis

  statement:            String          // "OAuth redirect change caused conversion drop"
  evidence:             [Evidence]      // Supporting data points
  confidence:           Float           // 0.0–1.0, agent's assessment

  prediction:           String          // "Reverting/fixing will restore conversion to baseline"
  validationCriteria:   String          // "Conversion rate returns to >3.2% within 48h"
  validationSignalSource: String?       // What to watch

  status:               proposed | testing | validated | invalidated | inconclusive
  outcome:              Text?           // What actually happened

  createdAt:            DateTime
  resolvedAt:           DateTime?
}
```

### AgentSession

Every time an agent works on an issue, the full session is recorded and linked. Mirrors Linear's `AgentSession` entity.

```
AgentSession {
  id:               UUID
  issueId:          UUID

  // Execution context
  model:            String            // "claude-opus-4-6", "claude-sonnet-4-5", etc.
  cwd:              String            // Working directory
  permissionMode:   String            // "acceptEdits", "bypassPermissions", etc.

  // Results
  status:           running | completed | failed | cancelled
  summary:          Text?             // Agent-generated summary
  tokensUsed:       Int?
  costUsd:          Float?
  durationMs:       Int?

  // Artifacts
  commits:          [Commit]
  pullRequests:     [PR]
  filesModified:    [String]

  // DorkOS integration
  dorkosSessionId:  String?           // Session ID in connected DorkOS instance
  transcriptPath:   String?           // Path to full JSONL transcript

  startedAt:        DateTime
  finishedAt:       DateTime?
}
```

### IssueRelation

Directional links between issues. Borrowed directly from Linear.

```
IssueRelation {
  id:              UUID
  type:            blocks | blocked | related | duplicate
  issueId:         UUID              // Source issue
  relatedIssueId:  UUID              // Target issue
}
```

The `blocks`/`blocked` relation is critical for the autonomous loop — agents should not pick up blocked issues. The `duplicate` relation feeds into signal deduplication.

### Comment

Threaded comments on issues, used by both humans and agents.

```
Comment {
  id:             UUID
  body:           Text               // Markdown
  issueId:        UUID
  userId:         UUID               // Author (human or agent user)
  parentId:       UUID?              // For threaded replies
  createdAt:      DateTime
}
```

Agents use comments to report progress, ask questions, and document findings. This keeps the issue's description clean while building a narrative of the work.

### Customer & CustomerRequest

Maps to Linear's "Asks" feature. Customers represent external stakeholders whose feedback creates signals.

```
Customer {
  id:       UUID
  name:     String
  domain:   String?
  revenue:  Float?
  size:     Int?
  tier:     String?
}

CustomerRequest {
  id:          UUID
  body:        Text
  priority:    Int
  issueId:     UUID            // Links feedback to an issue
  customerId:  UUID
  createdAt:   DateTime
}
```

When user feedback comes through the widget, the system can match it to a Customer record and weight the signal by customer tier/revenue. Enterprise customers reporting a bug is a higher-severity signal than a free-tier user reporting the same bug.

### Label

Hierarchical labels for categorization. Labels are per-team or workspace-level.

```
Label {
  id:        UUID
  name:      String
  color:     String             // Hex
  teamId:    UUID?              // Null = workspace-level
  parentId:  UUID?              // Label groups
}
```

The autonomous loop uses labels to categorize issues by signal source, hypothesis confidence level, and automation status (e.g., `auto-generated`, `auto-merged`, `needs-human-review`).

### Entity Relationship Summary

```
Workspace (1)
  └─ Teams (N)
       ├─ WorkflowStates (N)          [per-team state machine]
       ├─ Cycles (N)                   [per-team observation windows]
       ├─ Labels (N)                   [per-team or workspace]
       └─ Issues (N)                   [atomic unit, identified by TEAM-NUMBER]
            ├─ Sub-Issues (N)          [parentId → Issue.id, recursive]
            ├─ Comments (N)            [threaded]
            ├─ Attachments (N)
            ├─ IssueRelations (N)      [blocks/blocked/related/duplicate]
            └─ AgentSessions (N)       [execution records]

Projects (N)                           [cross-team deliverables]
  ├─ ProjectMilestones (N)
  ├─ ProjectUpdates (N)
  └─ Issues (N)                        [Issue.projectId FK, one project per issue]

Initiatives (N)                        [workspace-level goals]
  ├─ Sub-Initiatives (N)               [up to 5 levels deep]
  └─ Projects (N via join table)       [many-to-many]

Signals (N)                            [external data → triage issues]
Hypotheses (N)                         [linked to hypothesis issues]
Customers (N)                          [CRM entities]
  └─ CustomerRequests (N)              [feedback → issues]
```

**Key cardinalities:**

| Relationship              | Cardinality    |
| ------------------------- | -------------- |
| Issue → Team              | N:1 (required) |
| Issue → WorkflowState     | N:1 (required) |
| Issue → Project           | N:1 (optional) |
| Issue → Cycle             | N:1 (optional) |
| Issue → Parent Issue      | N:1 (optional) |
| Issue → Labels            | N:M            |
| Issue → Assignee          | N:1 (optional) |
| Issue → AgentSessions     | 1:N            |
| Issue → IssueRelations    | 1:N            |
| Project → Teams           | N:M            |
| Project → Milestones      | 1:N            |
| Initiative → Projects     | N:M            |
| Initiative → Parent Init. | N:1 (optional) |
| Signal → Issue            | 1:1            |
| Hypothesis → Issue        | 1:1            |
| Hypothesis → Signals      | N:M            |

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
  │  { content: "issue prompt + context" }│
  │──────────────────────────────────────→│
  │  SSE stream (text_delta, tool_call,   │
  │  approval_required, done, etc.)       │
  │←──────────────────────────────────────│
  │                                       │
  │  (accumulate results, store session)  │
  │                                       │
```

### What Torq sends as the issue prompt

When dispatching an issue to an agent via DorkOS, Torq constructs a rich prompt:

```
=== TORQ CONTEXT ===
Issue: ENG-142 — Add loading spinner to OAuth redirect page
Type: task
Priority: 2 (High)
Project: Improve onboarding flow
Cycle: 2026-W08

Parent chain:
  - ENG-140 [plan] Revert or fix OAuth redirect friction
  - ENG-138 [hypothesis] OAuth redirect change caused conversion drop (confidence: 0.82)
  - ENG-135 [signal] PostHog: sign-up conversion -12% (24h)

Related issues:
  - ENG-143: Add PostHog event tracking to redirect latency
  - ENG-144: Create monitoring rule for conversion drops

Blocked by: (none)
Blocking: ENG-145 (deploy monitoring dashboard)

Repository: github.com/acme/webapp
Branch strategy: Create feature branch from main

Requirements:
When you complete this issue, report back with:
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

| Tool                  | Purpose                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `torq_get_issue`      | Read issue details, parent chain, related issues                   |
| `torq_update_issue`   | Update status, add comments, attach artifacts                      |
| `torq_create_issue`   | Create sub-issues or follow-up work                                |
| `torq_submit_signal`  | Report a signal (agent-discovered issue, improvement idea)         |
| `torq_get_context`    | Get project/cycle/initiative context                               |
| `torq_attach_session` | Link the current DorkOS session to the issue                       |
| `torq_log_commit`     | Attach a git commit to the issue                                   |
| `torq_log_pr`         | Attach a PR to the issue                                           |
| `torq_list_issues`    | Query issues with filters (status, priority, team, project, cycle) |
| `torq_get_relations`  | Get blocking/blocked-by chains for dependency awareness            |

This means agents working through DorkOS can read their full context and report back results without any human intermediary.

---

## Architecture

### Cloud-First Design

Torq runs as a cloud service with public endpoints, enabling:

- Webhooks from PostHog, GitHub, Sentry, etc.
- The feedback widget to POST from any website
- Multiple DorkOS instances to connect as agent backends
- Multiple team members to access the dashboard
- Agents to query issue state from any environment

### Tech Stack

| Layer          | Technology                             | Rationale                                                             |
| -------------- | -------------------------------------- | --------------------------------------------------------------------- |
| **API**        | Node.js + Hono (or Express)            | Fast, TypeScript-native, excellent middleware ecosystem               |
| **Database**   | PostgreSQL + Drizzle ORM               | Relational integrity for issue hierarchies, JSONB for signal payloads |
| **Queue**      | pg-boss (Postgres-backed)              | No separate Redis/RabbitMQ needed; transactional job creation         |
| **Auth**       | Better Auth or Clerk                   | Team management, API keys for integrations                            |
| **Frontend**   | React 19 + Vite + Tailwind + shadcn/ui | Consistent with DorkOS ecosystem                                      |
| **Real-time**  | Server-Sent Events                     | Dashboard updates, agent session streaming                            |
| **CLI**        | Node.js binary                         | `torq` command for local interaction                                  |
| **MCP Server** | @anthropic-ai/claude-agent-sdk         | In-process MCP for agent tool access                                  |

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
│  │  teams   │ projects│ cycles  │ labels  │                      │
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

The queue is the heartbeat of the system. Workers process issues in priority order:

| Worker            | Trigger                             | Action                                                         |
| ----------------- | ----------------------------------- | -------------------------------------------------------------- |
| `signal-ingest`   | New signal received via API/webhook | Validate, deduplicate, create triage issue                     |
| `triage-process`  | Triage issue assigned to agent      | Dispatch to DorkOS, collect analysis, accept/decline/snooze    |
| `hypothesis-plan` | Hypothesis issue accepted           | Dispatch to DorkOS, agent creates plan + sub-issues            |
| `issue-dispatch`  | Issue moves to `unstarted` state    | Dispatch to DorkOS, agent executes, reports back               |
| `monitor-check`   | Monitoring issue scheduled check    | Query signal sources, evaluate validation criteria             |
| `session-sync`    | Agent session completes             | Sync results back to issue (commits, PRs, summary)             |
| `auto-merge`      | PR passes CI                        | Merge PR, update issue status, trigger deployment              |
| `cycle-roll`      | Cycle ends                          | Roll incomplete issues to next cycle, calculate metrics        |
| `retention`       | Scheduled (daily)                   | Archive old signals, prune stale backlog per `autoClosePeriod` |

---

## The CLI

```bash
# View and manage issues
torq list                          # List issues in current cycle
torq list --team ENG               # Filter by team
torq list --state started          # Filter by workflow state
torq show ENG-142                  # Show issue details with full context chain
torq create "Fix login timeout"    # Create a new issue
torq assign ENG-142 agent         # Assign to agent for autonomous execution

# Signal management
torq signals                       # List recent signals
torq signals --source posthog      # Filter by source
torq signal "Users reporting slow checkout"  # Submit a manual signal

# Hypothesis tracking
torq hypotheses                    # List active hypotheses
torq hypotheses --status testing   # Filter by status

# Agent interaction
torq dispatch ENG-142              # Manually dispatch an issue to an agent
torq sessions                      # List recent agent sessions
torq session abc123 --transcript   # View full agent transcript

# Triage
torq triage                        # Show triage queue
torq triage accept ENG-150         # Accept triage item into backlog
torq triage decline ENG-151        # Decline (noise)

# Projects and cycles
torq projects                      # List active projects
torq cycles                        # List current and upcoming cycles
torq cycle --metrics               # Show current cycle metrics

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
<script
  src="https://torq.example.com/widget.js"
  data-project="your-project-id"
  data-position="bottom-right"
></script>
```

Features:

- Feedback types: bug report, feature request, friction report, general feedback
- Optional screenshot capture
- Optional session replay link (PostHog integration)
- Customizable appearance (matches host site's theme)
- Minimal bundle size (<5KB gzipped)
- Works on any website (React, Vue, vanilla, etc.)

Each feedback submission becomes a signal → which creates a triage issue → which an agent processes and routes to the appropriate team/project.

---

## Competitive Positioning

### What exists today

| Product                          | What it does                                        | What's missing                                                         |
| -------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| **Linear**                       | Best-in-class issue tracker + AI triage + MCP       | No autonomous execution loop, no signal ingestion, no hypothesis layer |
| **Devin**                        | Autonomous coding agent ($20/mo, 67% PR merge rate) | No PM layer, no feedback loop, no signal processing, no issue tracking |
| **Factory.ai**                   | Full SDLC agent fleet ("Droids")                    | Closed-source, enterprise-only, no built-in PM, no feedback loop       |
| **GitHub Copilot Workspace**     | AI-assisted coding in IDE                           | IDE-bound, no autonomous loop, no signal processing                    |
| **Height** (shut down Sept 2025) | Autonomous project collaboration                    | Attempted this space, failed commercially. Market gap still open.      |

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

Torq occupies the unique intersection: **Linear-quality issue tracking + autonomous agent execution + closed feedback loop**. No existing product covers all three.

### Differentiation

1. **The loop is the product.** Not just task management. Not just agent execution. The feedback loop that connects outcomes back to decisions.
2. **Linear's domain model, extended for autonomy.** The battle-tested entity hierarchy (Workspace → Teams → Issues, Projects, Cycles, Initiatives) provides the structural backbone. Torq extends it with Signals, Hypotheses, and AgentSessions.
3. **Everything is an issue.** No separate workflow engine. The issue queue is the orchestration layer. Simple to understand, debug, and extend.
4. **Open source.** MIT licensed. No vendor lock-in. Community-driven signal source integrations.
5. **DorkOS-native.** First-class integration with the DorkOS agent execution platform, with a clear adapter interface for future agent backends.
6. **Scientific method, systematized.** Hypotheses are first-class objects with validation criteria, confidence levels, and outcome tracking.
7. **Triage as signal processing.** Linear's triage system — the best inbox pattern in PM tools — repurposed as the front door for all external signals.

---

## Naming Candidates

The product name should evoke continuous improvement, feedback loops, and mechanical/systematic momentum.

| Name        | Metaphor                              | CLI       | Rationale                                                                          |
| ----------- | ------------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| **Torq**    | Rotational force driving a flywheel   | `torq`    | Each cycle adds force; the system compounds momentum. 1 syllable, unique spelling. |
| **Ratchet** | Forward-only mechanism                | `ratchet` | Gains lock in, no regression. Each click is permanent improvement.                 |
| **Sigma**   | Continuous improvement + signal/noise | `sigma`   | Six Sigma = DMAIC loop. Sigma = signal analysis. Triple meaning.                   |
| **Keel**    | Structural spine keeping course       | `keel`    | Directional stability with continuous correction. Kubernetes/Helm family.          |
| **Arc**     | Trajectory + electric discharge       | `arc`     | Improvement arcs upward. Energy arcs between signals and actions.                  |

Additional candidates:

- **Kaizen** (Japanese for "continuous improvement" — direct, but 3 syllables)
- **Kata** (Toyota Kata — the practice of improvement, 2 syllables)
- **Gyre** (a spiral motion — literary, distinctive)

---

## Roadmap

### Phase 1: Foundation

- PostgreSQL schema + Drizzle ORM setup (full domain model: teams, issues, workflow states, projects, cycles, labels, relations)
- Core issue CRUD with Linear-style identifier system (TEAM-NUMBER)
- Per-team workflow states with 6 type categories
- Triage inbox and signal ingestion API (generic webhook endpoint)
- DorkOS integration (create session, send message, collect results)
- CLI (basic issue management + DorkOS dispatch)
- Web dashboard (issue list, detail view, triage queue)

### Phase 2: The Loop

- Signal processing worker (agent triages signals via DorkOS)
- Hypothesis creation and tracking
- Plan generation (agent breaks hypotheses into sub-issues)
- Issue auto-dispatch (priority queue → agent assignment, respecting blocks/blocked relations)
- AgentSession recording and linking (full audit trail)
- PostHog webhook integration
- GitHub webhook integration (PRs, CI, deployments)
- Auto-merge pipeline
- Kanban board view (by workflow state)

### Phase 3: Intelligence

- Monitoring rules (watch signal sources for validation criteria)
- Hypothesis validation/invalidation automation
- Confidence scoring (which signal sources produce actionable hypotheses?)
- Pattern recognition (recurring signal types → automated responses)
- Feedback widget (embeddable JS)
- Sentry integration
- Cycle metrics dashboard (loop velocity, hypothesis hit rate, agent efficiency)
- Customer/CustomerRequest entities for weighted signal prioritization

### Phase 4: Team & Scale

- Multi-user auth and team management
- Role-based access (who can approve auto-merges, adjust autonomy levels)
- Multiple DorkOS instance support
- Initiative hierarchy (workspace-level strategic goals with nested sub-initiatives)
- Project milestones and health updates
- Custom views (saved filters, personal/team/workspace scoped)
- Reporting and analytics
- MCP server for external agent access

---

## Open Questions

1. **Agent backend abstraction**: How generic should the agent dispatch interface be in v1? DorkOS-specific with a clean adapter boundary, or fully abstract from day one?

2. **Hypothesis confidence calibration**: How do we calibrate the confidence scores over time? Track prediction accuracy per signal source? Per agent model?

3. **Autonomy guardrails**: What guardrails prevent the system from auto-merging something destructive? CI is necessary but not sufficient. Should there be a "blast radius" estimate per PR?

4. **Multi-repo support**: Should v1 support dispatching work across multiple repositories, or start with single-repo?

5. **Cost management**: With fully autonomous execution, API costs could spike. Should there be per-cycle cost budgets? Per-issue cost limits?

6. **Signal deduplication**: How aggressively should we deduplicate signals? A user reporting the same bug 10 times is valuable information (severity signal), not noise.

7. **Relationship to DorkOS Pulse**: Torq's issue dispatch is conceptually similar to Pulse's cron-based scheduling. Should Torq replace Pulse, extend it, or operate independently?

8. **Linear interop**: Should Torq support syncing with Linear as an alternative to its built-in issue tracker? Some teams may want Linear for human work and Torq for the autonomous loop.

---

## Why Now

Three things converged to make this possible:

1. **Agent capability**: Claude Opus 4, Sonnet 4.5, and competitors can now reliably write, test, and ship code autonomously. The 67% PR merge rate that Devin reports is real and improving.

2. **MCP standardization**: The Model Context Protocol (donated to Linux Foundation, backed by Anthropic, OpenAI, Google, Microsoft) means tools can expose capabilities to any agent. A Torq MCP server works with any MCP-compatible agent, not just DorkOS.

3. **The Height-shaped hole**: Height proved the market wants autonomous project management but couldn't make it work commercially. The open-source model (no revenue pressure, community contributions) may be the right approach for infrastructure this foundational.

The question isn't whether AI agents will manage their own work. It's whether the feedback loop that guides them will be built intentionally — with hypotheses, validation, and scientific rigor — or whether it'll be a mess of cron jobs, Slack notifications, and human intuition.

Torq is the intentional version.

---

## Additional Ideas

1. **"Loop velocity" as a key metric**: How fast does the system go from signal → hypothesis → plan → execution → validated outcome? This is the equivalent of "cycle time" but for the entire feedback loop.

2. **Agent specialization / model routing**: Signal processing → Haiku (fast, cheap). Hypothesis generation → Opus (deep reasoning). Implementation → Claude Code (full tools). The dispatch layer should support model routing per issue type.

3. **"Hypothesis hit rate" as meta-learning**: Track what percentage of hypotheses are validated vs. invalidated. Over time, the system learns which signal patterns produce accurate hypotheses. This is the loop improving the loop.

4. **Observability-native design**: Borrow OpenTelemetry vocabulary. Each agent session is a "trace." Each tool call is a "span." Native compatibility with Grafana, Datadog, etc.

5. **"Friction reports" as a signal type**: The feedback widget shouldn't just collect bug reports. "This was confusing" or "I expected X but got Y" are the most valuable signal type — they reveal UX issues before they become churn.

6. **Changelog generation from the loop**: Since every shipped change traces back to a signal → hypothesis → plan chain, the system can auto-generate changelogs that explain _why_ — "Fixed OAuth redirect latency (detected via 12% conversion drop signal)."

7. **Linear Method automated**: The principles Linear designed for human teams — work in cycles, scope issues small, measure with code not status updates, keep backlogs clean — are even more powerful when enforced by the system itself rather than relying on human discipline.

8. **Linear sync**: For teams already using Linear, Torq could sync as a "shadow" system — mirroring Linear's issues into Torq's domain model, adding the autonomous loop layer on top, and syncing results back. This reduces adoption friction: teams don't have to abandon their existing tools.
