---
name: orchestrating-parallel-work
description: Orchestrates parallel execution of AI agents with dependency analysis and batch scheduling. Use when coordinating multiple concurrent tasks, optimizing task ordering, or when multiple independent agents would benefit the workflow.
---

# Orchestrating Parallel Work

## Overview

This skill provides patterns for coordinating parallel subagent execution in Claude Code workflows. Apply these patterns when tasks can run simultaneously without interdependencies — parallel fan-out saves wall-clock time and keeps large intermediate output out of the main context.

## When to Use

- Launching multiple research or exploration agents
- Implementing features with independent subtasks
- Running diagnostics that check multiple layers
- Processing batch operations with dependency graphs
- Any workflow where "wait for A, then start B" isn't required

## Key Mechanics

The **`Agent` tool** spawns a subagent with its own isolated context:

- **Parallel launch**: to run agents concurrently, send multiple `Agent` calls in a **single message**. Each call takes `description`, `prompt`, and `subagent_type`.
- **Results**: the agent's final message comes back as the tool result. It is not shown to the user — relay what matters.
- **Background mode**: `run_in_background: true` returns immediately; the main conversation continues and completion arrives as an automatic task notification. No polling API exists — you are re-invoked when the agent finishes.
- **Follow-ups**: `SendMessage` (addressed by the agent's ID or name) continues a previously spawned agent with its context intact. A fresh `Agent` call starts from zero.
- **Isolation**: `isolation: "worktree"` gives an agent its own git worktree — required when parallel agents mutate tracked files.

## Decision Logic

### Should I Parallelize?

1. **Are tasks independent?** → If no, use sequential
2. **Will each task take >30 seconds?** → If no, sequential might be faster
3. **Do agents need each other's output?** → If yes, use batched approach
4. **Will agents edit the same files?** → If yes, must be sequential (or isolated worktrees)

### Choosing the Pattern

| Situation                                    | Pattern                        |
| -------------------------------------------- | ------------------------------ |
| 2-5 independent research/analysis tasks      | **Parallel Fan-Out**           |
| Many tasks with known dependencies           | **Dependency-Aware Batching**  |
| Long-running work alongside interactive work | **Background Agents + Notify** |

## Core Patterns

### Pattern 1: Parallel Fan-Out

For 2-5 independent tasks that don't share state. Launch all agents in one message; their results come back together.

```
# One message, three Agent calls — they run concurrently
Agent(description: "Survey client hooks", prompt: "...", subagent_type: "Explore")
Agent(description: "Research SSE reconnect", prompt: "...", subagent_type: "research-expert")
Agent(description: "Map server routes", prompt: "...", subagent_type: "Explore")

# Each tool result is that agent's final report — synthesize them
```

Give each agent a self-contained prompt (it cannot see the conversation) and tell it exactly what shape of answer to return.

### Pattern 2: Dependency-Aware Batching

For tasks with dependencies where some can still run in parallel. Group tasks into batches by their dependency edges; each batch is a parallel fan-out, and the next batch starts only after the previous one's results are in.

```
batches = analyze_dependencies(tasks)
# e.g., [[1,2,3], [4,5], [6,7,8]] — 3 batches

for batch in batches:
  # Launch every task in the batch as Agent calls in ONE message
  # Wait for all results (they arrive as the tool results)
  # Check each result for failure before starting the next batch
```

Rules for building batches:

- A task joins a batch only when everything it's blocked by is in an earlier batch
- Tasks touching the same files never share a batch (or get `isolation: "worktree"`)
- Keep batches to 3-5 agents; split bigger groups

### Pattern 3: Background Agents + Notify

For heavy work that shouldn't block the conversation.

```
# Returns immediately with an agent ID
Agent(
  description: "Deep audit of session storage",
  prompt: "...",
  subagent_type: "general-purpose",
  run_in_background: true
)

# Keep working — validation, prep, user conversation.
# A task notification re-invokes you when the agent completes.
# Use SendMessage with the agent's ID/name for follow-up questions
# without losing its accumulated context.
```

> Note: the `/flow` engine's DECOMPOSE/EXECUTE stages apply these batching patterns, but flow lives in the external marketplace plugin (`dork-labs/marketplace`, `plugins/flow/`), not this repo.

## Agent Selection Guide

| Task Type               | Recommended Agent       |
| ----------------------- | ----------------------- |
| Codebase exploration    | `Explore`               |
| Web research            | `research-expert`       |
| React/frontend          | `react-tanstack-expert` |
| TypeScript issues       | `typescript-expert`     |
| Code review             | `code-reviewer`         |
| Bulk read-and-summarize | `context-isolator`      |
| General implementation  | `general-purpose`       |
| File search             | `code-search`           |

## Error Handling

Agents report their own outcome in their final message — treat it as a claim, not proof:

- Read each result for reported failures or blockers before starting dependent work
- For implementation agents, verify with the VCS diff (`git status` / `git diff`), never the report alone
- On failure: retry with a sharper prompt, continue without the result, or stop and ask the user if the task is critical

## Anti-Patterns to Avoid

1. **Sequential launches for independent work** — separate messages serialize; batch `Agent` calls in one message
2. **Duplicating delegated work** — once a search/task is delegated, don't also run it yourself; wait for the result
3. **Shared file edits** — don't let parallel agents edit the same file without worktree isolation
4. **Too many agents** — batch in groups of 3-5, not 20 at once
5. **Re-spawning instead of continuing** — use `SendMessage` for follow-ups; a new `Agent` call loses the prior context
6. **Trusting success reports** — check the diff or output evidence

## Progress Display

Keep users informed: say what you launched and why ("Launched 3 agents: client hooks, SSE research, server routes"), then summarize each result as it lands and what you concluded from it.
