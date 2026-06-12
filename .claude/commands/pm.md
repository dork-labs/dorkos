---
description: 'Product manager — review the loop, get recommendations, and execute the next action'
allowed-tools: 'Read, Grep, Glob, Bash, Agent, mcp__plugin_linear_linear__list_issues, mcp__plugin_linear_linear__get_issue, mcp__plugin_linear_linear__save_issue, mcp__plugin_linear_linear__list_projects, mcp__plugin_linear_linear__get_project, mcp__plugin_linear_linear__list_issue_labels, mcp__plugin_linear_linear__list_issue_statuses, mcp__plugin_linear_linear__save_comment, mcp__plugin_linear_linear__list_comments, mcp__plugin_linear_linear__create_issue_label, mcp__plugin_linear_linear__get_authenticated_user, mcp__plugin_linear_linear__save_project'
argument-hint: '[auto | audit | DOR-123 | <text or file path>]'
---

# /pm — The Product Manager

Read `.claude/skills/linear-loop/SKILL.md` for the Loop methodology and conventions.
Read `.claude/skills/linear-loop/config.json` for this repo's team and project configuration.

You are the product manager. Your job: assess the loop state, recommend the most important next action, and execute it on approval.

## Mode

- **Default** (no argument): Show status, recommend one action, wait for approval before executing.
- **`auto`** argument: Execute up to `pm.autoLimit` actions autonomously. Pause at approval gates defined in `pm.approvalGates`. Report what you did at the end.
- **Issue ID** argument (e.g., `DOR-47`): Skip assessment, pull this specific issue, and work on it directly.
- **`audit`** argument: Run a workspace health check — find issues with wrong/missing labels, projects in wrong status, stale work, orphaned issues. Load `templates/audit-workspace.md`.
- **Freeform input** (anything else): Classify the input and create appropriate issue(s) via the intake template. If the argument is a file path, read the file first.

## Freeform Input Mode

When the argument is not `auto` and does not match a `DOR-` issue ID pattern:

1. Read the intake template: `.claude/skills/linear-loop/templates/triage-intake.md`
2. Follow the classification rubric to determine input type
3. Create the appropriate issue(s) in Linear — set native priority and estimate, and place per the orphan policy (SKILL.md "Priority and Estimates" / "Orphan Issues")
4. Add next-steps comment to each created issue (per SKILL.md convention)
5. Report what was created: issue ID(s), type(s), priority/estimate, project assignment(s)

## Direct Issue Mode (`/pm DOR-47`)

When an issue ID is provided, skip the full SYNC/ASSESS/PRESENT cycle and go straight to this issue:

1. **Fetch** the issue via `get_issue`
2. **Show context**: title, description, project, labels, parent chain, related/blocking issues
3. **Route by type**:
   - `type/task` → **Choose the workspace first** (per the `working-in-worktrees` skill — default to an isolated worktree, since this checkout is usually shared with other agents and the auto-checkpoint hook corrupts concurrent writers). Then mark In Progress, add `agent/claimed` label, and start working.
   - `type/hypothesis` → Offer to plan it (simple vs complex routing per SKILL.md Sizing Criteria)
   - `type/idea` → Offer to triage it (load `templates/triage-idea.md`)
   - `type/research` → Start the research using the appropriate template
   - `type/monitor` → Check the validation criteria
   - `type/signal` → Evaluate the signal
   - No type label → Ask the user what they'd like to do with this issue
4. **Execute** the appropriate action, updating Linear status and labels as you go
5. Add a next-steps comment after any action
6. When done, ask if the user wants to run `/linear:done` to close the loop

## Process

### 1. SYNC

First, get the authenticated user via `get_authenticated_user` — cache the user ID for this run.

Read `config.json` for the ownership filter setting (`filter.ownership`).

**Discover projects dynamically:**

1. Call `list_projects(team: "dorkos")` — do NOT use `includeMembers: true` (causes query complexity errors)
2. Exclude projects in Completed or Cancelled status (they're done)
3. Apply ownership filter:
   - `"unassigned"`: keep projects where lead is null/unassigned
   - `"all"`: keep all projects
4. Store the filtered project list with their current status (Backlog, Planned, In Progress)

**Manage project status transitions** (per SKILL.md "Project Status Transitions"):

- When triaging an issue into a Backlog project → update project to Planned
- When an issue moves to In Progress in a Planned project → update project to In Progress
- When all issues in an In Progress project are Done and monitors cleared → update project to Completed

**Query issues across filtered projects:**

Apply the same ownership filter to issues (matching on assignee):

- Issues in Triage state (any type)
- Issues with `agent/ready` label (ready for work)
- Issues with `type/monitor` label (outcomes to check)
- Issues in "In Progress" state (anything stuck or stale?)
- Recent completions (last 7 days)

**Always check for `needs-input` responses (regardless of ownership filter):**

- Call `list_issues(team: "dorkos", label: "needs-input", includeArchived: false)`
- For each: call `list_comments` to check for human responses
- If a comment exists after the agent's last question: queue for processing (remove `needs-input` label, set assignee to null, act on the answer)
- If no response yet: add to "Awaiting Your Input" dashboard section
- Key rule: read these issues but ONLY take action based on the human's actual responses

### 1b. SYNC — Spec Awareness

After syncing Linear state, also check the spec manifest for active work linked to projects (see SKILL.md "Spec-Linear Bridge" → "/pm Spec Awareness"):

1. Read `specs/manifest.json`
2. For each spec with a `linearIssue` field, match it to a project's issues
3. Check spec status: `ideation`, `specified`, `implemented`, `superseded`
4. For non-terminal specs (`ideation` or `specified`), check which documents exist on disk (`01-ideation.md`, `02-specification.md`, `03-tasks.json`) to determine where the spec workflow was interrupted
5. Store active specs for use in ASSESS and PRESENT

### 2. ASSESS

Determine what needs attention, in priority order:

1. **Needs-input responses** — issues where the human answered an agent's question (process immediately)
2. **Expedite work** — Urgent (P1) issues, or issues whose due-date slack has run out (`templates/dispatch-priority.md` rules 1–2)
3. **Interrupted specs** — specs linked to project issues that are not `implemented`/`superseded`. Recommend the resume command from the Spec-Linear Bridge table in SKILL.md.
4. **Overdue monitors** — `type/monitor` issues that haven't been checked recently
5. **Issues in Triage** — ideas, signals, or research findings awaiting evaluation. While triaging, backfill missing native priority/estimate and convert prose blocker claims to Linear relations (SKILL.md "Priority and Estimates").
6. **Ready tasks** — issues with `agent/ready` label waiting for execution. When several compete, load `templates/dispatch-priority.md` and apply it: project WIP cap of 2, finish the nearest-complete project first, then priority → smallest estimate → oldest within it.
7. **Hypotheses without plans** — `type/hypothesis` issues that haven't been decomposed
8. **Stale in-progress** — issues in "In Progress" for >48h without updates, stale `agent/claimed` labels, and projects past their circuit breaker (in progress > 2× appetite — escalate, don't keep feeding)
9. **Falsely complete projects** — projects where all Linear issues are Done but an active (non-terminal) spec exists. Do NOT recommend closing these projects. Instead, recommend resuming the spec.
10. **Empty projects** — projects with zero active issues AND no active specs. Per SKILL.md "Project Conventions": if the project is really issue-sized work parked as a project, recommend converting it to an issue and cancelling the project.

### 3. PRESENT

Display a concise status dashboard:

```
## Loop Status

### Awaiting Your Input
- DOR-45: "Should we use WebSocket or SSE?" (asked 2h ago)

### Projects
**Project Name** [In Progress]: N tasks ready, N in triage, N monitors due
  → spec-211 (tasks-system-redesign): specified — next: /spec:decompose
**Other Project** [Planned]: N items in backlog
**Unassigned**: N items not in any project

### Active Specs (from specs/manifest.json)
- spec-211 (tasks-system-redesign) → DOR-63 [In Progress]: specified, needs decomposition

### Needs Attention
1. [highest priority item with reasoning]
2. [next item]
3. [next item]

### Empty Projects (consider archiving or populating — only if no active specs)
- Project X: no active issues, no linked specs
```

### 4. RECOMMEND

State the single most important next action with reasoning:

- Why this action, not something else
- What template to load (from the Template Routing table in SKILL.md)
- What the expected outcome is

### 5. EXECUTE (on approval)

When the user approves (or in auto mode):

- Read the appropriate template from `.claude/skills/linear-loop/templates/`
- Execute the action using Linear MCP tools
- Update the issue status and labels as needed
- Add a next-steps comment to the issue (per SKILL.md convention)
- Report what was done

In auto mode, after completing one action, return to step 2 (ASSESS) and continue until:

- No more actions needed
- `pm.autoLimit` reached
- An approval gate is hit (from `pm.approvalGates` in config)
- Ambiguity requires human input (create `needs-input` issue per SKILL.md protocol)

## Approval Gates

These actions ALWAYS require human approval, even in auto mode:

- **hypothesis-review**: Before accepting a hypothesis (significant commitment)
- **pivot-decision**: Before pivoting or killing a hypothesis (directional change)
- **project-creation**: Before creating a new Linear project

## Async Questions (auto mode)

When `/pm auto` encounters ambiguity it cannot resolve:

1. Post a structured comment on the issue with the question (multiple choice when possible)
2. Add `needs-input` label
3. Assign the issue to the authenticated user (sends a Linear notification)
4. Skip this issue and continue to next action

See SKILL.md "Async Human Questions" section for the full protocol.

## Important

- Read templates ON DEMAND — only load the template needed for the current action
- Always update Linear issue status and labels after taking an action
- Always add a next-steps comment after any action (per SKILL.md convention)
- **Before any code change** — dispatching an `agent/ready` task, or working a `type/task` in Direct Issue Mode — choose the workspace per the `working-in-worktrees` skill. Default to an isolated worktree; the main checkout is routinely shared with other agents. (Triage, planning, and research stay in `main`.)
- If something is ambiguous, ask rather than assume
