# Parallel Execution Guide

## Overview

This guide covers when and how to use parallel agent execution patterns in Claude Code workflows. Parallel execution can achieve 3-6x speedup and 80-90% context savings when used appropriately.

## Key Files

| Concept | Location |
|---------|----------|
| Parallel batch execution | `.claude/commands/spec/execute.md` |
| Parallel research pattern | `.claude/commands/ideate.md` |
| Task tool reference | Built-in Claude Code tool |
| Orchestration skill | `.claude/skills/orchestrating-parallel-work/` |

## When to Use What

| Scenario | Approach | Why |
|----------|----------|-----|
| Multiple independent analysis tasks | Parallel background agents | No interdependencies, significant speedup |
| Tasks with dependencies | Sequential or batched | Dependency results needed for subsequent tasks |
| Quick operations (<30 seconds) | Sequential | Overhead of agent spawn not worth it |
| Research + codebase exploration | Parallel | Different domains, no shared state |
| Heavy computation in main context | Background agent | Preserves main context for user interaction |
| Multiple diagnostic checks | Parallel | Independent checks, combine results at end |
| File edits that depend on each other | Sequential | Must see result of previous edit |
| Large spec decomposition | Background agent | Heavy work isolated, summary returned |

## Decision Framework

### Parallelize When

1. **Tasks are independent** — No task needs the output of another
2. **Tasks take >30 seconds** — Overhead of agent spawn is justified
3. **Multiple perspectives help** — Different agents can tackle same problem differently
4. **Heavy context usage** — Move work out of main context to preserve it
5. **User can wait** — Background work while user continues is valuable

### Don't Parallelize When

1. **Shared mutable state** — Agents might conflict on same files
2. **Sequential dependencies** — Task B needs output of Task A
3. **Quick operations** — Agent spawn overhead exceeds task time
4. **Interactive refinement** — Rapid back-and-forth with user needed
5. **Simple single-file changes** — No benefit from isolation

### Quick Decision Test

```
Ask: "Can I start all these tasks simultaneously without knowing any results?"
  → Yes: Consider parallel
  → No: Use sequential or batched approach
```

## Core Patterns

### Pattern 1: Parallel Background Agents

Launch multiple independent agents simultaneously, collect results when all complete.

**Use for**: Research, analysis, diagnostics, exploration

```
# Phase 1: Launch all agents in parallel
exploration_task = Task(
  description: "Explore codebase for [feature]",
  prompt: "[detailed instructions]",
  subagent_type: "Explore",
  run_in_background: true
)

research_task = Task(
  description: "Research solutions for [feature]",
  prompt: "[detailed instructions]",
  subagent_type: "research-expert",
  run_in_background: true
)

# Phase 2: Wait for all results
exploration_result = TaskOutput(task_id: exploration_task.id, block: true)
research_result = TaskOutput(task_id: research_task.id, block: true)

# Phase 3: Synthesize in main context
# Combine findings, present to user
```

**Context savings**: ~80% — only agent spawning and result synthesis in main context

**Example command**: `/ideate` uses this for parallel codebase exploration + web research

### Pattern 2: Dependency-Aware Batching

Group tasks into batches where each batch can run in parallel, but batches execute sequentially.

**Use for**: Implementation with dependencies, multi-phase workflows

```
# Build dependency graph
batches = [
  { tasks: [Task1, Task2, Task3], blockedBy: [] },      # Batch 1: Foundation
  { tasks: [Task4, Task5], blockedBy: [1, 2] },         # Batch 2: Depends on 1,2
  { tasks: [Task6, Task7, Task8], blockedBy: [4] },     # Batch 3: Depends on 4
]

for batch in batches:
  # Wait for dependencies (previous batch)

  # Launch all tasks in batch simultaneously
  task_ids = []
  for task in batch.tasks:
    result = Task(
      description: task.name,
      prompt: task.details,
      subagent_type: task.agent_type,
      run_in_background: true
    )
    task_ids.append(result.id)

  # Wait for entire batch to complete
  for task_id in task_ids:
    result = TaskOutput(task_id: task_id, block: true)
    process_result(result)

  # Proceed to next batch
```

**Performance gain**: 3-6x faster than fully sequential execution

**Example command**: `/spec:execute` uses this for parallel task implementation

### Pattern 3: Analysis Then Implementation

Spawn heavy analysis work in background, then use results to drive implementation.

**Use for**: Spec decomposition, complex planning, dependency analysis

```
# Phase 1: Spawn analysis agent
analysis = Task(
  description: "Analyze [complex task]",
  prompt: "[comprehensive analysis instructions]",
  subagent_type: "general-purpose",
  run_in_background: true
)

# Phase 2: Lightweight work in main context
# (can do other things while analysis runs)

# Phase 3: Wait for analysis
result = TaskOutput(task_id: analysis.id, block: true)

# Phase 4: Use analysis to drive next steps
execution_plan = parse_execution_plan(result)
execute_plan(execution_plan)
```

**Context savings**: ~90% — heavy analysis completely isolated

**Example command**: `/spec:decompose` uses this pattern

### Pattern 4: Self-Organizing Workers (Advanced)

Workers claim tasks from a shared pool, completing work as capacity allows.

**Use for**: Large numbers of similar independent tasks

```
# Create all tasks
tasks = TaskList()
pending_tasks = tasks.filter(status == "pending", no blockedBy)

# Launch N workers (based on task count)
worker_count = min(len(pending_tasks), 5)
workers = []

for i in range(worker_count):
  worker = Task(
    description: f"Worker {i} processing tasks",
    prompt: """
      1. Use TaskList() to find available tasks (pending, no blockedBy)
      2. Use TaskUpdate() to claim a task (set status: in_progress)
      3. Complete the task
      4. Use TaskUpdate() to mark complete
      5. Repeat until no tasks remain
    """,
    subagent_type: "general-purpose",
    run_in_background: true
  )
  workers.append(worker.id)

# Wait for all workers
for worker_id in workers:
  TaskOutput(task_id: worker_id, block: true)
```

**Best for**: 10+ independent tasks of similar complexity

## Anti-Patterns

### Never Do: Sequential Background Agent Waiting

```typescript
// ❌ WRONG - This defeats the purpose of parallelization
for (task of tasks) {
  const id = await Task({ ..., run_in_background: true })
  await TaskOutput({ task_id: id, block: true })  // Waiting immediately!
}

// ✅ CORRECT - Launch all, then wait for all
const ids = []
for (task of tasks) {
  const result = await Task({ ..., run_in_background: true })
  ids.push(result.id)
}
for (id of ids) {
  await TaskOutput({ task_id: id, block: true })
}
```

### Never Do: Losing Task IDs

```typescript
// ❌ WRONG - Can't wait for completion later
Task({ description: "Important work", run_in_background: true })
// ID is lost!

// ✅ CORRECT - Store the ID
const task = Task({ description: "Important work", run_in_background: true })
const taskId = task.id
// ... later ...
TaskOutput({ task_id: taskId, block: true })
```

### Never Do: Parallel Agents Editing Same File

```typescript
// ❌ WRONG - Agents will conflict
Task({ prompt: "Update config.ts to add feature A", run_in_background: true })
Task({ prompt: "Update config.ts to add feature B", run_in_background: true })
// Race condition! One change may be lost

// ✅ CORRECT - Sequential for shared resources
await Task({ prompt: "Update config.ts to add feature A" })
await Task({ prompt: "Update config.ts to add feature B" })
```

### Never Do: Ignoring Context Limits

```typescript
// ❌ WRONG - Too many agents at once
for (i = 0; i < 20; i++) {
  Task({ ..., run_in_background: true })
}
// May overwhelm system, agents might fail

// ✅ CORRECT - Batch appropriately
const BATCH_SIZE = 5
for (batch of chunks(tasks, BATCH_SIZE)) {
  const ids = batch.map(t => Task({ ..., run_in_background: true }).id)
  for (id of ids) await TaskOutput({ task_id: id, block: true })
}
```

### Never Do: Missing Error Handling

```typescript
// ❌ WRONG - No error handling
const ids = tasks.map(t => Task({ ..., run_in_background: true }).id)
const results = ids.map(id => TaskOutput({ task_id: id, block: true }))

// ✅ CORRECT - Handle failures
const results = []
for (id of ids) {
  const result = TaskOutput({ task_id: id, block: true })
  if (result.status === 'failed') {
    console.log(`Task ${id} failed: ${result.error}`)
    // Decide: retry, skip, or stop
  } else {
    results.push(result)
  }
}
```

## Performance Characteristics

| Metric | Sequential | Parallel Background | Improvement |
|--------|-----------|---------------------|-------------|
| 10 independent tasks | ~30 min | ~5 min | 6x faster |
| Research + Exploration | ~10 min | ~5 min | 2x faster |
| Main context usage | 100% | ~15-20% | 80-85% savings |
| Failure impact | Blocks all | Only blocks dependents | Isolated failures |
| Progress visibility | After each task | Real-time per batch | Better UX |

## Troubleshooting

### "Agents not running in parallel"

**Symptom**: Background agents complete sequentially despite `run_in_background: true`

**Cause**: Usually waiting for each agent immediately after spawning

**Fix**: Launch ALL agents first, store IDs, THEN wait for results in a second loop

### "Task ID not found"

**Symptom**: `TaskOutput` returns error that task doesn't exist

**Cause**: Task ID was not stored or agent crashed during startup

**Fix**:
1. Store task ID immediately after `Task()` call
2. Check agent started successfully before proceeding
3. Use `block: false` first to check status

### "Agents conflict on same file"

**Symptom**: Edits from one agent overwrite another's work

**Cause**: Multiple agents editing same file in parallel

**Fix**:
1. Ensure agents work on different files
2. Or use sequential execution for shared resources
3. Or split file into independent modules first

### "Context limit exceeded in agent"

**Symptom**: Agent stops mid-work with context error

**Cause**: Task was too large for isolated agent context

**Fix**:
1. Break large tasks into smaller subtasks
2. Use multiple agents for different aspects
3. Reduce prompt size, pass only essential context

### "Results not appearing"

**Symptom**: `TaskOutput` returns but results seem empty

**Cause**: Agent finished but didn't return structured output

**Fix**:
1. Ensure agent prompt requests specific output format
2. Add "Return your findings in this format: ..." to prompt
3. Check if agent encountered an error

## Commands Using Parallel Execution

| Command | Pattern Used | Agents Spawned |
|---------|--------------|----------------|
| `/ideate` | Parallel research | Explore + research-expert |
| `/spec:execute` | Dependency-aware batching | Multiple per batch |
| `/spec:decompose` | Analysis then implementation | general-purpose |
| `/debug:api` | Parallel diagnostics | Component, action, DAL, DB |
| `/debug:browser` | Parallel diagnostics | Visual, console, network |

## Best Practices Summary

1. **Always store task IDs** — You'll need them to collect results
2. **Batch similar tasks** — Group by dependency, not by type
3. **Display progress** — Tell user what's happening between batches
4. **Handle failures gracefully** — One failed agent shouldn't crash everything
5. **Pass minimal context** — Agents have their own context, don't overwhelm
6. **Consider overhead** — Don't parallelize tasks under 30 seconds
7. **Test with `/tasks`** — Monitor running agents during development
