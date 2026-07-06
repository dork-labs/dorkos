# Parallel Execution Guide

## Overview

This guide covers when and how to run subagents in parallel in Claude Code workflows. The **`Agent` tool** spawns a subagent with its own isolated context; multiple `Agent` calls sent in a **single message** run concurrently. Used appropriately, parallel execution achieves 3-6x speedup and 80-90% context savings.

## Key Files

| Concept                   | Location                                                                       |
| ------------------------- | ------------------------------------------------------------------------------ |
| Orchestration skill       | `.claude/skills/orchestrating-parallel-work/`                                  |
| Parallel research pattern | flow plugin `ideating-features` skill (projected as `flow__ideating-features`) |
| Parallel batch execution  | flow plugin `executing-specs` skill (the `/flow:execute` gate)                 |
| Agent / SendMessage tools | Built-in Claude Code tools                                                     |

## Key Mechanics

- **Parallel launch**: to run agents concurrently, send multiple `Agent` calls in a **single message**. Each call takes `description`, `prompt`, and `subagent_type`. Separate messages serialize.
- **Results**: each agent's final message comes back as its tool result. It is not shown to the user — relay what matters.
- **Background mode**: `run_in_background: true` returns immediately; the main conversation continues and completion arrives as an automatic task notification. There is no polling API — you are re-invoked when the agent finishes.
- **Follow-ups**: `SendMessage` (addressed by the agent's ID or name) continues a previously spawned agent with its context intact. A fresh `Agent` call starts from zero.
- **Isolation**: `isolation: "worktree"` gives an agent its own git worktree — required when parallel agents mutate tracked files.

## When to Use What

| Scenario                             | Approach                 | Why                                            |
| ------------------------------------ | ------------------------ | ---------------------------------------------- |
| Multiple independent analysis tasks  | Parallel fan-out         | No interdependencies, significant speedup      |
| Tasks with dependencies              | Sequential or batched    | Dependency results needed for subsequent tasks |
| Quick operations (<30 seconds)       | Sequential (or no agent) | Overhead of agent spawn not worth it           |
| Research + codebase exploration      | Parallel fan-out         | Different domains, no shared state             |
| Heavy computation in main context    | Background agent         | Preserves main context for user interaction    |
| Multiple diagnostic checks           | Parallel fan-out         | Independent checks, combine results at end     |
| File edits that depend on each other | Sequential               | Must see result of previous edit               |
| Large spec decomposition             | Background agent         | Heavy work isolated, summary returned          |

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

### Pattern 1: Parallel Fan-Out

Launch multiple independent agents in one message; their results come back together.

**Use for**: Research, analysis, diagnostics, exploration (2-5 independent tasks)

```
# Phase 1: One message, multiple Agent calls — they run concurrently
Agent(
  description: "Explore codebase for [feature]",
  prompt: "[detailed, self-contained instructions]",
  subagent_type: "Explore"
)
Agent(
  description: "Research solutions for [feature]",
  prompt: "[detailed, self-contained instructions]",
  subagent_type: "research-expert"
)

# Phase 2: Each tool result is that agent's final report
# Phase 3: Synthesize in main context, present to user
```

Give each agent a self-contained prompt (it cannot see the conversation) and tell it exactly what shape of answer to return.

**Context savings**: ~80% — only agent spawning and result synthesis in main context

**Example**: the `/flow:ideate` stage (the flow plugin's `ideating-features` skill) uses this for parallel codebase exploration + web research

### Pattern 2: Dependency-Aware Batching

Group tasks into batches where each batch can run in parallel, but batches execute sequentially.

**Use for**: Implementation with dependencies, multi-phase workflows, large numbers of similar tasks

```
# Build dependency graph
batches = [
  { tasks: [task1, task2, task3], blockedBy: [] },      # Batch 1: Foundation
  { tasks: [task4, task5], blockedBy: [1, 2] },         # Batch 2: Depends on 1,2
  { tasks: [task6, task7, task8], blockedBy: [4] },     # Batch 3: Depends on 4
]

for batch in batches:
  # Launch every task in the batch as Agent calls in ONE message
  # All tool results arrive before the next batch starts
  # Check each result for reported failures before launching the next batch
```

Rules for building batches:

- A task joins a batch only when everything it's blocked by is in an earlier batch
- Tasks touching the same files never share a batch (or get `isolation: "worktree"`)
- Keep batches to 3-5 agents; split bigger groups — for 10+ similar independent tasks, chunk them into successive batches rather than launching all at once

**Performance gain**: 3-6x faster than fully sequential execution

**Example**: the `/flow:execute` stage uses this for parallel task implementation

### Pattern 3: Background Agents + Notify

Spawn heavy work in the background, keep working, and pick up the result when the completion notification arrives.

**Use for**: Spec decomposition, deep audits, complex planning that shouldn't block the conversation

```
# Phase 1: Returns immediately — the conversation continues
Agent(
  description: "Analyze [complex task]",
  prompt: "[comprehensive analysis instructions]",
  subagent_type: "general-purpose",
  run_in_background: true
)

# Phase 2: Lightweight work in main context while the agent runs

# Phase 3: A task notification re-invokes you when the agent completes;
# its final report is the result

# Phase 4: Use the analysis to drive next steps. For follow-up questions,
# SendMessage to the agent's ID/name keeps its accumulated context.
```

**Context savings**: ~90% — heavy analysis completely isolated

**Example**: the `/flow:decompose` stage uses this pattern

## Anti-Patterns

### Never Do: Launching Independent Agents in Separate Messages

```
# ❌ WRONG — one Agent call per message serializes the work
[message 1] Agent(description: "Explore hooks", ...)
[wait for result]
[message 2] Agent(description: "Research SSE", ...)

# ✅ CORRECT — batch all independent Agent calls in a single message;
# they run concurrently and the results come back together
[one message] Agent(description: "Explore hooks", ...)
              Agent(description: "Research SSE", ...)
```

### Never Do: Re-Spawning Instead of Continuing

```
# ❌ WRONG — a fresh Agent call starts from zero; the prior context is gone
Agent(description: "Audit session storage", prompt: "...")
# ...later...
Agent(description: "Follow-up on the audit", prompt: "re-explain everything...")

# ✅ CORRECT — continue the same agent with its context intact
Agent(description: "Audit session storage", prompt: "...")
# ...later...
SendMessage(to: <agent id or name>, message: "Also check the eviction path")
```

### Never Do: Parallel Agents Editing Same File

```
# ❌ WRONG — agents will conflict; one change may be lost
Agent(prompt: "Update config.ts to add feature A", ...)
Agent(prompt: "Update config.ts to add feature B", ...)   # same message = concurrent

# ✅ CORRECT — sequential for shared resources, or isolate each agent
Agent(prompt: "Update config.ts to add feature A", ...)
# wait for the result, then:
Agent(prompt: "Update config.ts to add feature B", ...)

# ✅ ALSO CORRECT — give each agent its own throwaway worktree
Agent(prompt: "Add feature A", isolation: "worktree", ...)
Agent(prompt: "Add feature B", isolation: "worktree", ...)
```

### Never Do: Ignoring Context Limits

```
# ❌ WRONG — 20 agents at once may overwhelm the system
[one message with 20 Agent calls]

# ✅ CORRECT — batch appropriately (3-5 per batch), Pattern 2 style
[message 1] 5 Agent calls → collect results
[message 2] next 5 Agent calls → collect results
```

### Never Do: Trusting Success Reports Blindly

```
# ❌ WRONG — treating an agent's "done!" as proof
results = [reports from all agents]
proceed_to_next_batch()

# ✅ CORRECT — verify before dependent work starts
# - Read each report for stated failures or blockers
# - For implementation agents, check the actual diff:
#   git status / git diff — never the report alone
# - On failure: retry with a sharper prompt, continue without the
#   result, or stop and ask the user if the task is critical
```

## Performance Characteristics

| Metric                 | Sequential      | Parallel               | Improvement       |
| ---------------------- | --------------- | ---------------------- | ----------------- |
| 10 independent tasks   | ~30 min         | ~5 min                 | 6x faster         |
| Research + Exploration | ~10 min         | ~5 min                 | 2x faster         |
| Main context usage     | 100%            | ~15-20%                | 80-85% savings    |
| Failure impact         | Blocks all      | Only blocks dependents | Isolated failures |
| Progress visibility    | After each task | Real-time per batch    | Better UX         |

## Troubleshooting

### "Agents not running in parallel"

**Symptom**: Agents complete one after another instead of concurrently

**Cause**: Each `Agent` call was sent in its own message — separate messages serialize

**Fix**: Send all independent `Agent` calls in a single message

### "Follow-up agent knows nothing about the earlier work"

**Symptom**: A second agent re-does discovery the first agent already did

**Cause**: A new `Agent` call starts a fresh context; it cannot see the previous agent's work

**Fix**: Use `SendMessage` with the original agent's ID or name to continue it with its context intact

### "Agents conflict on same file"

**Symptom**: Edits from one agent overwrite another's work

**Cause**: Multiple agents editing same file in parallel

**Fix**:

1. Ensure agents work on different files
2. Or use sequential execution for shared resources
3. Or give each agent `isolation: "worktree"` for collision-free parallel edits

### "Context limit exceeded in agent"

**Symptom**: Agent stops mid-work with context error

**Cause**: Task was too large for isolated agent context

**Fix**:

1. Break large tasks into smaller subtasks
2. Use multiple agents for different aspects
3. Reduce prompt size, pass only essential context

### "Results not appearing"

**Symptom**: The agent finished but the answer is vague or unusable

**Cause**: The agent's final message is the tool result — if the prompt didn't request a specific output shape, the report may omit what you need. Remember the result is not shown to the user; you must relay it.

**Fix**:

1. Ensure agent prompt requests specific output format
2. Add "Return your findings in this format: ..." to prompt
3. Check if agent reported an error or blocker

## Stages & Commands Using Parallel Execution

| Stage / Command   | Pattern Used              | Agents Spawned             |
| ----------------- | ------------------------- | -------------------------- |
| `/flow:ideate`    | Parallel fan-out          | Explore + research-expert  |
| `/flow:execute`   | Dependency-aware batching | Multiple per batch         |
| `/flow:decompose` | Background agent + notify | general-purpose            |
| `/debug:api`      | Parallel diagnostics      | Component, action, DAL, DB |
| `/debug:browser`  | Parallel diagnostics      | Visual, console, network   |

> The `/flow` stage skills apply these patterns but ship in the external marketplace plugin (`dork-labs/marketplace`, `plugins/flow/`), not this repo. `/debug:*` are repo-local commands.

## Git Worktrees vs Subagents

Worktrees and subagents solve different isolation problems — this section covers **which to reach for**. For the worktree decision rule, mechanics, port model, and cleanup safety, see the **`working-in-worktrees`** skill (and `AGENTS.md` → Worktrees); they are not duplicated here.

| Scenario                            | Use Worktrees | Use Subagents    |
| ----------------------------------- | ------------- | ---------------- |
| Different branches                  | Yes           | No               |
| Full build isolation                | Yes           | No               |
| Mutating files in a shared checkout | Yes           | No               |
| Same branch, parallel reads         | No            | Yes              |
| Quick analysis/research             | No            | Yes              |
| Long-running dev server needed      | Yes           | No               |
| Shared mutable state ok             | N/A           | Yes (sequential) |

**Rule of thumb**: Worktrees = process-level isolation for code work (different branch / full build / shared checkout). Subagents = isolated _context_ for reads, research, and analysis on the same tree. They compose — a subagent with `isolation: "worktree"` gets a throwaway worktree for collision-free parallel edits.

Default to the gtr-provisioned flow (`/worktree:create` → EnterWorktree by path). The `working-in-worktrees` skill explains gtr-vs-native, the auto-checkpoint race that makes isolation mandatory in a shared checkout, and the conservative cleanup protocol.

## Best Practices Summary

1. **Batch independent `Agent` calls in one message** — separate messages serialize
2. **Group by dependency, not by type** — a batch is defined by what it's blocked by
3. **Display progress** — say what you launched and why; summarize each result as it lands
4. **Handle failures gracefully** — read each report, verify implementation claims against the diff
5. **Pass minimal, self-contained context** — agents can't see the conversation; don't overwhelm them either
6. **Consider overhead** — don't parallelize tasks under 30 seconds
7. **Continue, don't re-spawn** — `SendMessage` keeps a spawned agent's context for follow-ups
