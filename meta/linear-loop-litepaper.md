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

**The spec workflow** is the implementation layer. When work is complex enough to need design, `/linear:plan` bridges into `/ideate` → `/spec:create` → `/spec:decompose` → `/spec:execute`. When work is simple, it stays as Linear sub-issues. Either way, `/linear:done` reports outcomes back to Linear and creates monitoring issues. The loop closes.

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

**Agent state** — `agent/ready`, `agent/claimed`, `agent/completed`

**Origin** — `origin/human`, `origin/agent`, `origin/signal`

**Confidence** — `confidence/high`, `confidence/medium`, `confidence/low`

These labels are the semantic backbone. An agent querying for the next work item filters by `agent/ready`. A triage agent looks at items in the Triage workflow state. A monitor agent filters by `type/monitor`. No custom infrastructure needed — just labels and queries.

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

`/linear:plan` is the bridge. It evaluates complexity and routes: simple work stays as Linear sub-issues, complex work flows through the spec workflow. `/linear:done` is the return path — closing the loop back to Linear regardless of which path was taken.

---

## One Command: `/pm`

You wake up. You don't remember where things stand. You don't know which of six commands to run. You type one thing:

```
/pm
```

The agent queries Linear, assesses the entire loop, and tells you exactly what needs attention:

> 3 issues awaiting triage (2 ideas, 1 signal)
> 1 hypothesis ready for planning
> 2 tasks ready for execution
> 1 monitor overdue for checking
>
> **Recommendation**: Triage the 3 new issues first — one signal looks urgent (error spike from last deploy). Should I proceed?

You say yes. The agent triages. Then it recommends the next action. And the next. Each time, you approve or redirect. The loop advances.

```
/pm auto
```

Same thing, but the agent takes multiple actions without asking — except at approval gates (hypothesis review, pivot decisions). For when you trust the system and want it to run.

Two companion commands exist for specific entry points:

**`/linear:idea`** — Quick idea capture when inspiration strikes mid-work.

**`/linear:done`** — Report completion. An intentional act that closes the loop.

That's it. Three commands. Everything else — triage, planning, research, dispatch, monitoring, status, sync — is handled internally by `/pm`. The internal operations (`/linear:triage`, `/linear:plan`, `/linear:next`, etc.) still exist as direct-access escape hatches, but you never need to remember them.

---

## One Skill, Many Templates

All Loop knowledge lives in a single Claude Code skill directory with progressive discovery:

```
.claude/skills/linear-loop/
├── SKILL.md                          # Core: Loop methodology, conventions, routing table
├── templates/
│   ├── triage-idea.md               # How to evaluate ideas
│   ├── triage-signal.md             # How to evaluate signals
│   ├── research-market.md           # Market research methodology
│   ├── research-technical.md        # Technical research methodology
│   ├── plan-simple.md              # Direct task decomposition
│   ├── plan-complex.md             # Spec workflow bridge
│   ├── monitor-outcome.md          # Outcome validation framework
│   └── dispatch-priority.md        # Priority selection algorithm
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

### Phase 1: Foundation

`/pm` works. Human types one command, sees status, approves the recommended action.

Create the label taxonomy in Linear. Build `/pm`, `/linear:idea`, `/linear:done`. Create the `linear-loop` skill with core conventions. Update CLAUDE.md.

**Success**: Human types `/pm`, sees the loop status, approves the recommended action, and the agent executes it.

### Phase 2: Structured Loop

`/pm` can triage, plan, and research — not just dispatch tasks.

Build the internal operations (triage, plan, research). Add all methodology templates to the skill directory. Build the triage and planner subagents.

**Success**: `/pm` autonomously triages issues, decomposes hypotheses, and conducts structured research.

### Phase 3: Automated Loop

`/pm auto` runs on a schedule. Humans at approval gates only.

Implement `/pm auto` mode. Configure Pulse to run it every 2 hours. Add Relay: Telegram notifications for hypothesis review, pivot decisions, daily digest. Add signal ingestion from git events and error logs.

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

## Why Not Build Loop Instead?

Loop is a standalone product — a web application with its own database, its own API, its own dashboard. Building and maintaining that infrastructure is significant. We'd need to build everything Linear already provides: issue management, project hierarchy, team collaboration, search, filtering, custom views, mobile access.

Linear Loop takes a different approach: use Linear's infrastructure and add the Loop methodology as a thin layer of skills and conventions. The trade-offs are explicit:

**We give up:** Custom data model (metadata limited to labels), custom priority algorithms (limited to Linear's Urgent/High/Medium/Low), custom dashboard (limited to what we can query via MCP), standalone deployment (requires Linear account).

**We gain:** Zero infrastructure to maintain, Linear's full UI for human interaction, Linear's mobile apps, Linear's search and filtering, Linear's team collaboration, Linear's Triage Intelligence, immediate availability (no build phase for the data layer).

For a team of one — or a small team that already uses Linear — this trade-off is clearly favorable. The methodology is what matters, not the platform it runs on.

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
