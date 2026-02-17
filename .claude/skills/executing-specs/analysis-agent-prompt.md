# Analysis Agent Prompt

> **Loaded by**: `executing-specs` skill during Phase 2
> **Variables to substitute**: `[SPEC_PATH]`, `[SLUG]`

---

You are analyzing a specification execution to build an optimized execution plan.

## Context
- **Spec File**: [SPEC_PATH]
- **Feature Slug**: [SLUG]
- **Implementation File**: specs/[SLUG]/04-implementation.md
- **Tasks File**: specs/[SLUG]/03-tasks.md

## Your Tasks

### 1. Load All Tasks

Use `TaskList()` to get all tasks for this feature:
```
tasks = TaskList()
feature_tasks = tasks.filter(t => t.subject.includes("[<slug>]"))
```

Categorize by status:
- `completed`: Skip these
- `in_progress`: Resume these first
- `pending`: Execute these

### 2. Parse Session Context (if resuming)

If `specs/[SLUG]/04-implementation.md` exists:

1. **Extract session number**: Find last "### Session N" header
2. **Extract completed tasks**: All tasks marked with checkmarks
3. **Extract files modified**: From "Files Modified/Created" section
4. **Extract known issues**: From "Known Issues" section
5. **Extract in-progress status**: From "Tasks In Progress" section

Build cross-session context string for agents.

### 3. Build Execution Batches

Group tasks into parallel batches using dependency analysis:

```
# Get pending/in-progress tasks
executable_tasks = feature_tasks.filter(t =>
  t.status === "pending" || t.status === "in_progress"
)

# Build batches based on blockedBy
batches = []
remaining = [...executable_tasks]

while remaining.length > 0:
  # Find tasks with no remaining dependencies (or all deps completed)
  ready = remaining.filter(t =>
    t.blockedBy.length === 0 ||
    all_completed(t.blockedBy)
  )

  if ready.length === 0: # Circular dependency or missing task - break cycle
    ready = [remaining[0]]

  batches.push(ready)
  remaining = remaining.filter(t => !ready.includes(t))
```

### 4. Determine Agent Types

For each task, determine the appropriate specialist agent:

| Task Pattern | Agent Type |
|-------------|------------|
| Database, Prisma, schema, migration | `prisma-expert` |
| React, component, UI, form | `react-tanstack-expert` |
| TypeScript, types, generics | `typescript-expert` |
| Zod, validation, schema | `zod-forms-expert` |
| API, route, endpoint | `general-purpose` |
| Test, spec, coverage | `general-purpose` |
| Default | `general-purpose` |

### 5. Return Execution Plan

Return a structured execution plan in this format:

```
## EXECUTION PLAN

### Session Info
- **Session Number**: [N]
- **Resume Mode**: [true/false]
- **Previous Session Date**: [date or N/A]

### Task Summary
- **Completed (skip)**: [count]
- **In Progress (resume)**: [count]
- **Pending (execute)**: [count]
- **Total Executable**: [count]

### Cross-Session Context
[If resuming, include the context string to pass to agents]

### Execution Batches

#### Batch 1 (No dependencies)
| Task ID | Subject   | Agent Type | Size    |
| ------- | --------- | ---------- | ------- |
| [id]    | [subject] | [agent]    | [S/M/L] |

#### Batch 2 (Depends on Batch 1)
| Task ID | Subject   | Agent Type | Size    |
| ------- | --------- | ---------- | ------- |
| [id]    | [subject] | [agent]    | [S/M/L] |

[Continue for all batches...]

### Parallelization Summary
- **Total batches**: [N]
- **Max parallel tasks**: [M] (in Batch [X])
- **Sequential equivalent**: [T] tasks
- **Parallelization factor**: [T/N]x speedup potential
```
