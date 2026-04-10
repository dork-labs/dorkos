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

### Spec-Linear Traceability (The Spec-Linear Bridge)

When complex work routes through the spec workflow, the two systems stay connected:

- **Spec → Linear**: The spec's `01-ideation.md` gets a `linear-issue: DOR-NNN` frontmatter field
- **Linear → Spec**: The `specs/manifest.json` entry gets a `linearIssue: "DOR-NNN"` field
- **Breadcrumb comments**: Each spec phase transition posts a structured progress comment to the linked Linear issue (Ideation Started → Specification Created → Decomposed → Execution Started → Implementation Complete)
- **`/pm` spec awareness**: During ASSESS, `/pm` reads `specs/manifest.json` to detect active specs, interrupted work, and falsely complete projects
- **Completion bridge**: `/spec:execute` prompts for `/linear:done` when all tasks are done

This enables reverse lookups, cross-reference auditing during `/pm audit`, and — critically — prevents the Loop from silently stopping when work transitions between Linear and the spec workflow.

### Loop Continuity and Self-Correction

**Lesson learned (March 2026):** The Loop's most dangerous failure mode is silence — not a wrong decision, but a Loop that stops spinning without anyone noticing. This happened when research completed but no next step was defined. The fix is layered:

1. **Completion routing** (prevention): Every issue defines `## On Completion` — what should happen when this work is done
2. **`/linear:done` Pulse Check** (transition detection): After closing, assess project state and recommend the next Loop phase
3. **`/pm` spec awareness** (review detection): Detect interrupted specs, falsely complete projects, and missing bridges
4. **`/spec:execute` completion bridge** (spec detection): Prompt for `/linear:done` when implementation finishes

Multiple detection points ensure that if any single layer fails, the next one catches it. The Loop self-corrects.

## Linear Hierarchy: Team, Projects, Milestones

DorkOS is a product, not a single project. In Linear's hierarchy:

```
Team: DorkOS                              ← the product (all issues belong here)
├── Project: Linear Loop System           ← a major workstream
│   └── Issues...
├── Project: Console UI                   ← another workstream
│   └── Issues...
├── Project: Relay v2                     ← another workstream
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

### Ownership-Based Filtering

`/pm` discovers active projects dynamically based on the `filter.ownership` setting in `config.json`:

- **`"unassigned"` (default)**: `/pm` manages projects with no lead and issues with no assignee. Assign a lead in Linear to exclude a project from `/pm`'s scope.
- **`"all"`**: `/pm` manages everything in the team, regardless of assignment.

No hardcoded project lists. No config updates when projects are created or archived. Just assign a lead to take ownership, or leave it unassigned for the agent.

### Project Status Awareness

`/pm` reads and updates project statuses automatically:

| Status      | Meaning                                |
| ----------- | -------------------------------------- |
| Backlog     | Project exists but no work planned yet |
| Planned     | Work is scoped but hasn't started      |
| In Progress | Active work underway                   |
| Completed   | All work finished, goals met           |
| Cancelled   | Project abandoned                      |

**Automatic transitions:**

| Transition              | When                                                        |
| ----------------------- | ----------------------------------------------------------- |
| Backlog → Planned       | First issue is triaged into the project                     |
| Planned → In Progress   | First issue in the project moves to "In Progress"           |
| In Progress → Completed | All issues in the project are Done and monitors are cleared |

Completed and Cancelled projects are excluded from the dashboard — they're done. If a Completed project gets a new issue (e.g., a regression signal), it moves back to In Progress automatically.

## What Linear Handles (No Custom Code Needed)

- Issue CRUD and lifecycle management
- Workflow states (Triage → Backlog → Todo → In Progress → Done)
- Priority ordering (Urgent/High/Medium/Low/None)
- Project and milestone hierarchy (multiple projects per team)
- Team assignment and user management
- Issue relations (blocks/blocked-by/related/duplicate)
- Comments for agent-human communication
- Cycles for time-boxed observation windows
- Triage Intelligence (built-in AI triage for basic categorization)
- Search, filtering, and custom views

## What We Build (Skills, Commands, Templates)

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
- `needs-input` — Agent posted a question, awaiting human response

**Origin Tracking**:

- `origin/human` — Created by a human
- `origin/from-agent` — Created by an agent (research finding, decomposed task)
- `origin/from-signal` — Created from an external signal (error, metric, feedback)

**Confidence** (for hypotheses):

- `confidence/high` — 0.8+ confidence
- `confidence/medium` — 0.6-0.8 confidence
- `confidence/low` — <0.6 confidence

### 2. Commands

#### The Primary Command: `/pm`

One command to run the entire loop. Five modes:

```
/pm                              → Status dashboard, recommend one action, wait for approval
/pm auto                         → Execute up to N actions autonomously (except approval gates)
/pm DOR-47                       → Skip assessment, work on this specific issue directly
/pm audit                        → Workspace health check (labels, statuses, stale issues, orphans)
/pm "We should add dark mode"    → Classify input and create appropriate issue(s)
```

**What `/pm` does (default mode):**

```
/pm
  │
  ├── 1. SYNC — Discover projects dynamically, query issues with ownership filter
  │     ├── get_authenticated_user (cache for this run)
  │     ├── list_projects (filtered by ownership)
  │     ├── list_issues (by status, labels, across filtered projects)
  │     └── Check needs-input issues for human responses
  │
  ├── 2. ASSESS — What needs attention, in priority order?
  │     ├── Needs-input responses (human answered an agent's question)
  │     ├── Overdue monitors (outcomes need checking)
  │     ├── Issues in Triage (ideas/signals awaiting evaluation)
  │     ├── Ready tasks (agent/ready label, waiting for execution)
  │     ├── Hypotheses without plans (need decomposition)
  │     ├── Stale in-progress (>48h without updates)
  │     └── Empty projects (zero active issues)
  │
  ├── 3. PRESENT — Status dashboard grouped by project with status badges
  │
  ├── 4. RECOMMEND — "Here's the most important thing to do next" (with reasoning)
  │
  └── 5. EXECUTE — On approval, load the appropriate template and act
        ├── Intake → reads triage-intake.md, classifies freeform input
        ├── Triage → reads triage-idea.md or triage-signal.md
        ├── Plan → reads plan-simple.md or plan-complex.md
        ├── Monitor → reads monitor-outcome.md
        ├── Dispatch → reads dispatch-priority.md
        ├── Research → reads research-market.md or research-technical.md
        └── Audit → reads audit-workspace.md
```

**Freeform input mode**: Accepts any text — ideas, bug reports, product briefs, research questions, file paths. The intake template classifies the input and creates the right issue type(s). Multi-concern briefs trigger the `project-creation` approval gate.

**Direct issue mode** (`/pm DOR-47`): Fetches the issue, shows context, routes by type label (task → start working, hypothesis → offer to plan, idea → offer to triage, etc.).

**Audit mode**: Comprehensive workspace health check — label integrity, project status correctness, stale issues, orphan detection, spec-Linear cross-references. Auto-fixes what it can, asks about the rest.

**Approval gates** (always require human approval, even in auto mode):

- `hypothesis-review` — Before accepting a hypothesis
- `pivot-decision` — Before pivoting or killing a hypothesis
- `project-creation` — Before creating a new Linear project

#### Async Human-in-the-Loop (`needs-input`)

When `/pm auto` encounters ambiguity it can't resolve:

1. Post a structured comment on the issue with the question (multiple choice when possible)
2. Add `needs-input` label
3. Assign the issue to the authenticated user (triggers a Linear notification)
4. Skip this issue and continue to the next action

On the next `/pm` run, SYNC checks `needs-input` issues for human responses. If a comment exists after the agent's question: remove label, unassign, act on the answer. If no response yet: show in "Awaiting Your Input" dashboard section.

#### Self-Documenting Issues (Next-Steps Comments)

After every action, `/pm` adds a structured comment:

```
**Agent Action** — [YYYY-MM-DD]
**Action:** [what was done — e.g., "Triaged idea, moved to Backlog"]
**Reasoning:** [brief — e.g., "Aligns with SDK Upgrade project goals"]
**Next steps:** [what should happen next — e.g., "Research phase to validate feasibility"]
```

Anyone (human or agent) can read the last comment to understand current state without re-running `/pm`.

#### Companion Commands

**`/linear:idea`** — Quick idea capture. Shortcut for `/pm "your idea"`. Creates a `type/idea` issue in Triage.

**`/linear:done [issue-id]`** — Report completion. Updates issue status, adds a structured completion comment, creates follow-up issues (monitors for hypotheses, next tasks in sequence).

### 3. The `linear-loop` Skill (Single Skill with Progressive Discovery)

All Loop knowledge lives in a **single skill directory** with on-demand template loading:

```
.claude/skills/linear-loop/
├── SKILL.md                          # Core: Loop methodology, conventions, routing table
├── config.json                       # Repo-specific settings (team, ownership filter, limits)
├── templates/
│   ├── triage-intake.md             # Universal input classifier (freeform → issue)
│   ├── triage-idea.md               # How to evaluate an idea against project goals
│   ├── triage-signal.md             # How to evaluate signals (Phase 2)
│   ├── research-market.md           # Market research methodology (Phase 2)
│   ├── research-technical.md        # Technical research methodology (Phase 2)
│   ├── plan-simple.md              # Direct Linear sub-issue decomposition
│   ├── plan-complex.md             # Bridge to spec workflow (/ideate → /spec:create)
│   ├── monitor-outcome.md          # Outcome validation framework (Phase 2)
│   ├── dispatch-priority.md        # Priority selection algorithm (Phase 2)
│   └── audit-workspace.md          # Workspace health check
└── conventions/
    └── labels.md                    # Full label taxonomy reference with examples
```

**Config file** (`config.json`):

```json
{
  "team": {
    "slug": "dorkos",
    "name": "DorkOS",
    "id": "a171dbd5-3ccc-40ab-b58b-1fae7644fba8",
    "key": "DOR"
  },
  "filter": {
    "ownership": "unassigned"
  },
  "pm": {
    "autoLimit": 5,
    "approvalGates": ["hypothesis-review", "pivot-decision", "project-creation"]
  },
  "relay": {
    "channel": null
  }
}
```

| Field              | Purpose                                                                               |
| ------------------ | ------------------------------------------------------------------------------------- |
| `team.*`           | Maps this repo to its Linear team                                                     |
| `filter.ownership` | `"unassigned"` = projects with no lead, issues with no assignee. `"all"` = everything |
| `pm.autoLimit`     | Max actions `/pm auto` takes before stopping                                          |
| `pm.approvalGates` | Actions that always require human approval, even in auto mode                         |
| `relay.channel`    | Notification channel for approval gates (null = no notifications until Phase 3)       |

**How progressive discovery works:**

SKILL.md is always loaded — it provides the Loop methodology, label conventions, sizing criteria, and a template routing table. Templates are loaded **on demand** — only when needed for the current action.

```
/pm (intake step)    → reads SKILL.md → reads templates/triage-intake.md
/pm (triage step)    → reads SKILL.md → reads templates/triage-idea.md or triage-signal.md
/pm (plan step)      → reads SKILL.md → reads templates/plan-simple.md or plan-complex.md
/pm (research step)  → reads SKILL.md → reads templates/research-market.md or research-technical.md
/pm (monitor step)   → reads SKILL.md → reads templates/monitor-outcome.md
/pm (audit step)     → reads SKILL.md → reads templates/audit-workspace.md
```

### 4. Sizing Criteria

When a `type/hypothesis` reaches the Plan phase, `/pm` sizes it to determine the routing:

- **Simple** (→ `plan-simple.md`): Single file change, clearly-scoped component, <200 LOC estimated, no new architectural patterns, no cross-cutting concerns
- **Complex** (→ `plan-complex.md`): 3+ files across layers, introduces new patterns, architectural decisions needed, cross-cutting concerns, multi-session scope

When in doubt, prefer complex — it's better to over-plan than under-plan.

### 5. Linear Status Transitions

Only `/pm` and `/linear:done` change Linear issue status:

| Transition               | Who Does It           | When           |
| ------------------------ | --------------------- | -------------- |
| Triage → Backlog         | `/pm` (triage step)   | Issue accepted |
| Backlog → Todo           | Human or `/pm`        | Prioritized    |
| Todo → In Progress       | `/pm` (dispatch step) | Work begins    |
| In Progress → Done       | `/linear:done`        | Work complete  |
| Done → (creates monitor) | `/linear:done`        | For hypotheses |

The spec workflow runs entirely within the "In Progress" state — Linear doesn't see spec phases.

### 6. Blocker Verification

Issue descriptions often claim prerequisites ("spec-190 must land first", "blocked by DOR-38"). **Never report an issue as blocked without verifying the blocker's current status.** Stale blocker claims are common — the blocker may have shipped since the issue was written.

### 7. Future: Subagents (Phase 3)

When the loop runs autonomously via Pulse, dedicated subagents may be useful for batch operations:

- **Triage agent** — Batch triage of multiple issues in Triage state
- **Planner agent** — Hypothesis decomposition with codebase research
- **Monitor agent** — Outcome checking against validation criteria

These are Phase 3 deliverables. For now, `/pm` handles all operations directly.

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

### Why Ownership-Based Filtering (Not Hardcoded Project Lists)

The original design used `activeProjects` and `defaultProject` in config.json — a hardcoded list that needed updating whenever projects were created or archived. Ownership-based filtering is better:

- **Dynamic**: `/pm` discovers projects via `list_projects`, no config changes needed
- **Self-service**: Assign a lead in the Linear UI to exclude a project — no Claude Code session required
- **Applies to both projects and issues**: Projects filtered by lead, issues filtered by assignee
- **Graceful degradation**: `"all"` mode shows everything for full visibility when needed

### Why One Skill with Progressive Discovery (Not Many Skills or Linear Documents)

**Not Linear Documents** — they're constrained: must be tied to a project/initiative/issue (not standalone), have no folder/category system, MCP write operations are unreliable, and version history is not API-accessible.

**Not many separate skills** — duplicates the label taxonomy across files, competes for attention in the skill listing, and requires independent pattern matching for auto-triggering (unnecessary since slash commands are the triggers).

**One skill with templates** — follows the proven pattern. SKILL.md provides baseline conventions (always loaded). Templates in subdirectories are loaded on demand. This gives us:

- Git versioning with full history
- Directory hierarchy that mirrors the Loop methodology stages
- DRY conventions — label taxonomy written once
- Progressive context loading — only the relevant template enters context

### Why the Spec Workflow is NOT Replaced

| Aspect           | Linear Loop                        | Spec Workflow                        |
| ---------------- | ---------------------------------- | ------------------------------------ |
| **Level**        | Product strategy                   | Implementation tactics               |
| **Question**     | What should we build? Did it work? | How should we build it?              |
| **Artifacts**    | Linear issues, labels, comments    | Spec files, task JSON, ADRs          |
| **Lifecycle**    | Idea → hypothesis → monitoring     | Ideation → specification → execution |
| **Time horizon** | Continuous, cross-feature          | Per-feature, finite                  |

The Linear Loop feeds INTO the spec workflow (via `/pm` planning step) and receives results FROM it (via `/linear:done`). Spec-Linear traceability is maintained via `linear-issue` frontmatter and `linearIssue` manifest fields.

### Pull vs Push Architecture

- `/pm` pulls the current state from Linear, assesses, and acts — not pushed by webhooks
- Pulse schedules `/pm auto` on a cadence (every N hours)
- This avoids webhook infrastructure and keeps agents in control
- Linear's GitHub integration may be added in Phase 3 for PR-based status updates

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

## Phased Implementation

### Phase 1: Foundation ✓

**Goal**: `/pm` works. Human types one command, sees status, gets a recommendation, approves it.

- [x] Create label taxonomy in Linear workspace (17 labels across 4 groups + `needs-input`)
- [x] Create `linear-loop` skill with core conventions, sizing criteria, template routing
- [x] Build `/pm` command with 5 modes (status, auto, audit, direct issue, freeform intake)
- [x] Build `/linear:idea` command
- [x] Build `/linear:done` command
- [x] Implement ownership-based project filtering (`filter.ownership` in config.json)
- [x] Implement project status awareness and automatic transitions
- [x] Implement async human-in-the-loop (`needs-input` protocol)
- [x] Implement next-steps comments on every action
- [x] Add `conventions/labels.md` reference document
- [x] Update AGENTS.md with Linear conventions
- [x] Create DorkOS team in Linear with initial projects

**Delivered**: `/pm` shows the loop dashboard, recommends actions, executes on approval. `/pm <text>` classifies any input. `/pm DOR-47` works on specific issues. `/pm audit` runs workspace health checks. Ownership filtering discovers projects dynamically. Project status transitions are automatic.

### Phase 2: Structured Loop (in progress)

**Goal**: `/pm` can triage, plan, and research with structured methodology templates.

- [x] `templates/triage-intake.md` — Universal input classifier
- [x] `templates/triage-idea.md` — Idea evaluation
- [x] `templates/plan-simple.md` — Direct task decomposition
- [x] `templates/plan-complex.md` — Spec workflow bridge
- [x] `templates/audit-workspace.md` — Workspace health check
- [ ] `templates/triage-signal.md` — Signal evaluation
- [ ] `templates/research-market.md` — Market research methodology
- [ ] `templates/research-technical.md` — Technical research methodology
- [ ] `templates/dispatch-priority.md` — Priority selection algorithm
- [ ] `templates/monitor-outcome.md` — Outcome validation framework

**Success criteria**: `/pm` autonomously triages issues, decomposes hypotheses (routing complex ones through the spec workflow), and conducts structured research — all guided by methodology templates.

### Phase 3: Automated Loop

**Goal**: `/pm auto` runs on a schedule. Humans at approval gates only.

- [ ] Configure Pulse: run `/pm auto` every 2 hours
- [ ] Build dedicated subagents for batch operations (triage, planner, monitor)
- [ ] Relay integration for human approval gates (Telegram notifications)
- [ ] Signal ingestion from git events (PR merged → create monitor issue)
- [ ] Signal ingestion from error logs (spike → create signal issue)
- [ ] Evaluate Linear's GitHub integration for PR-based status updates

**Success criteria**: Pulse runs `/pm auto` on a schedule. The full loop runs: idea → triage → research → hypothesis → plan → execute → monitor → signal. Humans only intervene at Telegram approval gates.

### Phase 4: Self-Improving

**Goal**: The system improves its own methodology.

- [ ] Instruction feedback collection (agents rate skill templates after use)
- [ ] Meta-issues for template improvement (auto-created when feedback is poor)
- [ ] Hypothesis hit rate tracking (validated vs invalidated)
- [ ] Loop velocity metrics (signal → outcome cycle time)
- [ ] Prompt health dashboard (which templates work, which don't)
- [ ] Agent-proposed ideas based on codebase analysis
- [ ] External signal ingestion (PostHog, user feedback, competitor monitoring)

**Success criteria**: The system's instruction quality measurably improves over time. Loop velocity decreases. Hypothesis hit rate increases.

## What This Enables

When fully operational, this system can:

1. **Capture input** from any source (human thought, agent observation, signal, product brief, bug report) → classified Linear issue(s)
2. **Autonomously triage** against project goals → accept/decline/defer
3. **Research the opportunity** with structured investigation → findings in issue comments
4. **Form a hypothesis** with explicit validation criteria → testable prediction
5. **Route to the right workflow** — simple tasks stay in Linear, complex features flow through `/ideate` → `/spec:execute`
6. **Execute tasks** via Claude Code agent sessions → code shipped
7. **Monitor outcomes** against validation criteria → hypothesis validated/invalidated
8. **Iterate or pivot** based on evidence → new hypothesis or new direction
9. **Audit itself** — detect label issues, stale work, project status drift, spec-Linear mismatches
10. **Ask for help** — when stuck, post a question to Linear and notify the human
11. **Improve its own instructions** based on agent feedback → better skill templates
12. **Run continuously** without human intervention except at approval gates

The human sets the direction. The system does the rest. Loop.
