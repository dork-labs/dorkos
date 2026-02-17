---
name: orchestrating-parallel-work
description: Orchestrates parallel execution of AI agents with dependency analysis and batch scheduling. Use when coordinating multiple concurrent tasks, optimizing task ordering, or when multiple independent agents would benefit the workflow.
---

# Orchestrating Parallel Work

## Overview

This skill provides patterns for coordinating parallel agent execution in Claude Code workflows. Apply these patterns when tasks can run simultaneously without interdependencies, achieving 3-6x speedup and 80-90% context savings.

## When to Use

- Launching multiple research or exploration agents
- Implementing features with independent subtasks
- Running diagnostics that check multiple layers
- Processing batch operations with dependency graphs
- Any workflow where "wait for A, then start B" isn't required

## Key Concepts

### Background Agents

Agents launched with `run_in_background: true` execute in isolated context. The main conversation continues while they work.

```
task = Task(
  description: "Describe what agent does",
  prompt: "Detailed instructions",
  subagent_type: "agent-type",
  run_in_background: true
)
# Returns immediately with task.id
```

### Collecting Results

Use `TaskOutput` to wait for completion:

```
result = TaskOutput(task_id: task.id, block: true)   # Wait for completion
status = TaskOutput(task_id: task.id, block: false)  # Check without waiting
```

### Task Dependencies

Use `TaskUpdate` to set up dependencies between tasks:

```
TaskUpdate({
  taskId: childTask.id,
  addBlockedBy: [parentTask.id]
})
```

## Decision Logic

### Should I Parallelize?

Ask these questions:

1. **Are tasks independent?** → If no, use sequential
2. **Will each task take >30 seconds?** → If no, sequential might be faster
3. **Do agents need each other's output?** → If yes, use batched approach
4. **Will agents edit the same files?** → If yes, must be sequential

### Choosing the Pattern

| Situation                               | Pattern                          |
| --------------------------------------- | -------------------------------- |
| 2-3 independent research/analysis tasks | **Parallel Background Agents**   |
| Many tasks with known dependencies      | **Dependency-Aware Batching**    |
| Heavy analysis before implementation    | **Analysis Then Implementation** |
| 10+ similar independent tasks           | **Self-Organizing Workers**      |

## Core Patterns

### Pattern 1: Parallel Background Agents

For 2-5 independent tasks that don't share state.

```
# Launch all simultaneously
agent1 = Task(description: "Task 1", prompt: "...", subagent_type: "X", run_in_background: true)
agent2 = Task(description: "Task 2", prompt: "...", subagent_type: "Y", run_in_background: true)
agent3 = Task(description: "Task 3", prompt: "...", subagent_type: "Z", run_in_background: true)

# Display progress
print("Launched 3 agents in parallel...")

# Collect all results
result1 = TaskOutput(task_id: agent1.id, block: true)
result2 = TaskOutput(task_id: agent2.id, block: true)
result3 = TaskOutput(task_id: agent3.id, block: true)

# Synthesize
synthesize_findings([result1, result2, result3])
```

**Real example**: `/ideate` launches `Explore` and `research-expert` in parallel.

### Pattern 2: Dependency-Aware Batching

For tasks with dependencies where some can still run in parallel.

```
# Group into batches by dependencies
batches = analyze_dependencies(tasks)
# e.g., [[1,2,3], [4,5], [6,7,8]] — 3 batches

for batch_num, batch in enumerate(batches):
  print(f"Executing Batch {batch_num + 1}: {len(batch)} tasks")

  # Launch all in batch
  ids = []
  for task in batch:
    result = Task(
      description: task.name,
      prompt: task.details,
      subagent_type: task.agent,
      run_in_background: true
    )
    ids.append(result.id)

  # Wait for batch completion
  for id in ids:
    result = TaskOutput(task_id: id, block: true)
    if result.status == 'failed':
      handle_failure(result)

  print(f"Batch {batch_num + 1} complete")
```

**Real example**: `/spec:execute` (via the `executing-specs` skill) groups tasks by blockedBy dependencies.

### Pattern 3: Analysis Then Implementation

For heavy upfront analysis that drives subsequent work.

```
# Spawn heavy analysis
analysis = Task(
  description: "Analyze requirements",
  prompt: "Read spec, identify all tasks, build dependency graph, return structured plan",
  subagent_type: "general-purpose",
  run_in_background: true
)

# Do lightweight work while waiting
prepare_environment()
validate_inputs()

# Get analysis results
plan = TaskOutput(task_id: analysis.id, block: true)

# Execute based on plan
for phase in plan.phases:
  execute_phase(phase)
```

**Real example**: `/spec:decompose` isolates spec reading and task creation.

## Agent Selection Guide

| Task Type              | Recommended Agent       |
| ---------------------- | ----------------------- |
| Codebase exploration   | `Explore`               |
| Web research           | `research-expert`       |
| Database work          | `prisma-expert`         |
| React/frontend         | `react-tanstack-expert` |
| TypeScript issues      | `typescript-expert`     |
| General implementation | `general-purpose`       |
| File search            | `code-search`           |

## Error Handling

Always handle agent failures:

```
for id in task_ids:
  result = TaskOutput(task_id: id, block: true)

  if result.status == 'failed':
    print(f"Agent {id} failed: {result.error}")

    # Options:
    # 1. Retry the task
    # 2. Skip and continue
    # 3. Stop all work

    if is_critical(result):
      ask_user_how_to_proceed()
    else:
      continue
```

## Anti-Patterns to Avoid

1. **Sequential waiting** — Don't wait immediately after each spawn
2. **Lost task IDs** — Always store the ID returned from Task()
3. **Shared file edits** — Don't let parallel agents edit same file
4. **Too many agents** — Batch in groups of 3-5, not 20 at once
5. **Missing error handling** — Check result.status for failures

## Progress Display

Keep users informed:

```
print("🔄 Launching parallel analysis...")
print(f"   → Agent 1: {task1.description}")
print(f"   → Agent 2: {task2.description}")

# After each completes
print(f"   ✅ Agent 1 completed ({duration})")
print(f"   ✅ Agent 2 completed ({duration})")

print("📊 Synthesizing results...")
```

## References

For detailed patterns and examples, see:

- `contributing/parallel-execution.md` — Complete guide
- `.claude/skills/executing-specs/SKILL.md` — Batch execution example
- `.claude/commands/ideate.md` — Parallel research example
