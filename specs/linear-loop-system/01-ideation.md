# Linear Loop System

## The Problem

We have AI coding agents that can write code. We have Linear for tracking work. We have a mature spec workflow (`/ideate` → `/spec:create` → `/spec:decompose` → `/spec:execute` → `/spec:feedback`) for implementation. But there's no system that **closes the loop** — connecting what we decide to build, with what gets built, with whether it worked, with what to do next. Today:

- Ideas live in our heads or scattered notes
- Triage is manual and inconsistent
- After shipping, nobody systematically checks if the fix worked
- The next priority is decided by gut feel, not data
- Research findings and decisions aren't captured in a structured, reusable way
- Agents can execute tasks but can't participate in the product strategy
- The spec workflow has no upstream (where do specs come from?) or downstream (did the shipped spec achieve its goal?)

## The Vision

Implement the **Loop methodology** (from the Loop litepaper) using **Linear as the data store** and **Claude Code skills/subagents as the execution layer**. Everything is an issue. The issue queue IS the orchestration layer.

```
Idea → Research → Hypothesis → Plan → Execute → Monitor → Signal → ...
```

Linear handles the data: issues, projects, labels, relations, comments, cycles.
Claude Code handles the intelligence: triage, planning, execution, monitoring, self-improvement.
DorkOS handles the infrastructure: scheduling (Pulse), messaging (Relay), discovery (Mesh).
The spec workflow handles implementation depth: ideation, specification, decomposition, execution, feedback.

## Core Insight: Linear IS the Loop

The Loop litepaper describes building a separate product engine. But we already have Linear. Instead of duplicating Linear's capabilities, we implement Loop's methodology **inside** Linear using:

| Loop Concept                                            | Linear Implementation                             |
| ------------------------------------------------------- | ------------------------------------------------- |
| Issue queue                                             | Linear issues with type labels                    |
| Priority system                                         | Linear priority field + per-project goals         |
| Issue types (idea, research, hypothesis, task, monitor) | Linear labels (`type/*`)                          |
| Product with workstreams                                | Linear team + projects + milestones               |
| Issue relations (blocking)                              | Linear issue relations                            |
| Agent communication                                     | Linear comments                                   |
| Instruction templates                                   | Local skill files (git-versioned)                 |
| Cycles/observation windows                              | Linear cycles                                     |
| Signal ingestion                                        | Issues created via MCP with `origin/signal` label |
| Full audit trail                                        | Linear activity history                           |

## Relationship to the Spec Workflow

The Linear Loop and spec workflow operate at **different levels** — they're complementary, not competing.

**Linear Loop** = Product-level orchestration — WHAT to build and WHY (strategic layer)
**Spec Workflow** = Implementation-level orchestration — HOW to build it (tactical layer)

The Linear Loop wraps **around** the spec workflow, providing the upstream intake and downstream validation that the spec workflow currently lacks:

```
                    LINEAR LOOP (product layer)
                    ┌──────────────────────────────────────────────┐
                    │                                              │
 Idea → Research → Hypothesis → Plan ──────────────────────┐      │
                                                           │      │
                    SPEC WORKFLOW (implementation layer)    │      │
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

### What the Spec Workflow Provides (Not Replaced)

- Detailed technical discovery with parallel agents (`/ideate`)
- Rich specification documents with acceptance criteria (`/ideate-to-spec`, `/spec:create`)
- Phased task decomposition with dependency DAGs (`/spec:decompose`)
- Multi-agent parallel implementation orchestration (`/spec:execute`)
- Structured post-implementation feedback collection (`/spec:feedback`)
- Automatic ADR extraction from specifications

### What the Linear Loop Adds (New)

- **Upstream**: Where ideas come from (intake from signals, humans, agents)
- **Triage**: Which ideas to pursue (evaluation against project goals)
- **Downstream**: Whether shipped work achieved its goal (monitoring + validation)
- **Iteration**: What to do next based on evidence (iterate, pivot, or persevere)
- **Continuity**: The loop never stops — outcomes generate new signals

### How They Connect

**`/linear:plan`** is the bridge. When an agent encounters a hypothesis that requires non-trivial implementation:

1. `/linear:plan` evaluates complexity
2. **Simple** (single-session task): Creates Linear sub-issues directly
3. **Complex** (multi-session, needs design): Invokes `/ideate` with the Linear issue as context, creating a spec directory linked to the Linear issue. The spec workflow runs. `/linear:done` reports outcomes back to Linear.

**`/linear:done`** is the return path. After `/spec:execute` completes:

1. Updates the Linear issue with completion details
2. Creates a `type/monitor` issue with the hypothesis's validation criteria
3. Links the spec directory in the issue comment for traceability

This means the existing commands — `/ideate`, `/ideate-to-spec`, `/spec:create`, `/spec:decompose`, `/spec:execute`, `/spec:feedback` — remain **exactly as they are**. The Linear Loop commands are a new layer that sits above them.

## Linear Hierarchy: Team, Projects, Milestones

DorkOS is a product, not a single project. In Linear's hierarchy:

```
Team: DorkOS                              ← the product (all issues belong here)
├── Project: Linear Loop System           ← a major workstream
│   ├── Milestone: Phase 1 Foundation
│   ├── Milestone: Phase 2 Structured Loop
│   └── Issues...
├── Project: Console UI                   ← another workstream
│   └── Issues...
├── Project: Relay v2                     ← another workstream
│   └── Issues...
├── Project: CLI Package
│   └── Issues...
└── Unassigned issues                     ← one-off tasks, incoming ideas
```

**Mapping:**

| DorkOS Concept          | Linear Entity   | Notes                                  |
| ----------------------- | --------------- | -------------------------------------- |
| DorkOS (the product)    | **Team**        | All issues belong to exactly one team  |
| Major workstreams       | **Projects**    | Issues assigned to at most one project |
| Phase gates             | **Milestones**  | Within a project                       |
| Strategic OKRs (future) | **Initiatives** | Group projects under strategic goals   |

**Key rules from Linear's data model:**

- An issue belongs to exactly one Team (DorkOS)
- An issue belongs to at most one Project (optional — new ideas start unassigned)
- Labels are team-wide — the `type/*`, `agent/*`, `origin/*`, `confidence/*` taxonomy is shared across all projects
- Projects have their own goals — each workstream defines its own success criteria

**How `/pm` handles multiple projects:**

`/pm` assesses at the **team level** by default — it sees everything across all projects and recommends the highest-priority action globally. The status view groups by project:

> **Linear Loop System**: 2 tasks ready, 1 monitor overdue
> **Console UI**: 3 ideas in triage
> **Relay v2**: blocked — waiting on spec feedback
> **Unassigned**: 5 new ideas need project assignment
>
> **Recommendation**: Check the overdue monitor in Linear Loop — 3 days past deadline.

Triage assigns incoming ideas to the appropriate project. Planning creates issues within the hypothesis's project. Monitoring checks outcomes per-project against that project's goals.

## What Linear Handles (No Custom Code Needed)

- Issue CRUD and lifecycle management
- Workflow states (Triage → Backlog → Todo → In Progress → In Review → Done)
- Priority ordering (Urgent/High/Medium/Low/None)
- Project and milestone hierarchy (multiple projects per team)
- Team assignment and user management
- Issue relations (blocks/blocked-by/related/duplicate)
- Comments for agent-human communication
- Cycles for time-boxed observation windows
- Triage Intelligence (built-in AI triage for basic categorization)
- Search, filtering, and custom views

## What We Build (Skills, Commands, Subagents)

### 1. Label Taxonomy

Map Loop's issue types to Linear labels. These are the semantic backbone:

**Issue Types** (mutually exclusive):

- `type/idea` — Raw idea, needs evaluation
- `type/research` — Research task with structured output format
- `type/hypothesis` — Validated hypothesis with explicit confidence and validation criteria
- `type/task` — Concrete implementation task (completable in one agent session)
- `type/monitor` — Outcome monitoring task (watches validation criteria)
- `type/signal` — Incoming signal from external source
- `type/meta` — System improvement task (improving instructions, processes)

**Agent Metadata**:

- `agent/ready` — Ready for automated agent pickup
- `agent/claimed` — Agent has claimed this issue
- `agent/completed` — Agent completed, awaiting review/validation

**Origin Tracking**:

- `origin/human` — Created by a human
- `origin/agent` — Created by an agent (research finding, decomposed task)
- `origin/signal` — Created from an external signal (error, metric, feedback)

**Confidence** (for hypotheses):

- `confidence/high` — 0.8+ confidence
- `confidence/medium` — 0.6-0.8 confidence
- `confidence/low` — <0.6 confidence

### 2. Commands

#### The Primary Command: `/pm`

One command to run the entire loop. You wake up, type `/pm`, and the system tells you where things stand and what needs your attention.

```
/pm          → Review status, recommend next action, wait for approval
/pm auto     → Take the next N actions autonomously (except approval gates)
```

**What `/pm` does:**

```
/pm
  │
  ├── 1. SYNC — Query Linear for all issues across types and states
  │
  ├── 2. ASSESS — What needs attention, in priority order?
  │     ├── Overdue monitors (outcomes need checking)
  │     ├── Issues in Triage (ideas/signals awaiting evaluation)
  │     ├── Planned tasks with agent/ready label (work to execute)
  │     ├── Hypotheses without plans (need decomposition)
  │     └── Stale in-progress items (blocked? stuck? need help?)
  │
  ├── 3. RECOMMEND — "Here's the most important thing to do next"
  │     (with reasoning: why this, not something else)
  │
  └── 4. EXECUTE — On approval, run the appropriate internal operation
        ├── Triage → reads triage template, evaluates issues
        ├── Plan → reads plan template, decomposes hypothesis
        ├── Dispatch → claims task, does the work (or bridges to /ideate)
        ├── Monitor → reads monitor template, checks outcomes
        └── Research → reads research template, investigates topic
```

The agent invokes the internal operations (`triage`, `plan`, `dispatch`, `monitor`, `research`) based on what the loop needs. The human doesn't need to remember which operation to run — `/pm` figures it out.

**Progression to automation:**

| Phase   | How `/pm` Runs                 | Human Role                      |
| ------- | ------------------------------ | ------------------------------- |
| Phase 1 | Human types `/pm`              | Approves each action            |
| Phase 2 | Human types `/pm auto`         | Approves at gates only          |
| Phase 3 | Pulse runs `/pm auto` every 2h | Telegram notifications at gates |
| Phase 4 | Same + system proposes ideas   | Sets direction only             |

#### Companion Commands

Two additional user-facing commands for specific entry points:

**`/linear:idea`** — Quick idea capture. Creates a `type/idea` issue in Triage state.

```
/linear:idea "We should add keyboard shortcuts for common actions"
```

Use this when inspiration strikes mid-work. The idea enters the loop and will be triaged on the next `/pm` run.

**`/linear:done [issue-id]`** — Report completion. An intentional act — "I'm satisfied, close the loop."

Updates issue status, adds a structured completion comment with:

- What was done
- Files changed (or spec directory link if routed through spec workflow)
- Any follow-up issues needed
- For hypotheses: whether validation criteria were met

Creates follow-up issues automatically:

- `type/monitor` for shipped hypotheses
- Next `type/task` in the plan sequence (unblocks)
- `type/meta` if the instruction template needs improvement

#### Internal Operations (Invoked by `/pm`)

These operations exist as internal commands that `/pm` orchestrates. They can also be called directly as escape hatches when the human knows exactly what they want.

**`/linear:triage`** — Evaluate the next untriaged issue. Ideas: worth building? Signals: noise or real? Research findings: actionable?

**`/linear:plan [issue-id]`** — Decompose a hypothesis into work. The bridge between the Linear Loop and the spec workflow:

- **Simple** (single-session): Creates Linear sub-issues directly
- **Complex** (multi-session): Invokes `/ideate` with the Linear issue as context, creating a spec directory linked to the issue

**`/linear:next`** — Dispatch the highest-priority ready task. Filters by `agent/ready`, sorts by priority, assembles full context, marks as claimed.

**`/linear:research [topic]`** — Create a structured research issue with methodology template.

**`/linear:status`** — Loop dashboard: issues by type/state, blocked items, active hypotheses, loop velocity.

**`/linear:sync`** — Pull current priorities into local context.

### 3. The `linear-loop` Skill (Single Skill with Progressive Discovery)

All Loop knowledge lives in a **single skill directory** with on-demand template loading. This follows the proven pattern used by `executing-specs/` (4 files) and `debugging-systematically/` (5 files) in this project.

**Why one skill with templates, not many separate skills:**

| Concern            | Single Skill + Templates                     | Many Separate Skills                     |
| ------------------ | -------------------------------------------- | ---------------------------------------- |
| DRY                | Label taxonomy written once                  | Repeated across 6 skills                 |
| Context efficiency | Only the relevant template is loaded         | All skill content injected on activation |
| Maintenance        | Update conventions in one place              | Update 6 files for a label change        |
| Skill listing      | One clean description                        | 6 descriptions competing for attention   |
| Organization       | Directory hierarchy mirrors Loop stages      | Flat list of skill directories           |
| Auto-triggering    | Not needed — slash commands are the triggers | Each skill needs its own pattern         |

**Why local files over Linear Documents:**

Linear Documents are constrained: must be tied to a project/initiative/issue (not standalone), have no folder/category system, MCP write operations are unreliable, and version history is not API-accessible. Local skill files are git-versioned, searchable, directly injectable via the skill system, and organized in directories.

**Skill structure:**

```
.claude/skills/linear-loop/
├── SKILL.md                          # Core: Loop methodology, label taxonomy, conventions,
│                                     #   spec workflow bridge, template routing table
├── config.json                       # Repo-specific settings (team, projects, limits)
├── templates/
│   ├── triage-idea.md               # How to evaluate an idea against project goals
│   ├── triage-signal.md             # How to evaluate an incoming signal (error, metric, feedback)
│   ├── research-market.md           # Market research: competitors, pricing, user reception
│   ├── research-technical.md        # Technical research: feasibility, trade-offs, effort
│   ├── plan-simple.md              # Direct Linear sub-issue decomposition for single-session work
│   ├── plan-complex.md             # Bridge to spec workflow (/ideate → /spec:create)
│   ├── monitor-outcome.md          # Validation criteria checking, pivot/persevere/kill framework
│   └── dispatch-priority.md        # Priority selection algorithm, context assembly
└── conventions/
    └── labels.md                    # Full label taxonomy reference with examples
```

**Config file** (`config.json`):

Repo-specific settings that map this codebase to its Linear team and configure `/pm` behavior:

```json
{
  "team": {
    "slug": "dorkos",
    "id": "team_abc123"
  },
  "defaultProject": null,
  "activeProjects": ["linear-loop-system", "console-ui", "relay-v2", "cli-package"],
  "pm": {
    "autoLimit": 5,
    "approvalGates": ["hypothesis-review", "pivot-decision", "project-creation"]
  },
  "relay": {
    "channel": null
  }
}
```

| Field                   | Purpose                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `team.slug` / `team.id` | Maps this repo to its Linear team                                               |
| `defaultProject`        | Where unassigned issues go (null = stay unassigned for triage)                  |
| `activeProjects`        | Which projects `/pm` shows in its status view                                   |
| `pm.autoLimit`          | Max actions `/pm auto` takes before stopping                                    |
| `pm.approvalGates`      | Actions that always require human approval, even in auto mode                   |
| `relay.channel`         | Notification channel for approval gates (null = no notifications until Phase 3) |

**How progressive discovery works:**

The SKILL.md entrypoint provides:

1. The Loop methodology overview (always loaded)
2. Label taxonomy and issue conventions (always loaded)
3. A **template routing table** that tells the agent which template to read for each activity

Templates are loaded **on demand** — only when needed for the current task:

```
/pm (triage step)    → reads SKILL.md → reads templates/triage-idea.md or triage-signal.md
/pm (dispatch step)  → reads SKILL.md → reads templates/dispatch-priority.md
/pm (plan step)      → reads SKILL.md → reads templates/plan-simple.md or plan-complex.md
/pm (research step)  → reads SKILL.md → reads templates/research-market.md or research-technical.md
/pm (monitor step)   → reads SKILL.md → reads templates/monitor-outcome.md
```

`/pm` reads SKILL.md once (for conventions), then loads the specific template for whatever action the loop needs. The internal commands (`/linear:triage`, `/linear:plan`, etc.) follow the same pattern when called directly. This separation means:

- **`/pm`** = the orchestrator (assesses, recommends, routes)
- **SKILL.md** = baseline knowledge (the conventions)
- **Templates** = deep methodology for specific activities (the expertise)
- **Internal commands** = direct-access escape hatches

Templates reference Linear context dynamically — fetching project goals, issue details, and parent chains via MCP at runtime. The template text itself is static and git-versioned.

**Cross-agent portability:**

| Agent        | How This Translates                                                      |
| ------------ | ------------------------------------------------------------------------ |
| Claude Code  | Native — `.claude/skills/linear-loop/` with progressive discovery        |
| Codex CLI    | 1:1 — `.agents/skills/linear-loop/` (identical progressive loading)      |
| Cursor       | Flatten into `.cursor/rules/linear-*.mdc` files with `globs` frontmatter |
| Continue.dev | Split into `.continue/rules/linear-*.md` with `globs` + `regex`          |
| Windsurf     | Flatten to single `.windsurf/rules/linear-loop.md` (12k char limit)      |

### 5. Subagents

#### `linear-triage-agent`

Autonomous triage of multiple issues. Can be scheduled via Pulse to run periodically.

- Pulls all issues in Triage state
- Evaluates each against project goals
- Sets labels, priority, and project assignment
- Creates research issues from promising ideas
- Declines noise with explanatory comments
- Escalates ambiguous items for human review

#### `linear-planner-agent`

Decomposes hypotheses into executable task plans.

- Takes a hypothesis issue as input
- Researches the codebase to understand implementation scope
- For simple scope: creates sub-issues with relations directly in Linear
- For complex scope: invokes the spec workflow (`/ideate` → `/spec:create`)
- Creates monitoring issue with validation criteria
- Adds estimates and assigns to appropriate project milestone

#### `linear-monitor-agent`

Checks outcomes of shipped work. Scheduled via Pulse.

- Pulls `type/monitor` issues
- Checks validation criteria (metrics, error rates, user behavior)
- Reports findings as comments
- Creates new issues based on results:
  - Hypothesis validated → close monitor, update project goal progress
  - Hypothesis invalidated → create evaluation issue (pivot/persevere/kill)
  - Partial validation → create iteration hypothesis

### 6. CLAUDE.md Updates

Add a `## Linear Workflow` section:

```markdown
## Linear Workflow

We use Linear as the orchestration layer for all product work, following the Loop methodology.

### Three Commands

- **`/pm`** — The primary command. Reviews the loop, recommends the next action, executes on approval.
  Run `/pm auto` to let the agent take multiple actions autonomously (except at approval gates).
- **`/linear:idea`** — Quick idea capture during development.
- **`/linear:done`** — Report completion and close the loop on an issue.

### Issue Types

Issues are categorized by `type/*` labels: idea, research, hypothesis, task, monitor, signal, meta.

### The Loop

Everything is an issue. The loop runs continuously:
Idea → Triage → Research → Hypothesis → Plan → Execute → Monitor → Signal → Loop continues.
Complex work routes through the spec workflow (/ideate → /spec:execute). Simple work stays in Linear.
`/pm` orchestrates all of this. You don't need to remember the steps.

### Labels

- `type/*` — Issue type (mutually exclusive)
- `agent/*` — Agent lifecycle state
- `origin/*` — How the issue was created
- `confidence/*` — Hypothesis confidence level
```

## Phased Implementation

### Phase 1: Foundation (Week 1-2)

**Goal**: `/pm` works. Human types one command, sees status, gets a recommendation, approves it.

- [ ] Create label taxonomy in Linear workspace
- [ ] Create `linear-loop` skill (`.claude/skills/linear-loop/SKILL.md`) with core conventions
- [ ] Build `/pm` command (sync + assess + recommend + execute on approval)
- [ ] Build `/linear:idea` command
- [ ] Build `/linear:done` command
- [ ] Build internal operations: `/linear:next`, `/linear:status`, `/linear:sync`
- [ ] Update CLAUDE.md with Linear conventions
- [ ] Create Linear team for DorkOS and initial projects for active workstreams (with goals per project)

**Success criteria**: Human types `/pm`, sees the loop status, approves the recommended action, and the agent executes it. `/linear:idea` captures ideas. `/linear:done` closes the loop.

### Phase 2: Structured Loop (Week 3-4)

**Goal**: `/pm` can triage, plan, and research — not just dispatch tasks.

- [ ] Build internal operations: `/linear:triage`, `/linear:plan`, `/linear:research`
- [ ] Add templates to `linear-loop` skill:
  - `templates/triage-idea.md` and `templates/triage-signal.md`
  - `templates/research-market.md` and `templates/research-technical.md`
  - `templates/plan-simple.md` and `templates/plan-complex.md`
  - `templates/monitor-outcome.md`
  - `templates/dispatch-priority.md`
- [ ] Add `conventions/labels.md` reference document
- [ ] Build `linear-triage-agent` subagent (for batch triage)
- [ ] Build `linear-planner-agent` subagent (for hypothesis decomposition)

**Success criteria**: `/pm` autonomously triages issues, decomposes hypotheses (routing complex ones through the spec workflow), and conducts structured research.

### Phase 3: Automated Loop (Week 5-8)

**Goal**: `/pm auto` runs on a schedule. Humans at approval gates only.

- [ ] Implement `/pm auto` mode (take N actions without asking, except approval gates)
- [ ] Build `linear-monitor-agent` subagent
- [ ] Configure Pulse: run `/pm auto` every 2 hours
- [ ] Relay integration for human approval gates:
  - Telegram notification when hypothesis needs review
  - Telegram notification when pivot/persevere decision is needed
  - Ability to approve/reject via Telegram reply
- [ ] Signal ingestion from git events (PR merged → create monitor issue)
- [ ] Signal ingestion from error logs (spike → create signal issue)
- [ ] Automated hypothesis validation (compare before/after metrics)

**Success criteria**: Pulse runs `/pm auto` on a schedule. The full loop runs: idea → triage → research → hypothesis → plan → execute → monitor → signal. Humans only intervene at Telegram approval gates.

### Phase 4: Self-Improving (Week 9+)

**Goal**: The system improves its own methodology.

- [ ] Instruction feedback collection (agents rate skill templates after use)
- [ ] Meta-issues for template improvement (auto-created when feedback is poor)
- [ ] Hypothesis hit rate tracking (validated vs invalidated)
- [ ] Loop velocity metrics (signal → outcome cycle time)
- [ ] Prompt health dashboard (which templates work, which don't)
- [ ] Agent-proposed ideas based on codebase analysis
- [ ] External signal ingestion (PostHog, user feedback, competitor monitoring)
- [ ] PMF tracking via Linear goals and milestones
- [ ] Pivot/persevere decision framework with data preparation

**Success criteria**: The system's instruction quality measurably improves over time. Loop velocity decreases. Hypothesis hit rate increases.

## Architecture Decisions

### Why Linear as Data Store (Not a Custom DB)

1. **Already adopted** — we're using Linear, no migration cost
2. **Rich UI** — humans can interact via Linear's web/desktop/mobile app
3. **Built-in features** — triage intelligence, relations, cycles, views, search
4. **API/MCP** — full programmatic access for agents
5. **Team collaboration** — multiple humans can participate
6. **No maintenance** — hosted SaaS, no DB to manage

Trade-offs we accept:

- Custom metadata limited to labels (no arbitrary key-value on issues)
- Confidence scores stored as labels, not numeric fields
- Priority algorithm limited to Linear's built-in (Urgent/High/Medium/Low)

### Why One Skill with Progressive Discovery (Not Many Skills or Linear Documents)

**Not Linear Documents** — they're constrained: must be tied to a project/initiative/issue (not standalone), have no folder/category system, MCP write operations are unreliable, and version history is not API-accessible.

**Not many separate skills** — duplicates the label taxonomy across files, competes for attention in the skill listing, and requires independent pattern matching for auto-triggering (unnecessary since slash commands are the triggers).

**One skill with templates** — follows the proven `executing-specs/` pattern already in this project. SKILL.md provides baseline conventions (always loaded). Templates in subdirectories are loaded on demand by slash commands that know which template to read. This gives us:

- Git versioning with full history
- Directory hierarchy that mirrors the Loop methodology stages
- DRY conventions — label taxonomy written once
- Progressive context loading — only the relevant template enters context
- Cross-agent portability — Codex CLI supports identical pattern; others can flatten via build step

Templates fetch Linear context dynamically (project goals, issue details, parent chains) via MCP at runtime. The template text itself is static and versioned locally.

### Why the Spec Workflow is NOT Replaced

The spec workflow and Linear Loop operate at different abstraction levels:

| Aspect           | Linear Loop                        | Spec Workflow                        |
| ---------------- | ---------------------------------- | ------------------------------------ |
| **Level**        | Product strategy                   | Implementation tactics               |
| **Question**     | What should we build? Did it work? | How should we build it?              |
| **Artifacts**    | Linear issues, labels, comments    | Spec files, task JSON, ADRs          |
| **Lifecycle**    | Idea → hypothesis → monitoring     | Ideation → specification → execution |
| **Time horizon** | Continuous, cross-feature          | Per-feature, finite                  |

The Linear Loop feeds INTO the spec workflow (via `/linear:plan`) and receives results FROM it (via `/linear:done`). The spec workflow gains:

- **Upstream**: Clear provenance for every spec (which Linear hypothesis triggered it?)
- **Downstream**: Outcome tracking (did the shipped spec achieve its validation criteria?)
- **Continuity**: Completed specs generate monitoring issues that feed new insights back into the loop

### Why Skills + Slash Commands (Not a Standalone Agent)

The Loop litepaper describes a standalone product. We implement it as Claude Code skills because:

1. **Zero infrastructure** — no server to deploy, no auth to manage
2. **Composable** — skills inject context into any conversation
3. **Human-in-the-loop by default** — every action goes through Claude Code's approval flow
4. **Progressive automation** — start manual, add Pulse scheduling incrementally
5. **Context-rich** — agents have full codebase context, not just issue descriptions

### Pull vs Push Architecture

Following the Loop litepaper's pull architecture:

- `/pm` pulls the current state from Linear, assesses, and acts — not pushed by webhooks
- Pulse schedules `/pm auto` on a cadence (every N hours)
- This avoids webhook infrastructure and keeps agents in control
- Linear webhooks could be added later for real-time signal ingestion

## DorkOS Integration Points

### Pulse (Scheduling)

- **Loop heartbeat**: Every 2h, Pulse runs `/pm auto` — the same command the human uses, just automated
- **This is the only scheduled task needed** — `/pm` internally handles triage, dispatch, monitoring, and sync

### Relay (Messaging)

- **Approval gates**: When a hypothesis needs human review, send Telegram message
- **Pivot decisions**: When a hypothesis is invalidated, send decision request
- **Daily digest**: Summary of loop activity (issues triaged, tasks completed, hypotheses validated)
- **Escalation**: When an issue is blocked for >24h, notify via Telegram

### Mesh (Discovery)

- **Agent coordination**: When multiple agents are working, Mesh prevents duplicate work
- **Capability routing**: Route research tasks to agents with relevant context
- **Status visibility**: Dashboard shows which agents are working on which issues

## What This Enables

When fully operational, this system can:

1. **Capture an idea** from any source (human thought, agent observation, signal) → Linear issue
2. **Autonomously triage** it against project goals → accept/decline/defer
3. **Research the opportunity** with structured investigation → findings in issue comments
4. **Form a hypothesis** with explicit validation criteria → testable prediction
5. **Route to the right workflow** — simple tasks stay in Linear, complex features flow through `/ideate` → `/spec:execute`
6. **Execute tasks** via Claude Code agent sessions → code shipped
7. **Monitor outcomes** against validation criteria → hypothesis validated/invalidated
8. **Iterate or pivot** based on evidence → new hypothesis or new direction
9. **Improve its own instructions** based on agent feedback → better skill templates
10. **Run continuously** without human intervention except at approval gates

The human sets the direction. The system does the rest. Loop.
