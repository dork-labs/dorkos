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
- `filter.ownership` — how `/pm` scopes projects and issues:
  - `"unassigned"` (default) — projects with no lead, issues with no assignee
  - `"all"` — everything in the team, no filtering
- `pm.autoLimit` — max actions in `/pm auto` mode
- `pm.approvalGates` — actions requiring human approval even in auto mode

## Accessing Linear

Two interchangeable access paths reach the same workspace and DorkOS team (see `config.json` — slug `dorkos`, id `a171dbd5-3ccc-40ab-b58b-1fae7644fba8`, key `DOR`):

1. **Linear MCP tools** (primary) — `mcp__linear__*` (`list_issues`, `list_projects`, `create_issue`, …). Requires the in-session MCP server to be authenticated (OAuth); if it isn't, start the flow with `mcp__linear__authenticate`. The spec-command breadcrumbs below post only when these tools are available.
2. **Composio CLI** (fallback — works even when the MCP server is unauthenticated; see the `composio-cli` skill). Two Linear accounts are connected in Composio, so **always pass `--account personal`** — that is the DorkOS + Dunny workspace. The other account, `artblocks`, is unrelated work and must **never** receive DorkOS issues. Linear slugs are `LINEAR_*`:

   ```bash
   composio execute LINEAR_LIST_LINEAR_TEAMS --account personal -d '{}'
   composio execute LINEAR_LIST_LINEAR_PROJECTS --account personal -d '{}'
   composio search "list linear issues" "create a linear issue" --toolkits linear   # discover other slugs
   ```

## Linear Query Conventions

**Always exclude archived issues.** Pass `includeArchived: false` on every `list_issues` call. The Linear API defaults to `includeArchived: true`, which pulls in archived issues from deleted projects — these are noise.

**Don't use `includeMembers: true` on `list_projects`.** It causes GraphQL query complexity errors. Fetch member details separately if needed.

## Label Taxonomy

Labels are team-wide. Read `conventions/labels.md` for the full reference.

**Issue types** (group: `type`): idea, research, hypothesis, task, monitor, signal, meta

**Agent state** (group: `agent`): ready, claimed, completed, needs-input

**Origin** (group: `origin`): human, from-agent, from-signal

**Confidence** (group: `confidence`): high, medium, low

## Priority and Estimates

Use Linear's **native fields**, not labels, for urgency and size. The orchestration extension sorts on these same fields — see `templates/dispatch-priority.md`. Full rationale: `research/20260611_work-sequencing-linear-method.md`.

**Priority** (Urgent / High / Medium / Low):

- Required on all **actionable** work: `type/task`, anything `agent/ready`, committed research.
- Optional on pre-commitment issues (`type/idea`, untriaged items) — no-priority sorts last in dispatch, which is correct for uncommitted work.
- Priority is _relative ordering within the current window_, not a deadline. Urgent means "preempts everything" (kanban expedite class) — at most one Urgent in flight; two simultaneous Urgents means priority inflation.

**Estimate** (Fibonacci scale — agent-centric semantics):

| Estimate | Meaning                                          |
| -------- | ------------------------------------------------ |
| 1        | Single focused agent session                     |
| 2        | A couple of sessions                             |
| 3        | Multi-session; consider sub-issues               |
| 5        | Decompose into sub-issues, or promote to project |
| 8        | This is a project, not an issue                  |

- Set at creation or triage (the intake template does this).
- **Estimate ≥ 5 is a decomposition trigger**, not a size to schedule.
- In sequencing, estimate is a **same-priority tiebreaker only** (smallest first) — it never overrides priority. It also feeds the circuit breaker: work in progress longer than ~2× its estimate escalates to the human.

**Due dates**: only for genuinely fixed external dates (releases, external commitments) — never as a planning tool; use priority and project target dates instead. A due date promotes the issue to expedite when its slack runs out (see dispatch template).

**Dependencies**: express as **Linear blocking relations**, never prose. The orchestration extension reads only the relation graph (`blocked_by`); "blocked by DOR-38" in a description is invisible to it. When triage finds a prose blocker claim, convert it to a relation.

## Issue Conventions

**Titles**: Direct and actionable. "Fix OAuth redirect blank page" not "As a user, I want faster sign-in."

**Descriptions**: Include enough context for an agent to act without asking questions:

- What the issue is about
- Why it matters (link to parent hypothesis or project goal)
- Acceptance criteria (how to know it's done)
- **Completion routing** (what should happen next when this is done — see below)
- For hypotheses: validation criteria and confidence level

**Completion routing**: Every issue must define what happens next when it completes. This is how the Loop keeps spinning. Without it, completed issues become dead ends. The routing depends on the issue type:

| Issue type        | Default completion routing                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `type/research`   | "When done → create hypothesis or run `/ideate` if complex, create `type/task` sub-issues if simple" |
| `type/hypothesis` | "When validated → create `type/monitor` to track outcomes"                                           |
| `type/task`       | "When done → check if parent hypothesis/spec has all tasks complete"                                 |
| `type/monitor`    | "When criteria met → create `type/signal` or close the loop"                                         |
| `type/idea`       | "When triaged → route to research, hypothesis, or task"                                              |

When creating or triaging an issue, add a `## On Completion` section to the description:

```markdown
## On Completion

- [ ] Create spec via `/ideate` (complex: 3+ files, cross-cutting)
- [ ] Link spec to DOR-NNN in frontmatter
- [ ] Or: create `type/task` sub-issues (simple: single-session scope)
```

This serves three purposes:

1. **Prevention**: The person creating the issue thinks about what comes next
2. **Guidance**: `/linear:done` reads this section to recommend the right action
3. **Self-healing**: If `/linear:done` misses it, `/pm` can read it during ASSESS

**Single-session scope**: Every `type/task` issue should be completable in one agent session. If it can't be, it needs decomposition.

## Spec Workflow Bridge

`/pm` and `/linear:plan` route work based on complexity:

- **Simple** (single-session, clear scope) → Linear sub-issues with `type/task` labels
- **Complex** (multi-session, needs design) → `/ideate` with Linear issue as context → spec workflow

The spec's `01-ideation.md` frontmatter gets a `linear-issue: DOR-NNN` field for traceability. `/linear:done` reads this to close the loop. When a spec is routed through `plan-complex.md`, also add a `linearIssue` field to `specs/manifest.json` for that spec entry — this enables reverse lookups ("which specs are linked to this project?") and cross-reference auditing.

The existing spec commands (`/ideate`, `/spec:create`, `/spec:decompose`, `/spec:execute`, `/spec:feedback`) remain unchanged. They don't know about Linear. The Linear Loop commands wrap around them.

## Sizing Criteria

When a `type/hypothesis` reaches the Plan phase, size it to determine the template:

- **Simple** (→ `plan-simple.md`): Single file change, clearly-scoped component, < 200 LOC estimated, no new architectural patterns, no cross-cutting concerns
- **Complex** (→ `plan-complex.md`): 3+ files across layers, introduces new patterns, architectural decisions needed, cross-cutting concerns, multi-session scope

When in doubt, prefer complex — it's better to over-plan than under-plan.

## Template Routing

`/pm` loads the appropriate template based on what action the loop needs:

| Action                | Template                          | When                                              |
| --------------------- | --------------------------------- | ------------------------------------------------- |
| Intake classification | `templates/triage-intake.md`      | Freeform input to `/pm` (not `auto` or `DOR-` ID) |
| Triage an idea        | `templates/triage-idea.md`        | Issue in Triage with `type/idea` label            |
| Triage a signal       | `templates/triage-signal.md`      | Issue in Triage with `type/signal` label          |
| Research (market)     | `templates/research-market.md`    | `type/research` issue about market/competitors    |
| Research (technical)  | `templates/research-technical.md` | `type/research` issue about feasibility/tradeoffs |
| Plan (simple)         | `templates/plan-simple.md`        | Hypothesis that's single-session scope            |
| Plan (complex)        | `templates/plan-complex.md`       | Hypothesis that needs the spec workflow           |
| Dispatch              | `templates/dispatch-priority.md`  | Selecting the next task to work on                |
| Monitor               | `templates/monitor-outcome.md`    | Checking validation criteria for shipped work     |
| Audit                 | `templates/audit-workspace.md`    | `/pm audit` — workspace health check              |

Read templates **on demand** — only load the template needed for the current action. Do not preload all templates.

Templates that don't yet exist (triage-signal, research-market, research-technical, monitor-outcome) are Phase 2 deliverables. For those actions, use your own judgment based on the conventions in this SKILL.md and `conventions/labels.md`.

## Next-Steps Comments

After `/pm` takes any action on an issue, add a structured comment:

```
**Agent Action** — [YYYY-MM-DD]
**Action:** [what was done — e.g., "Triaged idea, moved to Backlog"]
**Reasoning:** [brief — e.g., "Aligns with SDK Upgrade project goals"]
**Next steps:** [what should happen next — e.g., "Research phase to validate feasibility"]
```

This makes issues self-documenting. Anyone (human or agent) can read the last comment to understand current state without re-running `/pm`.

## Async Human Questions (needs-input)

When `/pm auto` hits ambiguity it cannot resolve:

1. Post a structured comment with the question:
   - Frame as multiple choice when possible (A/B/C options)
   - Include context: why this decision matters, what the agent considered
   - End with: "Reply to this comment with your choice, then run `/pm` to continue."
2. Add `needs-input` label to the issue
3. Assign the issue to the authenticated user (via `get_authenticated_user`) — this sends a Linear notification
4. Skip this issue and continue to next action

**SYNC phase handling:**

- Always query issues with `needs-input` label regardless of ownership filter
- Read comments on those issues via `list_comments`
- If user posted a comment after the agent's question: remove `needs-input` label, set assignee to null, process the answer
- If no response yet: show in dashboard under "Awaiting Your Input" section
- The agent reads `needs-input` issues but ONLY takes action based on the human's actual responses — never assume or guess an answer

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

### Claiming Contract

The claim signal is shared with the orchestration extension — both systems read and write the same markers, so neither double-dispatches the other's work:

- **`agent/ready`** is the dispatch gate: only issues carrying it are eligible for autonomous pickup.
- **Claiming = `agent/claimed` label + Todo → In Progress**, written at dispatch time. Claims are durable in the tracker (unlike Symphony's in-memory claims), so they survive restarts and are visible to every other agent.
- **Assignee is the human-notification channel** (`needs-input` protocol) — it is never used for agent routing. Agents route by labels.
- A claim with no progress evidence for >24h is stale — flag it during ASSESS rather than dispatching over it.

## Project Status Transitions

Projects have their own lifecycle, separate from issues:

| Status      | Meaning                                |
| ----------- | -------------------------------------- |
| Backlog     | Project exists but no work planned yet |
| Planned     | Work is scoped but hasn't started      |
| In Progress | Active work underway                   |
| Completed   | All work finished, goals met           |
| Cancelled   | Project abandoned                      |

**`/pm` manages project status automatically:**

| Transition              | When                                                        |
| ----------------------- | ----------------------------------------------------------- |
| Backlog → Planned       | First issue is triaged into the project                     |
| Planned → In Progress   | First issue in the project moves to "In Progress"           |
| In Progress → Completed | All issues in the project are Done and monitors are cleared |

**SYNC phase filtering:** Exclude projects in Completed or Cancelled states — they're done, don't show them in the dashboard. If a Completed project gets a new issue (e.g., a regression signal), move it back to In Progress automatically.

**Approval note:** Moving a project to Completed does NOT require the `project-creation` approval gate. It's a natural conclusion, not a commitment decision.

## Loop Continuity

**Closing an issue is not the end — it's a transition to the next Loop phase.** When `/linear:done` or `/pm` closes an issue, the system must assess what the project needs next and recommend (or execute) the next action.

### Phase Transitions

After closing an issue, check what type it was and what the project state looks like:

| Closed issue type | Project state after close                   | Next action                                                                                                                                           |
| ----------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type/research`   | All research in project is Done             | Recommend creating a hypothesis or spec. If complex (3+ files, cross-cutting): suggest `/ideate`. If simple: suggest creating `type/task` sub-issues. |
| `type/research`   | Other research still open                   | Note the unblocked issues. No project-level action needed.                                                                                            |
| `type/hypothesis` | Hypothesis validated                        | Create `type/monitor` issue (existing behavior).                                                                                                      |
| `type/task`       | Other tasks still open in parent hypothesis | Note progress. No project-level action needed.                                                                                                        |
| `type/task`       | All tasks under parent hypothesis are Done  | Recommend closing the hypothesis via `/linear:done`.                                                                                                  |
| `type/monitor`    | All monitors in project cleared             | Recommend moving project to Completed.                                                                                                                |
| Any type          | Project has zero remaining active issues    | Recommend moving project to Completed.                                                                                                                |

### Implementation in `/linear:done`

After closing the issue (step 4), `/linear:done` performs a **Project Pulse Check**:

1. Query remaining issues in the same project (if the issue has a project)
2. Group by type and status
3. Detect the relevant transition from the table above
4. Present the recommendation: _"All research in Tasks System Redesign is complete. This is complex work — recommend running `/ideate` to create a spec. Want to proceed?"_

This keeps the Loop spinning without the user needing to remember what comes next.

## Spec-Linear Bridge

The spec workflow (`/ideate` → `/spec:create` → `/spec:decompose` → `/spec:execute`) runs independently from Linear. This bridge protocol connects them so `/pm` can track spec progress, detect interrupted work, and keep the Loop spinning.

**Linear integration is always optional.** If no `linear-issue:` field exists in the spec frontmatter, the spec workflow works exactly as before.

### Frontmatter Convention

When a spec is linked to Linear, the `01-ideation.md` frontmatter includes:

```yaml
---
slug: tasks-system-redesign
number: 211
linear-issue: DOR-63
created: 2026-03-29
status: ideation
---
```

The `linear-issue` field is also added to the spec's entry in `specs/manifest.json` as `linearIssue`.

### Breadcrumb Comments

Each spec phase transition posts a structured comment to the linked Linear issue:

```
**Spec Progress** — [YYYY-MM-DD]
**Phase:** [phase name]
**Spec:** `specs/{slug}/`
**Document:** `[latest document path]`
**Next:** [what to run next, or "Implementation complete — run `/linear:done DOR-NNN`"]
```

Phase names: `Ideation Started`, `Specification Created`, `Decomposed into N tasks`, `Execution Started`, `Implementation Complete`.

### Spec Commands: Linear Integration Steps

Each spec command checks for `linear-issue:` in the spec frontmatter. If present and Linear MCP tools are available, it posts a breadcrumb comment. If not present or tools unavailable, it silently skips.

| Command           | When to post                        | Phase name                |
| ----------------- | ----------------------------------- | ------------------------- |
| `/ideate`         | After writing `01-ideation.md`      | `Ideation Started`        |
| `/ideate-to-spec` | After writing `02-specification.md` | `Specification Created`   |
| `/spec:create`    | After writing `02-specification.md` | `Specification Created`   |
| `/spec:decompose` | After writing `03-tasks.json`       | `Decomposed into N tasks` |
| `/spec:execute`   | At start of execution               | `Execution Started`       |
| `/spec:execute`   | After all tasks complete            | `Implementation Complete` |

### `/spec:execute` Completion Bridge

When `/spec:execute` finishes all tasks and a `linear-issue:` field exists:

1. Post the `Implementation Complete` breadcrumb comment
2. Update spec manifest status to `implemented`
3. Display: _"Spec complete. Linked to DOR-NNN. Run `/linear:done DOR-NNN` to close the loop."_

This is the bridge that returns control from the spec workflow back to Linear.

### `/pm` Spec Awareness

During the ASSESS phase, `/pm` reads `specs/manifest.json` to detect active spec work:

1. **Find linked specs**: For each In Progress project, check if any spec in the manifest has a `linearIssue` field matching an issue in that project.
2. **Check spec status**: If the spec is not `implemented` or `superseded`, the project has active work — do NOT recommend closing the project.
3. **Detect interrupted specs** and recommend the right resume command:

| Spec status   | Has `02-specification.md`? | Has `03-tasks.json`? | Recommendation                                         |
| ------------- | -------------------------- | -------------------- | ------------------------------------------------------ |
| `ideation`    | No                         | No                   | Run `/ideate-to-spec specs/{slug}/01-ideation.md`      |
| `specified`   | Yes                        | No                   | Run `/spec:decompose specs/{slug}/02-specification.md` |
| `specified`   | Yes                        | Yes                  | Run `/spec:execute specs/{slug}/02-specification.md`   |
| `implemented` | Yes                        | Yes                  | Run `/linear:done DOR-NNN` to close the loop           |

4. **Dashboard display**: Show active specs in the project status section:

```
**Tasks System Redesign** [In Progress]: spec-211 in execution (12/18 tasks complete)
```

### Self-Correcting Properties

The system corrects itself through redundant detection:

- **At transition time**: `/linear:done` catches phase transitions via Loop Continuity
- **At review time**: `/pm` catches interrupted specs, falsely complete projects, and missing bridges
- **At spec completion**: `/spec:execute` explicitly prompts for `/linear:done`

If any one of these is missed, the next review cycle catches it. The Loop never silently stops.

## Blocker Verification

Issue descriptions often claim prerequisites ("spec-190 must land first", "blocked by DOR-38"). **Never report an issue as blocked without verifying the blocker's current status.** Stale blocker claims in descriptions are common — the blocker may have shipped since the issue was written.

During ASSESS, when an issue description references a prerequisite:

- **Spec reference** (e.g., "spec-190", "Session State Manager spec"): Check `specs/*/04-implementation.md` for "Status: Complete" or read `02-specification.md` frontmatter `status:` field. Glob for the spec by name or number.
- **Linear issue reference** (e.g., "blocked by DOR-38"): Check the issue's status via `get_issue`. If it's Done, the blocker is cleared.
- **External dependency** (e.g., "needs SDK v0.2.90"): Check `package.json` or the relevant source.

Report verified status in the dashboard: "DOR-35 references spec-190 as prerequisite — **verified complete**, issue is unblocked."

## Multiple Projects

DorkOS is a team in Linear, not a single project. `/pm` discovers active projects dynamically using the ownership filter in `config.json`. With `"unassigned"` ownership (default), `/pm` shows projects that have no lead assigned — assign a lead in the Linear UI to exclude a project from `/pm` scope. Triage assigns ideas to the appropriate project. Each project has its own goals.

### Project Conventions (Linear Method)

- A project is a **committed, time-bound deliverable**: 1–3 weeks of work, with a one-paragraph brief, a target date, and a project priority. If you can't write the brief, it isn't ready to be a project.
- **Create projects at the commitment moment** (hypothesis accepted, betting decision) — not at idea capture.
- **Never create a single-issue project.** If the work deserves a project, planning will decompose it into multiple issues; if it can't be decomposed, it's an issue. (Issue-sized work parked as zero-issue projects was exactly the anti-pattern cleaned up in 2026-06.)
- **Project WIP cap: 2 in-progress projects.** Finish what's started before opening a new front — see `templates/dispatch-priority.md`.

### Orphan Issues (no project)

- **Pre-commitment issues** (`type/idea`, exploratory `type/research`) may live project-less in Triage/Backlog. That's healthy — projects come at commitment, not capture.
- **Committed executable work** (`type/task`, anything `agent/ready`) must have a home: a thematic project it advances, or the persistent **Maintenance** project.
- **Maintenance** is a persistent project that never completes. It holds small standalone committed work (bugs not tied to a theme, small UX improvements, dependency updates). It gets ~20% of capacity — worked steadily, never ahead of committed project work. It also keeps small work visible to project-scoped dispatchers: a project-less issue can never be dispatched by the orchestration extension.

## Empty Project Detection

During ASSESS, check for projects with zero active issues (nothing in Triage, Backlog, Todo, or In Progress). Distinguish by project status:

- **Backlog/Planned with no issues** → Recommend populating with ideas/tasks, or assigning a lead to exclude it
- **In Progress with no active issues** → All work may be done — recommend moving to Completed if all issues are Done
- **In Progress with only Done issues** → Move to Completed automatically (no approval needed)
