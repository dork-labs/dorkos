---
name: executing-specs
description: Orchestrates parallel implementation of decomposed specifications with incremental progress tracking. Use when running /spec:execute.
disable-model-invocation: true
---

# Executing Specifications

Implement a specification by orchestrating parallel background agents across dependency-aware batches, with incremental persistence to survive context compaction.

## Supporting Files

| File | When Loaded | Purpose |
|------|-------------|---------|
| `implementation-summary-template.md` | Phase 1 (once) | Scaffold for `04-implementation.md` |
| `analysis-agent-prompt.md` | Phase 2 (once) | Full prompt for the analysis agent |
| `implementation-agent-prompt.md` | Phase 3 (per batch) | Full prompt for each implementation agent |

**Key rule**: Read supporting files on demand, not upfront. This keeps context lean.

---

## Phase 1: Setup & Scaffold

### 1.1 Extract Feature Slug

```
SPEC_FILE = <the spec path from user arguments>
SLUG = extract second path segment (e.g., "user-auth" from "specs/user-auth/02-specification.md")
TASKS_FILE = "specs/<SLUG>/03-tasks.md"
IMPL_FILE = "specs/<SLUG>/04-implementation.md"
```

Display:
```
Executing specification: <SPEC_FILE>
Feature slug: <SLUG>
```

### 1.2 Quick Validation

1. **Verify spec exists**: Check `SPEC_FILE` exists
2. **Verify tasks exist**: Use `TaskList()` to check for tasks with `[<slug>]` in subject
   - If no tasks: Display "No tasks found. Run `/spec:decompose` first." and stop
3. **Count tasks**: Total, completed, pending/in-progress

### 1.3 Scaffold 04-implementation.md (IMMEDIATELY)

This is the critical behavioral change: scaffold the implementation file NOW, before any agents run.

**If `IMPL_FILE` does NOT exist (new session):**
1. Read `.claude/skills/executing-specs/implementation-summary-template.md`
2. Extract the feature name from the spec's title (first `# heading` in `02-specification.md`)
3. Substitute variables:
   - `[FEATURE_NAME]` → feature name from spec
   - `[DATE]` → today's date (YYYY-MM-DD)
   - `[SLUG]` → feature slug
   - `[TOTAL]` → total task count
4. Write to `specs/<SLUG>/04-implementation.md`

**If `IMPL_FILE` DOES exist (resume session):**
1. Read the existing file
2. Find the last `### Session N` header, increment to N+1
3. Append a new session section:
   ```
   ### Session <N+1> - <DATE>

   _(No tasks completed yet)_
   ```
4. Update "Last Updated" date in frontmatter

Display:
```
Quick validation:
  Specification found
  Tasks found: <count> tasks for <SLUG>
  [New implementation / Resuming session <N+1>]
  Implementation file: specs/<SLUG>/04-implementation.md (scaffolded)
```

---

## Phase 2: Spawn Analysis Agent

1. Read `.claude/skills/executing-specs/analysis-agent-prompt.md`
2. Substitute `[SPEC_PATH]` and `[SLUG]` in the prompt text
3. Launch background agent:

```
Task(
  description: "Analyze <SLUG> execution plan",
  prompt: <substituted analysis prompt>,
  subagent_type: "general-purpose",
  run_in_background: true
)
```

Display:
```
Analyzing tasks and building execution plan...
```

4. Wait for result: `TaskOutput(task_id: <id>, block: true)`
5. Parse the returned execution plan (session info, batches, cross-session context)

---

## Phase 3: Execute Batches

### 3.1 Display Execution Plan

```
═══════════════════════════════════════════════════
              EXECUTION PLAN
═══════════════════════════════════════════════════

Task Summary:
   Completed: <X> tasks (skipping)
   In Progress: <Y> tasks (will resume)
   Pending: <Z> tasks (will execute)

Execution Batches (parallel groups):
   Batch 1: [Task 1.1, 1.2, 1.3] - No dependencies
   Batch 2: [Task 2.1, 2.2] - Depends on Batch 1
   ...

Estimated: <N> parallel batches
   (vs <M> sequential tasks without parallelization)

═══════════════════════════════════════════════════
```

### 3.2 Ask User to Proceed

```
AskUserQuestion:
  "Ready to execute <Z> tasks in <N> parallel batches?"
  Options:
  - "Execute all batches" (Recommended) - Run all tasks to completion
  - "Execute one batch" - Run only the first batch, then pause
  - "Review tasks first" - Show detailed task list before executing
```

### 3.3 Execute Each Batch

For each batch in the execution plan:

**Step A: Read prompt and launch agents**

1. Read `.claude/skills/executing-specs/implementation-agent-prompt.md`
2. For each task in the batch:
   - Substitute `[TASK_ID]` with the task's ID
   - Substitute `[CROSS_SESSION_CONTEXT]` with context from the analysis agent (or "N/A - first session")
   - Launch:
     ```
     Task(
       description: "Implement <task.subject>",
       prompt: <substituted implementation prompt>,
       subagent_type: <agent type from execution plan>,
       run_in_background: true
     )
     ```

Display:
```
Batch <N>: Launching <X> parallel agents
   -> <Task 1> <subject>
   -> <Task 2> <subject>
```

**Step B: Wait for all agents in batch**

```
for agent_id in batch.agent_ids:
  result = TaskOutput(task_id: agent_id, block: true)
```

Display as each completes:
```
   [Task 1] Completed
   [Task 2] Completed with warnings
```

**Step C: Handle failures**

If any task failed:
```
Batch <N> had failures:
   [Task 3]: <error description>

Options:
- "Retry failed tasks" - Re-launch failed tasks
- "Skip and continue" - Mark as blocked, proceed to next batch
- "Stop execution" - Pause for manual intervention
```

**Step D: APPEND batch results to 04-implementation.md (INCREMENTAL WRITE)**

This is the second critical behavioral change: persist results after EACH batch, not at the end.

1. Read current `specs/<SLUG>/04-implementation.md`
2. For each successful task in the batch, parse the agent's result report
3. **Update "Tasks Completed" section** — Under the current session header, replace `_(No tasks completed yet)_` (if first batch) or append after existing entries:
   ```
   - Task #<ID>: <subject>
   ```
4. **Update "Files Modified/Created" section** — Append any new files from agent reports (deduplicate)
5. **Update "Known Issues" section** — Append any issues from agent reports
6. **Update task count** — Increment "Tasks Completed: X / Total" in the Progress section
7. Write the updated file

**Step E: Update task status**

```
for task in batch.successful_tasks:
  TaskUpdate({ taskId: task.id, status: "completed" })
```

**Step F: Display batch summary**

```
Batch <N> complete: <X>/<Y> tasks succeeded
   Proceeding to Batch <N+1>...
```

---

## Phase 4: Finalize

After all batches complete:

### 4.1 Finalize Implementation Summary

1. Read `specs/<SLUG>/04-implementation.md`
2. Change `**Status:** In Progress` to `**Status:** Complete`
3. Verify task count matches total
4. Add any final implementation notes under the current session
5. Write the updated file

### 4.2 Display Completion Summary

```
═══════════════════════════════════════════════════
              IMPLEMENTATION COMPLETE
═══════════════════════════════════════════════════

All tasks completed successfully

Summary:
   - Tasks completed: <X>
   - Files modified: <Y>
   - Execution time: <T>

Implementation summary: specs/<SLUG>/04-implementation.md

Documentation Review:
   Run /docs:reconcile to check for drift

Next steps:
   - Run /git:commit to commit changes
   - Run /spec:feedback if you have feedback to incorporate

═══════════════════════════════════════════════════
```

### 4.3 Roadmap Integration

If spec has `roadmapId` in frontmatter:
```
python3 roadmap/scripts/update_status.py <ROADMAP_ID> completed
python3 roadmap/scripts/link_spec.py <ROADMAP_ID> <SLUG>
```

---

## Execution Modes

### Full Execution (Default)
Execute all batches to completion. Best for dedicated implementation sessions.

### Single Batch Mode
Execute one batch at a time, pause for review. Best for large implementations or when you want to review progress between phases.

### Dry Run Mode
Show execution plan without executing. Best for understanding scope or verifying task dependencies.

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

1. **First run**: Phase 1 scaffolds `04-implementation.md` with Session 1
2. **Each batch**: Phase 3 Step D appends results incrementally
3. **Subsequent runs**: Phase 1 detects existing file, increments session number
4. **Context preservation**: Completed tasks, files modified, known issues passed to agents via cross-session context
5. **No duplication**: Completed tasks skipped automatically via TaskList status

---

## Integration with Other Commands

| Command           | Relationship                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `/spec:decompose` | **Run first** - Creates the tasks to execute                        |
| `/spec:feedback`  | Run after to incorporate feedback, then re-decompose and re-execute |
| `/git:commit`     | Run after execution to commit changes                               |
| `/docs:reconcile` | Run after to check if guides need updates                           |

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
