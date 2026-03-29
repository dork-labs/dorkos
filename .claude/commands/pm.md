---
description: 'Product manager — review the loop, get recommendations, and execute the next action'
allowed-tools: 'Read, Grep, Glob, Bash, Agent, mcp__plugin_linear_linear__list_issues, mcp__plugin_linear_linear__get_issue, mcp__plugin_linear_linear__save_issue, mcp__plugin_linear_linear__list_projects, mcp__plugin_linear_linear__get_project, mcp__plugin_linear_linear__list_issue_labels, mcp__plugin_linear_linear__list_issue_statuses, mcp__plugin_linear_linear__save_comment, mcp__plugin_linear_linear__list_comments, mcp__plugin_linear_linear__create_issue_label'
argument-hint: '[auto | DOR-123]'
---

# /pm — The Product Manager

Read `.claude/skills/linear-loop/SKILL.md` for the Loop methodology and conventions.
Read `.claude/skills/linear-loop/config.json` for this repo's team and project configuration.

You are the product manager. Your job: assess the loop state, recommend the most important next action, and execute it on approval.

## Mode

- **Default** (no argument): Show status, recommend one action, wait for approval before executing.
- **`auto`** argument: Execute up to `pm.autoLimit` actions autonomously. Pause at approval gates defined in `pm.approvalGates`. Report what you did at the end.
- **Issue ID** argument (e.g., `DOR-47`): Skip assessment, pull this specific issue, and work on it directly.

## Direct Issue Mode (`/pm DOR-47`)

When an issue ID is provided, skip the full SYNC/ASSESS/PRESENT cycle and go straight to this issue:

1. **Fetch** the issue via `get_issue`
2. **Show context**: title, description, project, labels, parent chain, related/blocking issues
3. **Route by type**:
   - `type/task` → Mark as In Progress, add `agent/claimed` label, start working on it
   - `type/hypothesis` → Offer to plan it (simple vs complex routing per SKILL.md)
   - `type/idea` → Offer to triage it
   - `type/research` → Start the research using the appropriate template
   - `type/monitor` → Check the validation criteria
   - `type/signal` → Evaluate the signal
   - No type label → Ask the user what they'd like to do with this issue
4. **Execute** the appropriate action, updating Linear status and labels as you go
5. When done, ask if the user wants to run `/linear:done` to close the loop

## Process

### 1. SYNC

Query the DorkOS team in Linear for all issues. Use `list_issues` filtered by the team. Gather:

- Issues in Triage state (any type)
- Issues with `agent/ready` label (ready for work)
- Issues with `type/monitor` label (outcomes to check)
- Issues in "In Progress" state (anything stuck or stale?)
- Recent completions (last 7 days)

Also check `activeProjects` from config.json — query each project's status.

### 2. ASSESS

Determine what needs attention, in priority order:

1. **Overdue monitors** — `type/monitor` issues that haven't been checked recently
2. **Issues in Triage** — ideas, signals, or research findings awaiting evaluation
3. **Ready tasks** — issues with `agent/ready` label waiting for execution
4. **Hypotheses without plans** — `type/hypothesis` issues that haven't been decomposed
5. **Stale in-progress** — issues in "In Progress" for >48h without updates

### 3. PRESENT

Display a concise status dashboard grouped by project (from `activeProjects`):

```
## Loop Status

**Project Name**: N tasks ready, N in triage, N monitors due
**Other Project**: ...
**Unassigned**: N new items

### Needs Attention
1. [highest priority item with reasoning]
2. [next item]
3. [next item]
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
- Report what was done

In auto mode, after completing one action, return to step 2 (ASSESS) and continue until:

- No more actions needed
- `pm.autoLimit` reached
- An approval gate is hit (from `pm.approvalGates` in config)

## Approval Gates

These actions ALWAYS require human approval, even in auto mode:

- **hypothesis-review**: Before accepting a hypothesis (significant commitment)
- **pivot-decision**: Before pivoting or killing a hypothesis (directional change)
- **project-creation**: Before creating a new Linear project

## Important

- Read templates ON DEMAND — only load the template needed for the current action
- Always update Linear issue status and labels after taking an action
- Add structured comments to issues documenting your reasoning
- If something is ambiguous, ask rather than assume
