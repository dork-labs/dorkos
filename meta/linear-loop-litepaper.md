# Linear Loop: Closing the Feedback Loop with Linear and Claude Code

**By Dorian Collier**
**March 2026**

---

## The Gap

We have all the pieces. AI coding agents that can write, test, and ship code autonomously. Linear for tracking what needs to be done. A mature spec workflow for designing and implementing features. DorkOS for scheduling, messaging, and coordinating agents.

But we're still the bottleneck.

Today's workflow:

```
Human has idea → Human writes spec → Agent implements → Ship → ???
```

The "???" is where everything falls apart. After shipping:

- Nobody checks if the fix actually worked
- Nobody synthesizes user feedback into what to do next
- Nobody decides the next priority based on what we just learned
- Nobody connects the outcome back to the original hypothesis

We have powerful tools at every stage, but no system that connects them into a continuous loop. The product strategy still lives in our heads, running once a week at best — usually in a shower epiphany.

The Loop litepaper described the solution: an autonomous product engine that turns ideas into hypotheses, hypotheses into tasks, tasks into outcomes, and outcomes into new learning. Loop is a standalone product — a fully deterministic data system with its own database, API, and instruction layer.

But we already have a database. It's called Linear. And we already have an execution layer. It's called Claude Code. And we already have scheduling, messaging, and agent coordination. It's called DorkOS.

We don't need another product. We need to connect the ones we have.

---

## Linear Loop: The Implementation

Linear Loop is the Loop methodology implemented inside the tools we already use. No new server. No new database. No new infrastructure. Just skills, commands, and conventions that turn Linear + Claude Code + DorkOS into a self-improving product engine.

**Linear** is the data store. Issues are the orchestration layer. Projects carry goals. Labels encode issue types. Relations express dependencies. Comments carry agent reasoning. The issue queue IS the loop.

**Claude Code** is the intelligence. Skills provide methodology. Slash commands provide the interface. Subagents provide autonomous execution. The agent does the thinking — triage, research, planning, monitoring — guided by instruction templates that improve over time.

**DorkOS** is the infrastructure. Pulse schedules the loop cadence. Relay delivers notifications and approval requests. Mesh coordinates multi-agent execution.

**The spec workflow** is the implementation layer. When work is complex enough to need design, `/pm` bridges into `/ideate` → `/spec:create` → `/spec:decompose` → `/spec:execute`. Specs get a `linear-issue: DOR-NNN` frontmatter field and a `linearIssue` entry in `specs/manifest.json` for traceability. When work is simple, it stays as Linear sub-issues. Either way, `/linear:done` reports outcomes back to Linear and creates monitoring issues. The loop closes.

---

## Everything Is an Issue

The core insight from the Loop litepaper applies directly: a product engine doesn't need a complex orchestration system. Everything is an issue.

- Someone has an idea → **create an issue**: `type/idea`
- An agent researches the idea → **create an issue**: `type/research`
- Research validates the opportunity → **create an issue**: `type/hypothesis`
- The hypothesis is decomposed → **create issues**: `type/task` (simple) or invoke the spec workflow (complex)
- Tasks are completed → **create an issue**: `type/monitor`
- Monitoring detects a change → the change is a new signal → `type/signal` → the loop continues

One unified system. One priority queue. Full auditability. Human override at any point.

### The Label Taxonomy

Linear's built-in workflow states handle lifecycle (Triage → Backlog → Todo → In Progress → Done). Labels handle the Loop methodology:

**Issue types** — `type/idea`, `type/research`, `type/hypothesis`, `type/task`, `type/monitor`, `type/signal`, `type/meta`

**Agent state** — `agent/ready`, `agent/claimed`, `agent/completed`, `needs-input`

**Origin** — `origin/human`, `origin/agent`, `origin/signal`

**Confidence** — `confidence/high`, `confidence/medium`, `confidence/low`

These labels are the semantic backbone. An agent querying for the next work item filters by `agent/ready`. A triage agent looks at items in the Triage workflow state. A monitor agent filters by `type/monitor`. When `/pm auto` hits ambiguity, it adds `needs-input` and assigns the issue to the human — Linear sends a notification, and the next `/pm` run picks up the response. No custom infrastructure needed — just labels and queries.

---

## Two Layers: Strategy and Implementation

Linear Loop operates at the **product strategy** level. The spec workflow operates at the **implementation** level. They connect but don't compete.

```
                    LINEAR LOOP (what to build, did it work)
                    ┌──────────────────────────────────────────────┐
                    │                                              │
 Idea → Research → Hypothesis → Plan ──────────────────────┐      │
                                                           │      │
                    SPEC WORKFLOW (how to build it)         │      │
                    ┌──────────────────────────────────┐   │      │
                    │                                  │   │      │
                    │  /ideate ← Linear issue context  │◄──┘      │
                    │    ↓                              │          │
                    │  /ideate-to-spec                  │          │
                    │    ↓                              │          │
                    │  /spec:decompose                  │          │
                    │    ↓                              │          │
                    │  /spec:execute                    │          │
                    │    ↓                              │          │
                    │  /spec:feedback                   │          │
                    │    ↓                              │          │
                    └────┼─────────────────────────────┘          │
                         │                                         │
                    /linear:done → Monitor → Signal ───────────────┘
```

The spec workflow gains what it's always lacked:

- **Upstream**: Where specs come from. Every spec traces to a Linear hypothesis, which traces to research, which traces to an idea or signal. Full provenance.
- **Downstream**: Whether the spec achieved its goal. Monitoring issues track validation criteria. Outcomes feed back as new signals.

The Linear Loop gains what it can't do alone:

- **Implementation depth**: Detailed technical specifications. Phased task decomposition with dependency DAGs. Multi-agent parallel execution. Post-implementation feedback collection.

`/pm` is the bridge. It evaluates complexity and routes: simple work stays as Linear sub-issues, complex work flows through the spec workflow. `/linear:done` is the return path — closing the loop back to Linear regardless of which path was taken.

---

## One Command: `/pm`

You wake up. You don't remember where things stand. You type one thing:

```
/pm
```

The agent discovers your active projects dynamically (filtered by ownership — projects with no lead are in `/pm`'s scope), queries all issues across them, and tells you exactly what needs attention:

> ### Awaiting Your Input
>
> - DOR-45: "Should we use WebSocket or SSE?" (asked 2h ago)
>
> ### Projects
>
> **Linear Loop System** [In Progress]: 2 tasks ready, 1 in triage
> **Console UI** [Planned]: 3 ideas in backlog
>
> ### Needs Attention
>
> 1. Triage the signal in Linear Loop — error spike from last deploy
>
> Fix all auto-fixable issues now? (Y/N)

You say yes. The agent triages. Then it recommends the next action. And the next. Each time, you approve or redirect. The loop advances.

`/pm` is the universal entry point — it handles five modes:

```
/pm                              → Status dashboard, recommend one action, wait for approval
/pm auto                         → Execute up to N actions autonomously (except approval gates)
/pm DOR-47                       → Skip assessment, work on this specific issue directly
/pm audit                        → Workspace health check — labels, statuses, stale issues, orphans
/pm "We should add dark mode"    → Classify input and create appropriate issue(s)
```

The freeform mode accepts any text — ideas, bug reports, product briefs, research questions, even file paths. `/pm` classifies the input, creates the right issue type(s), assigns to the right project, and adds a structured next-steps comment. For richer intake (multi-concern briefs that might span multiple projects), it triggers the `project-creation` approval gate.

The audit mode performs a comprehensive workspace health check: validates label integrity, corrects project statuses, flags stale issues, detects orphans, and cross-references specs with Linear issues. It auto-fixes what it can and asks about the rest.

**Project status awareness.** `/pm` reads and updates project statuses automatically. When an issue is triaged into a Backlog project, it moves to Planned. When work starts, it moves to In Progress. When all issues are Done, it moves to Completed. Completed and Cancelled projects are excluded from the dashboard — they're done.

**Async human-in-the-loop.** When `/pm auto` encounters ambiguity it can't resolve, it doesn't stop. It posts a structured question as a comment on the issue (multiple choice when possible), adds the `needs-input` label, and assigns the issue to you — triggering a Linear notification. Then it skips that issue and continues. On the next `/pm` run, it checks for your response and acts on it.

**Self-documenting issues.** After every action, `/pm` adds a structured next-steps comment: what was done, why, and what should happen next. Anyone (human or agent) can read the last comment to understand current state without re-running `/pm`.

Two companion commands exist for specific entry points:

**`/linear:idea`** — Quick idea capture when inspiration strikes mid-work. Shortcut for `/pm "your idea"`.

**`/linear:done`** — Report completion. An intentional act that closes the loop — and keeps it spinning. After closing an issue, `/linear:done` performs a Project Pulse Check: it assesses the project state and recommends the next Loop phase. If the issue has an `## On Completion` section in its description, that's the primary signal. Otherwise, it applies the Loop Continuity phase transition rules. The Loop never silently stops at a `/linear:done` boundary.

That's it. Three commands. Everything else — triage, planning, research, dispatch, monitoring, status, audit — is handled internally by `/pm`.

---

## One Skill, Many Templates

All Loop knowledge lives in a single Claude Code skill directory with progressive discovery:

```
.claude/skills/linear-loop/
├── SKILL.md                          # Core: Loop methodology, conventions, routing table
├── config.json                       # Repo-specific settings (team, ownership filter, limits)
├── templates/
│   ├── triage-intake.md             # Universal input classifier (freeform → issue)
│   ├── triage-idea.md               # How to evaluate ideas
│   ├── triage-signal.md             # How to evaluate signals (Phase 2)
│   ├── research-market.md           # Market research methodology (Phase 2)
│   ├── research-technical.md        # Technical research methodology (Phase 2)
│   ├── plan-simple.md              # Direct task decomposition
│   ├── plan-complex.md             # Spec workflow bridge
│   ├── monitor-outcome.md          # Outcome validation framework (Phase 2)
│   ├── dispatch-priority.md        # Priority selection algorithm (Phase 2)
│   └── audit-workspace.md          # Workspace health check
└── conventions/
    └── labels.md                    # Label taxonomy reference
```

SKILL.md is always loaded — it provides the Loop methodology overview and label conventions. Templates are loaded **on demand** — when `/pm` decides to triage, only the triage template enters context, not the monitoring framework or the research methodology. This keeps agent context lean and focused.

This is the same progressive discovery pattern used by `executing-specs/` in DorkOS — one skill with supporting files that are read at specific workflow phases. `/pm` acts as the routing layer, loading the right template for whatever action the loop needs.

Templates are git-versioned, grep-searchable, and directly injectable via Claude Code's skill system. They fetch Linear context dynamically at runtime — project goals, issue details, parent chains — via the Linear MCP server. The template logic is static. The context is live.

For other agents, templates can be flattened: Codex CLI supports the identical pattern natively. Cursor and Continue.dev can consume individual template files as rules. Windsurf can ingest a flattened version. The architecture optimizes for Claude Code today with a clear migration path for tomorrow.

---

## The Pull Architecture

Following the Loop litepaper's design, agents pull work from Linear rather than being pushed by webhooks.

On a configurable schedule, Pulse runs `/pm auto` — the exact same command the human uses, just automated. The agent queries Linear, assesses the loop, and takes the highest-priority action. Reports back. Takes the next action. Pauses at approval gates and notifies via Telegram.

This design is deliberately simple:

- **No webhook infrastructure** — no server to expose, no auth to manage
- **Agents stay in control** — they decide when to pull, not when to be interrupted
- **Fault tolerant** — if an agent crashes, the issue stays `agent/ready` for the next poll
- **One command for all modes** — manual (`/pm`), semi-auto (`/pm auto`), and scheduled (Pulse runs `/pm auto`) are the same command with increasing autonomy

Linear webhooks can be added later for real-time signal ingestion. The pull architecture is the foundation; push is an optimization.

---

## Phased Rollout

### Phase 1: Foundation ✓

`/pm` works. Human types one command, sees status, approves the recommended action.

Created the label taxonomy in Linear (17 labels across 4 groups + `needs-input`). Built `/pm` with five modes (status, auto, audit, direct issue, freeform intake), `/linear:idea`, and `/linear:done`. Created the `linear-loop` skill with core conventions, ownership-based filtering, project status awareness, async human-in-the-loop protocol, and next-steps comments. Updated AGENTS.md.

**Delivered**: `/pm` shows the loop dashboard, recommends actions, executes on approval. `/pm <text>` classifies any input and creates issues. `/pm DOR-47` works on a specific issue. `/pm audit` runs a workspace health check. Ownership filtering dynamically discovers projects. Project status transitions are automatic.

### Phase 2: Structured Loop (in progress)

`/pm` can triage, plan, and research — not just dispatch tasks.

Four of nine templates built: `triage-intake.md`, `triage-idea.md`, `plan-simple.md`, `plan-complex.md`, `audit-workspace.md`. Remaining: `triage-signal.md`, `research-market.md`, `research-technical.md`, `dispatch-priority.md`, `monitor-outcome.md`.

**Success**: `/pm` autonomously triages issues, decomposes hypotheses (routing complex ones through the spec workflow), and conducts structured research.

### Phase 3: Automated Loop

`/pm auto` runs on a schedule. Humans at approval gates only.

Configure Pulse to run `/pm auto` every 2 hours. Add Relay: Telegram notifications for hypothesis review, pivot decisions, daily digest. Add signal ingestion from git events and error logs. Evaluate Linear's GitHub integration for PR-based status updates.

**Success**: The full loop runs continuously. Humans only intervene at Telegram approval gates.

### Phase 4: Self-Improving

The system improves its own methodology.

Instruction feedback collection — agents rate templates after use. When template quality drops, the system creates `type/meta` issues: "Improve this triage template." An agent picks it up, reviews accumulated feedback, drafts better instructions. The templates improve through the same loop as the product.

Track loop velocity (signal → outcome cycle time), hypothesis hit rate (validated vs invalidated), and prompt health (which templates produce good outcomes). The system gets faster and more accurate over time — without changing any infrastructure.

---

## What This Inherits from Loop

Linear Loop implements the Loop litepaper's core principles using existing tools:

**Everything is an issue.** Linear's issue queue is the orchestration layer. No workflow engine. No state machine. Just issues with types, priorities, and relations.

**Validate, don't assume.** Every feature starts as a hypothesis with explicit validation criteria. "Users want X" is an assumption. "Adding X will increase Y by Z% within N days" is a hypothesis.

**Ship the minimum test.** Every hypothesis produces the smallest set of tasks that could validate or invalidate it. The planning step enforces this by decomposing into single-session tasks.

**Triage everything.** Every input enters triage before creating work. The immune system that prevents backlog pollution.

**Say no to most things.** Not every signal deserves a hypothesis. Not every idea deserves research. The system actively prunes.

**Loop has no AI.** The instruction templates are static markdown. The labels are simple strings. The routing is deterministic. All intelligence comes from the agent reading the templates — which means the system automatically improves every time a better model ships.

---

## What This Adds Beyond Loop

Linear Loop extends the Loop methodology in ways that a standalone product can't:

**Full codebase context.** When a Claude Code agent triages an issue, it has access to the entire codebase. It can check if a proposed feature overlaps with existing code, verify that a bug report is plausible, or estimate implementation complexity by reading the actual source.

**The spec workflow.** Loop's planning step produces flat task lists. Linear Loop's planning step can invoke a full specification workflow — technical discovery with parallel agents, rich markdown specifications, phased task decomposition with dependency DAGs, multi-agent implementation, and structured post-implementation feedback.

**DorkOS coordination.** Loop is a standalone web app. Linear Loop has access to Pulse (scheduling), Relay (messaging to Telegram, Slack, webhooks), and Mesh (agent discovery and coordination). Monitoring agents can be scheduled. Approval requests can arrive on your phone. Multiple agents can coordinate on large features.

**Git-versioned templates.** Loop stores templates in its database. Linear Loop stores them in `.claude/skills/` — version-controlled, diffable, PR-reviewable. Template improvements go through the same code review process as product code.

---

## The Lean Loop

This is the Build-Measure-Learn feedback loop automated:

**Learn** — An agent researches the problem space. Or a signal arrives with data about how the product is actually being used. Learning produces a hypothesis with explicit confidence and validation criteria.

**Build** — The hypothesis is decomposed into tasks. Simple work stays in Linear. Complex work flows through the spec workflow. Agents execute. The smallest thing that could validate the hypothesis gets shipped.

**Measure** — A monitoring issue watches the validation criteria. Did the metric move? Did user behavior change? The outcome is recorded and feeds back as a new signal.

This loop runs continuously. Not quarterly. Not in sprints. Every shipped change has validation criteria, and every outcome generates new learning.

---

## Loop Continuity: The Self-Correcting System

The Loop's most dangerous failure mode isn't a wrong decision — it's silence. A decision that's wrong gets corrected on the next cycle. But a Loop that stops spinning without anyone noticing? That's how projects die.

We learned this the hard way. After completing research on the Tasks System Redesign, `/linear:done` closed the issue and... nothing happened. The research was done. The project had no more active issues. `/pm` would have recommended closing the project. But the actual work — specifying and implementing the feature — hadn't started. The Loop stopped spinning at exactly the moment it should have accelerated.

The root cause: **completed issues had no defined next step.** Research finished, but nobody told the system what should happen after research finishes.

### Three Principles

**1. Every issue defines what comes next.** When creating any issue, define an `## On Completion` section: what should happen when this work is done. For research: "create a spec." For a hypothesis: "create a monitor." For a task: "check if all sibling tasks are done." This is prevention — the person creating the issue thinks about the Loop's next step before work begins.

**2. Completion is a transition, not an endpoint.** `/linear:done` doesn't just close an issue — it performs a Project Pulse Check. It reads the `## On Completion` section. It assesses the project state. It recommends the next action. The Loop advances at every transition.

**3. Detection is redundant.** Multiple system components check for the same conditions. If `/linear:done` misses a transition, `/pm` catches it on the next review. If `/pm` doesn't run, the spec manifest preserves the state. Any single failure is caught by the next layer.

### The Spec-Linear Bridge

The spec workflow (`/ideate` → `/spec:execute`) runs outside Linear — it operates on files and the spec manifest, not Linear issues. This created a blind spot: when work moved from Linear into the spec workflow, Linear lost visibility. `/pm` couldn't see spec progress.

The Spec-Linear Bridge closes this gap:

- **Frontmatter linkage.** Specs include `linear-issue: DOR-NNN` in their frontmatter. This links the two systems.
- **Breadcrumb comments.** Each spec phase transition (`/ideate`, `/spec:create`, `/spec:decompose`, `/spec:execute`) posts a structured comment to the linked Linear issue. Progress is visible in Linear without leaving the spec workflow.
- **`/pm` reads the spec manifest.** During ASSESS, `/pm` checks `specs/manifest.json` for active specs linked to project issues. It detects interrupted specs and recommends the exact resume command. It prevents falsely closing projects that have active spec work.
- **Completion bridge.** When `/spec:execute` finishes, it prompts: "Run `/linear:done DOR-NNN` to close the loop." Control returns to Linear.

Linear integration is always optional — specs work fine without it. But when linked, the Loop has full visibility across both systems.

### Self-Healing Cascade

```
Issue created with ## On Completion section (prevention)
  ↓
/linear:done reads On Completion + runs Pulse Check (detection at transition)
  ↓ (if missed)
/pm reads spec manifest + project state (detection at review)
  ↓ (if missed)
/spec:execute prompts for /linear:done (detection at spec completion)
```

If any single layer fails, the next one catches it. The Loop doesn't depend on any single command being perfect.

---

## Why Not Build Loop Instead?

Loop is a standalone product — a web application with its own database, its own API, its own dashboard. Building and maintaining that infrastructure is significant. We'd need to build everything Linear already provides: issue management, project hierarchy, team collaboration, search, filtering, custom views, mobile access.

Linear Loop takes a different approach: use Linear's infrastructure and add the Loop methodology as a thin layer of skills and conventions. The trade-offs are explicit:

**We give up:** Custom data model (metadata limited to labels), custom priority algorithms (limited to Linear's Urgent/High/Medium/Low), custom dashboard (limited to what we can query via MCP), standalone deployment (requires Linear account), agent-native task primitives (atomic claiming, ephemeral agent identity, heartbeat-based orphan recovery, swarm-scoped queues).

**We gain:** Zero infrastructure to maintain, Linear's full UI for human interaction, Linear's mobile apps, Linear's search and filtering, Linear's team collaboration, Linear's Triage Intelligence, immediate availability (no build phase for the data layer).

For a team of one — or a small team that already uses Linear — this trade-off is clearly favorable. The methodology is what matters, not the platform it runs on.

---

## The Agent-Native Gap

Linear Loop uses Linear as its coordination layer because Linear already exists, already works, and the human-infrastructure trade-off is clearly favorable for a team of one. But there's a class of problem where that trade-off inverts: agent swarms.

When `/pm auto` runs a single Claude Code session — one agent, one Linear workspace — the model works. The agent queries issues, claims one, works it, reports back. Clean.

When you want multiple agents to run concurrently, claiming independent tasks from the same backlog, the human-first assumptions baked into Linear start to surface as friction:

**Identity requires pre-registration.** Claude Code subagents have ephemeral IDs — dynamically assigned at spawn time, gone after the session. Linear requires stable, pre-registered identities (OAuth `actor=app` app users with persistent workspace UUIDs). Bridging the two requires a pool manager: maintain N pre-registered "DorkOS Agent" identities, check them out at spawn, check them back in on death. Infrastructure overhead that scales with swarm size and breaks down if the pool is exhausted.

**Claiming is not atomic.** Linear has no compare-and-swap equivalent for issue delegation. Two agents scanning the same `agent/ready` backlog can both attempt to claim the same issue simultaneously — both API calls succeed, and the "winner" is whoever happened to flush first. In practice this is survivable because webhook-triggered agent arrivals are rarely synchronized to the millisecond. But it's a race condition, not a guarantee, and it requires idempotency logic on the agent side to detect and yield.

**Orphan tasks need a watchdog.** When an agent dies mid-task — crash, timeout, network failure — the issue stays `agent/claimed` forever. No other agent will touch it. Recovery requires layered defense: a `SubagentStop` hook for immediate cleanup, a Linear `AgentSession.stale` webhook subscription for secondary detection, and a Pulse watchdog cron for the catch-all. Each layer is infrastructure. None of it is the actual work.

**Agents are delegates, not workers.** Linear's 2025 schema enforces a strict separation: `issue.assignee` is a human (accountability), `issue.delegate` is an agent (action). This reflects Linear's design philosophy — a human is always accountable. For autonomous agent swarms with no human in the loop, this model doesn't fit. The "delegate" framing is conceptually backward for a system where agents _are_ the primary workers.

These aren't Linear bugs. Linear is built for humans who use AI assistants. DorkOS is building infrastructure for autonomous agents that occasionally interact with humans. The mental models are different.

### What an Agent-Native Task System Would Look Like

The scenarios above should be first-class primitives, not workarounds:

- **Ephemeral agents can claim tasks.** No pre-registration. Agents identify via session context (session ID, agent type, spawning parent). Tasks can be claimed by any member of a defined swarm without a pool manager.
- **Claiming is atomic.** Compare-and-swap semantics on claim. First writer wins — guaranteed, not probabilistic.
- **Heartbeating is built in.** Active tasks require periodic heartbeats. Silence for N seconds triggers automatic reclaim. Orphaned tasks requeue themselves without any external watchdog.
- **Swarm-scoped queues.** Tasks can be assigned to a named swarm rather than a specific agent. Any available agent in the swarm can claim. Work distributes naturally to capacity.
- **Agent hierarchy is native.** A parent agent decomposes a task into subtasks, assigns them to child agents, and waits for completion — without any of the child agents needing external identities.

This is a future DorkOS primitive. The coordination layer DorkOS was always building toward — scheduling, communication, discovery — extended to include task assignment designed for autonomous agent swarms.

Until then, Linear Loop is the right tool for human-paced, single-agent workflows. The label state machine and watchdog pattern are viable at small scale. The ceiling becomes a wall when you're running ten concurrent agents against the same backlog.

---

## The Vision

The trajectory is one command with increasing autonomy:

1. **Manual** — Human types `/pm`. Agent recommends. Human approves each action.
2. **Assisted** — Human types `/pm auto`. Agent triages, plans, researches, and executes. Human approves at gates.
3. **Autonomous** — Pulse runs `/pm auto` every 2 hours. Human gets Telegram notifications at gates.
4. **Self-improving** — Same, but the system also proposes ideas and improves its own templates.

The same command at every stage. The only thing that changes is who triggers it and how much autonomy you grant. At each stage, the human maintains full control. Every issue is visible in Linear. Every decision is traceable. Every outcome is measurable.

The human sets the direction. The system does the rest.

Linear is the data. Claude Code is the intelligence. DorkOS is the infrastructure. `/pm` connects them.

Learn. Build. Ship. Loop.
