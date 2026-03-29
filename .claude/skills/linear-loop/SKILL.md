---
name: linear-loop
description: Loop methodology for Linear — issue taxonomy, triage framework, spec workflow bridge, and template routing for /pm and /linear:* commands. Use when working with Linear issues or running the product loop.
---

# Linear Loop

The Loop methodology implemented inside Linear + Claude Code. Everything is an issue. The issue queue is the orchestration layer.

## The Loop

```
Idea → Research → Hypothesis → Plan → Execute → Monitor → Signal → Loop continues
```

- **Linear** is the data store (issues, projects, labels, relations)
- **Claude Code** is the intelligence (triage, planning, execution, monitoring)
- **DorkOS** is the infrastructure (Pulse scheduling, Relay messaging, Mesh coordination)
- **The spec workflow** handles implementation depth (complex work routes through /ideate → /spec:execute)

## Configuration

Read `config.json` in this skill directory for repo-specific settings:

- `team` — which Linear team this repo maps to
- `activeProjects` — which projects `/pm` shows in its status view
- `pm.autoLimit` — max actions in `/pm auto` mode
- `pm.approvalGates` — actions requiring human approval even in auto mode

## Label Taxonomy

Labels are team-wide. Read `conventions/labels.md` for the full reference.

**Issue types** (group: `type`): idea, research, hypothesis, task, monitor, signal, meta

**Agent state** (group: `agent`): ready, claimed, completed

**Origin** (group: `origin`): human, from-agent, from-signal

**Confidence** (group: `confidence`): high, medium, low

## Issue Conventions

**Titles**: Direct and actionable. "Fix OAuth redirect blank page" not "As a user, I want faster sign-in."

**Descriptions**: Include enough context for an agent to act without asking questions:

- What the issue is about
- Why it matters (link to parent hypothesis or project goal)
- Acceptance criteria (how to know it's done)
- For hypotheses: validation criteria and confidence level

**Single-session scope**: Every `type/task` issue should be completable in one agent session. If it can't be, it needs decomposition.

## Spec Workflow Bridge

`/pm` and `/linear:plan` route work based on complexity:

- **Simple** (single-session, clear scope) → Linear sub-issues with `type/task` labels
- **Complex** (multi-session, needs design) → `/ideate` with Linear issue as context → spec workflow

The spec's `01-ideation.md` frontmatter gets a `linear-issue: DOR-NNN` field for traceability. `/linear:done` reads this to close the loop.

The existing spec commands (`/ideate`, `/spec:create`, `/spec:decompose`, `/spec:execute`, `/spec:feedback`) remain unchanged. They don't know about Linear. The Linear Loop commands wrap around them.

## Template Routing

`/pm` loads the appropriate template based on what action the loop needs:

| Action               | Template                          | When                                              |
| -------------------- | --------------------------------- | ------------------------------------------------- |
| Triage an idea       | `templates/triage-idea.md`        | Issue in Triage with `type/idea` label            |
| Triage a signal      | `templates/triage-signal.md`      | Issue in Triage with `type/signal` label          |
| Research (market)    | `templates/research-market.md`    | `type/research` issue about market/competitors    |
| Research (technical) | `templates/research-technical.md` | `type/research` issue about feasibility/tradeoffs |
| Plan (simple)        | `templates/plan-simple.md`        | Hypothesis that's single-session scope            |
| Plan (complex)       | `templates/plan-complex.md`       | Hypothesis that needs the spec workflow           |
| Dispatch             | `templates/dispatch-priority.md`  | Selecting the next task to work on                |
| Monitor              | `templates/monitor-outcome.md`    | Checking validation criteria for shipped work     |

Read templates **on demand** — only load the template needed for the current action. Do not preload all templates.

**Phase 2 note**: Templates are created in Phase 2. Until then, `/pm` operates without templates — use your own judgment for triage, dispatch, and other actions based on the conventions in this SKILL.md and `conventions/labels.md`.

## Linear Status Transitions

Only `/pm` and `/linear:done` change Linear issue status:

| Transition               | Who Does It           | When           |
| ------------------------ | --------------------- | -------------- |
| Triage → Backlog         | `/pm` (triage step)   | Issue accepted |
| Backlog → Todo           | Human or `/pm`        | Prioritized    |
| Todo → In Progress       | `/pm` (dispatch step) | Work begins    |
| In Progress → Done       | `/linear:done`        | Work complete  |
| Done → (creates monitor) | `/linear:done`        | For hypotheses |

The spec workflow runs entirely within the "In Progress" state — Linear doesn't see spec phases.

## Blocker Verification

Issue descriptions often claim prerequisites ("spec-190 must land first", "blocked by DOR-38"). **Never report an issue as blocked without verifying the blocker's current status.** Stale blocker claims in descriptions are common — the blocker may have shipped since the issue was written.

During ASSESS, when an issue description references a prerequisite:

- **Spec reference** (e.g., "spec-190", "Session State Manager spec"): Check `specs/*/04-implementation.md` for "Status: Complete" or read `02-specification.md` frontmatter `status:` field. Glob for the spec by name or number.
- **Linear issue reference** (e.g., "blocked by DOR-38"): Check the issue's status via `get_issue`. If it's Done, the blocker is cleared.
- **External dependency** (e.g., "needs SDK v0.2.90"): Check `package.json` or the relevant source.

Report verified status in the dashboard: "DOR-35 references spec-190 as prerequisite — **verified complete**, issue is unblocked."

## Multiple Projects

DorkOS is a team in Linear, not a single project. `/pm` assesses across all active projects (configured in `config.json`) and recommends the highest-priority action globally. Triage assigns ideas to the appropriate project. Each project has its own goals.
