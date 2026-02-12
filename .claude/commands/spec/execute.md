---
description: Implement a validated specification by orchestrating concurrent agents
category: validation
allowed-tools: Task, TaskOutput, Read, Write, Grep, Glob, Bash(jq:*), Bash(grep:*), Bash(cat:*), Bash(echo:*), Bash(date:*), Bash(mkdir:*), TaskCreate, TaskList, TaskGet, TaskUpdate, AskUserQuestion
argument-hint: "<path-to-spec-file>"
---

# Implement Specification

Implement the specification at: $ARGUMENTS

## Context-Saving Architecture

This command uses a **parallel background agent** pattern for maximum efficiency:

1. **Main context**: Lightweight orchestration only (~10% of context)
2. **Analysis agent**: Session parsing, context building (isolated)
3. **Implementation agents**: Parallel task execution (isolated, concurrent)

**Context savings**: ~85-90% reduction vs sequential foreground execution

**Performance gain**: Parallelizable tasks run concurrently instead of sequentially

---

## Phase 1: Setup (Main Context - Lightweight)

### 1.1 Extract Feature Slug

```bash
SPEC_FILE="$ARGUMENTS"
SLUG=$(echo "$SPEC_FILE" | cut -d'/' -f2)
TASKS_FILE="specs/$SLUG/03-tasks.md"
IMPL_FILE="specs/$SLUG/04-implementation.md"
```

Display:
```
📋 Executing specification: $ARGUMENTS
   Feature slug: [slug]
```

### 1.2 Quick Validation

Perform lightweight checks in main context:

1. **Verify spec exists**: Check `$SPEC_FILE` exists
2. **Verify tasks exist**: Use `TaskList()` to check for tasks with `[<slug>]` in subject
   - If no tasks → Display: "⚠️ No tasks found. Run `/spec:decompose` first."
   - Exit early

3. **Quick session check**: Check if `$IMPL_FILE` exists
   - If exists → Resume mode detected
   - If not → New session

Display:
```
🔍 Quick validation:
   ✅ Specification found
   ✅ Tasks found: [count] tasks for [slug]
   [🆕 New implementation / 🔄 Resuming previous session]
```

---

## Phase 2: Spawn Analysis Agent

Launch a background agent to handle heavy session parsing and execution planning.

```
Task(
  description: "Analyze [slug] execution plan",
  prompt: <see ANALYSIS_AGENT_PROMPT>,
  subagent_type: "general-purpose",
  run_in_background: true
)
```

Display:
```
🔄 Analyzing tasks and building execution plan...
```

Then immediately wait for the analysis to complete:
```
TaskOutput(task_id: "<analysis-agent-id>", block: true)
```

The analysis agent returns a structured execution plan.

---

## Phase 3: Execute Task Batches (Parallel Background Agents)

Using the execution plan from the analysis agent, execute tasks in parallel batches.

### 3.1 Display Execution Plan

```
═══════════════════════════════════════════════════
              EXECUTION PLAN
═══════════════════════════════════════════════════

📊 Task Summary:
   ✅ Completed: [X] tasks (skipping)
   🔄 In Progress: [Y] tasks (will resume)
   ⏳ Pending: [Z] tasks (will execute)

📦 Execution Batches (parallel groups):
   Batch 1: [Task 1.1, 1.2, 1.3] - No dependencies
   Batch 2: [Task 2.1, 2.2] - Depends on Batch 1
   Batch 3: [Task 2.3, 2.4, 2.5] - Depends on Batch 2
   ...

⏱️  Estimated: [N] parallel batches
    (vs [M] sequential tasks without parallelization)

═══════════════════════════════════════════════════
```

### 3.2 Ask User to Proceed

```
AskUserQuestion:
  "Ready to execute [Z] tasks in [N] parallel batches?"
  Options:
  - "Execute all batches" (Recommended) - Run all tasks to completion
  - "Execute one batch" - Run only the first batch, then pause
  - "Review tasks first" - Show detailed task list before executing
```

### 3.3 Execute Each Batch

For each batch in the execution plan:

**Step A: Launch all tasks in batch as background agents**

```
# For each task in current batch, launch in parallel:
for task in batch.tasks:
  Task(
    description: "Implement [task.subject]",
    prompt: <see IMPLEMENTATION_AGENT_PROMPT with task details>,
    subagent_type: <specialist matching task type>,
    run_in_background: true
  )
  # Store task_id for later collection
```

Display:
```
🚀 Batch [N]: Launching [X] parallel agents
   → [Task 1.1] Implement user authentication schema
   → [Task 1.2] Create login form component
   → [Task 1.3] Set up session middleware
```

**Step B: Wait for all agents in batch to complete**

```
# Collect results from all background agents
for agent_id in batch.agent_ids:
  result = TaskOutput(task_id: agent_id, block: true)
  # Process result, check for failures
```

Display (as each completes):
```
   ✅ [Task 1.1] Completed (2m 34s)
   ✅ [Task 1.2] Completed (1m 45s)
   ⚠️ [Task 1.3] Completed with warnings
```

**Step C: Handle failures**

If any task failed:
```
⚠️ Batch [N] had failures:
   ❌ [Task 1.3]: [Error description]

Options:
- "Retry failed tasks" - Re-launch failed tasks
- "Skip and continue" - Mark as blocked, proceed to next batch
- "Stop execution" - Pause for manual intervention
```

**Step D: Update task status and proceed**

```
# Mark all successful tasks as completed
for task in batch.successful_tasks:
  TaskUpdate({ taskId: task.id, status: "completed" })

# Proceed to next batch
```

Display:
```
✅ Batch [N] complete: [X]/[Y] tasks succeeded
   Proceeding to Batch [N+1]...
```

---

## Phase 4: Summary and Documentation Check

After all batches complete:

### 4.1 Update Implementation Summary

The final batch agent updates `specs/<slug>/04-implementation.md` with:
- All completed tasks
- Files modified
- Tests added
- Known issues

### 4.2 Display Completion Summary

```
═══════════════════════════════════════════════════
              IMPLEMENTATION COMPLETE
═══════════════════════════════════════════════════

✅ All tasks completed successfully

📊 Summary:
   - Tasks completed: [X]
   - Files modified: [Y]
   - Tests added: [Z]
   - Execution time: [T]

📄 Implementation summary: specs/[slug]/04-implementation.md

📚 Documentation Review
   Files changed touch areas covered by:
   • [guide-1.md]
   • [guide-2.md]

   Run /docs:reconcile to check for drift

🎉 Next steps:
   - Run /git:commit to commit changes
   - Run /spec:feedback if you have feedback to incorporate

═══════════════════════════════════════════════════
```

### 4.3 Roadmap Integration

If spec has `roadmapId` in frontmatter:
```bash
python3 roadmap/scripts/update_status.py $ROADMAP_ID completed
python3 roadmap/scripts/link_spec.py $ROADMAP_ID $SLUG
```

---

## ANALYSIS_AGENT_PROMPT

```
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
2. **Extract completed tasks**: All tasks marked with ✅
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

  if ready.length === 0:
    # Circular dependency or missing task - break cycle
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
| Task ID | Subject | Agent Type | Size |
|---------|---------|------------|------|
| [id] | [subject] | [agent] | [S/M/L] |

#### Batch 2 (Depends on Batch 1)
| Task ID | Subject | Agent Type | Size |
|---------|---------|------------|------|
| [id] | [subject] | [agent] | [S/M/L] |

[Continue for all batches...]

### Parallelization Summary
- **Total batches**: [N]
- **Max parallel tasks**: [M] (in Batch [X])
- **Sequential equivalent**: [T] tasks
- **Parallelization factor**: [T/N]x speedup potential
```
```

---

## IMPLEMENTATION_AGENT_PROMPT

```
You are implementing a task from a specification.

## Cross-Session Context
[Inserted from execution plan if resuming]

## Current Task

Use `TaskGet({ taskId: "[TASK_ID]" })` to get the full task details.

The task description contains ALL implementation details including:
- Technical requirements
- Code examples to implement
- Acceptance criteria
- Test requirements

## Your Workflow

### Step 1: Understand the Task
- Read the full task description from TaskGet
- Identify files to create/modify
- Note any dependencies on other components

### Step 2: Implement
- Write the code following project conventions
- Follow FSD architecture (check which layer: entities, features, widgets)
- Add proper error handling
- Include TypeScript types

### Step 3: Write Tests
- Write tests for the implementation
- Cover happy path and edge cases
- Ensure tests pass

### Step 4: Self-Review
- Check implementation against ALL acceptance criteria
- Verify no TypeScript errors
- Ensure code follows project style

### Step 5: Report Results

Return a structured report:

```
## TASK COMPLETE

### Task
- **ID**: [task_id]
- **Subject**: [subject]
- **Status**: [SUCCESS / PARTIAL / FAILED]

### Files Modified
- [file1.ts] - [description]
- [file2.ts] - [description]

### Tests Added
- [test1.test.ts] - [what it tests]

### Acceptance Criteria
- [x] Criteria 1
- [x] Criteria 2
- [ ] Criteria 3 (partial - reason)

### Issues Encountered
- [Issue 1] - [how resolved / still open]

### Notes for Next Tasks
- [Any context that dependent tasks should know]
```

## Important Guidelines

- **Don't summarize** - Implement everything in the task description
- **Complete the task** - Don't mark done until ALL acceptance criteria met
- **Write tests** - Every implementation needs tests
- **Follow conventions** - Match existing code style in the project
- **Report honestly** - If something is incomplete, say so
```

---

## Execution Modes

### Full Execution (Default)
Execute all batches to completion. Best for:
- Dedicated implementation sessions
- When you can wait for all tasks

### Single Batch Mode
Execute one batch at a time, pause for review. Best for:
- Large implementations with many tasks
- When you want to review progress between phases

### Dry Run Mode
Show execution plan without executing. Best for:
- Understanding the scope before committing
- Verifying task dependencies are correct

---

## Error Handling

### Agent Timeout
If an agent doesn't complete within expected time:
1. Check agent status with `TaskOutput(task_id, block: false)`
2. Offer to wait longer or cancel

### Task Failure
If an agent reports failure:
1. Display the error details
2. Offer options: retry, skip, or stop
3. If skipping, mark dependent tasks as blocked

### Dependency Issues
If circular dependencies detected:
1. Display the cycle
2. Ask user which task to execute first
3. Or suggest running `/spec:decompose` to fix dependencies

---

## Session Continuity

### How It Works

1. **First run**: Creates `04-implementation.md` with Session 1
2. **Subsequent runs**: Detects existing file, increments session number
3. **Context preservation**: Completed tasks, files modified, known issues passed to agents
4. **No duplication**: Completed tasks skipped automatically

### Implementation Summary Structure

```markdown
# Implementation Summary: [Feature Name]

**Created:** [date]
**Last Updated:** [date]
**Spec:** specs/[slug]/02-specification.md

## Progress
**Status:** [In Progress / Complete]
**Tasks Completed:** [X] / [Total]

## Tasks Completed

### Session 2 - [date]
- ✅ [Task 2.1] Implement user dashboard
- ✅ [Task 2.2] Add settings page

### Session 1 - [date]
- ✅ [Task 1.1] Set up authentication
- ✅ [Task 1.2] Create user schema

## Files Modified/Created
**Source files:**
  - src/layers/features/auth/ui/LoginForm.tsx
  - src/layers/entities/user/api/queries.ts

**Test files:**
  - __tests__/features/auth/LoginForm.test.tsx

## Known Issues
- [Issue description]

## Implementation Notes
### Session 2
- Design decision: Used Zustand for local state...

### Session 1
- Initial architecture established...
```

---

## Usage Examples

```bash
# Execute a feature specification
/spec:execute specs/user-authentication/02-specification.md

# Resume a partially completed implementation
/spec:execute specs/dashboard-redesign/02-specification.md
# (Automatically detects previous session and resumes)
```

---

## Integration with Other Commands

| Command | Relationship |
|---------|--------------|
| `/spec:decompose` | **Run first** - Creates the tasks to execute |
| `/spec:feedback` | Run after to incorporate feedback, then re-decompose and re-execute |
| `/git:commit` | Run after execution to commit changes |
| `/docs:reconcile` | Run after to check if guides need updates |

---

## Troubleshooting

### "No tasks found"
Run `/spec:decompose` first to create tasks from the specification.

### "All tasks already completed"
The implementation is done. Check `04-implementation.md` for summary.

### Agents taking too long
Large tasks may take several minutes. Use `TaskOutput(block: false)` to check progress.

### Context limits in agents
Each agent has isolated context. If a single task is too large, consider splitting it in the decompose phase.

---

## Performance Characteristics

| Metric | Sequential | Parallel (This Command) |
|--------|-----------|------------------------|
| 10 independent tasks | ~30 min | ~5 min (6x faster) |
| Context usage | 100% in main | ~15% in main |
| Failure impact | Blocks all | Only blocks dependents |
| Progress visibility | After each task | Real-time per batch |
