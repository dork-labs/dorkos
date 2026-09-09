---
name: orchestrating-parallel-work
description: Orchestrates parallel execution of AI agents with dependency analysis, batch scheduling, and the playbook for landing many branches at once. Use when coordinating multiple concurrent tasks, optimizing task ordering, sequencing batches of code changes into waves, landing parallel branches through review and merge, or rebasing a branch that fell behind other in-flight work.
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

## Landing Parallel Batches

The patterns above cover fan-out. When the parallel work is **code that has to
reach `main`**, fan-out is the easy half: the branches then have to survive each
other, review, and the merge queue. This playbook is what a 20-batch programme
of concurrent branches taught (167 findings, 2026-09); it assumes a repo where
every change lands via PR.

### Sequence batches by collision class

Before dispatching anything, annotate every batch with the **collision classes**
it touches — the directories, shared primitives, user-visible strings, and
config files it will edit — and order the waves from that annotation, not from
priority:

- **Foundation first.** Shared primitives, design tokens, and other code many
  batches build on go in an early wave, so later batches build on the new
  version instead of racing it.
- **Same-domain sweeps travel together.** All the copy edits in one wave, all
  the layout fixes in another. Their conflicts are then resolved once, between
  siblings that know about each other, rather than repeatedly against strangers.
- **Dependents after their dependency.** A batch that consumes another batch's
  output waits for it, exactly as in Pattern 2.
- **File moves and renames last.** A move collides with every branch that has
  the file open, and it is the one change that cannot be rebased cheaply.
- **Same-surface tickets land as one PR or a strict sequence.** When two or
  more tickets touch one component family or surface, batch them into a single
  PR, or cut the second branch from the first's final merged SHA rather than
  its in-flight tip — a same-surface stack rebased later always costs more
  than sequencing up front.
- **Cap concurrency.** The 2026-09 programme held at four live worktrees; past
  that, rebasing cost more than the parallelism bought. Pick a ceiling from your
  own machine and orchestrator, and hold it.

### The per-batch chain

Each batch runs the same chain, and no step is optional:

1. **Worktree** from `origin/main`, one per batch (`isolation: "worktree"`, or
   an explicit worktree the agent is told to work in). Never two agents in one
   checkout. The base rule, the port model, and the cleanup protocol belong to
   the **`working-in-worktrees`** skill (`/worktree:create`); this playbook adds
   nothing to them.
2. **Implement** with a self-contained brief: the task list verbatim, the
   verification commands, and the constraint that the agent touches nothing
   outside its batch.
3. **Verify locally** — targeted tests for every package touched **plus every
   test that renders a changed component**, typecheck and lint per package, and
   for UI work, drive the real surface rather than trusting the unit tests.
4. **Adversarial review before the PR opens.** A _separate_ agent reviews the
   branch against the repo's review rubric — in this repo `REVIEW.md` — and the
   brief names the failure modes to hunt (`REVIEW.md` → "Failure modes worth
   hunting by name"). A generic "review this branch" finds nothing; the named
   shapes found roughly forty-five real defects pre-PR. The implementer fixes;
   the reviewer re-verifies its own findings rather than accepting the fix
   report.
5. **Finalize** — fragment, labels, push, PR. The mechanics (when a changelog
   fragment is owed, what `skip-changelog` / `review:light` / `review:deep` mean,
   review-before-open ordering, and how auto-merge behaves) belong to the
   **`creating-pull-requests`** skill. What this playbook adds is below.

### Landing rules

- **Check load-sensitivity before debugging a red test.** Before spending a
  cycle on it, check the tells: it passes in isolation but fails in the full
  run; the assertion is about timing, throughput, or sample counts rather than
  behavior; the failure text names milliseconds, wall-clock boundaries, or
  "expected N samples"; the file is in the known flake family (harness
  atomic-write AP-10's sample-throughput guard, MIN_SAMPLES fixed at 200;
  RoomLiveLane's wall-clock boundaries; agent-activity's teardown timing;
  palette-scope-chips, DOR-1502). A load-starved guard refusing to conclude is
  not a defect in your branch — re-run once before spending a cycle, and if it
  repeats, it belongs to the test's owner, not your PR.
- **A commit either isn't user-facing, or fills its own stub.** A commit that is
  genuinely not user-facing — a review-nit fold, a refactor, a CI tweak — takes a
  `chore(` or `ci(` subject, so the populator mints no stub at all. A user-facing
  commit curates its seeded stub in the same commit that creates it (rewrite the
  bullet for a human, delete the seeded comment) rather than leaving it for CI to
  catch; if a curated fragment for the batch already exists, fold the stub's
  `covers:` line into it byte-for-byte — matching the commit subject exactly, since
  a missing ticket suffix breaks coverage — and delete the stub. Five PRs failed the
  `fragment-present` gate this way in one week (#1510, #1567, #1581, #1618, #1700).
  Mechanics: **`creating-pull-requests`** skill and
  `changelog/README.md#seeded-fragments`.
- **Format as the last step before every push.** Run the formatter over the full
  changed set (`git diff --name-only origin/main...HEAD`) immediately before
  pushing, and again after any hand-resolved conflict. In this repo the pre-push
  hook now checks that same set and prints the exact
  `pnpm exec prettier --write <files>` line (`scripts/pre-push-format-check.sh`,
  DOR-1839) — it deliberately never writes, so running the formatter yourself is
  still the only thing that fixes it, and doing it first is how you skip the
  refusal. A worktree with no `node_modules` fails that hook; install before you
  push rather than reaching for `--no-verify`.
- **Verify the merge is armed or queued; never assume either way.** How
  auto-merge behaves — that a new commit drops the armed state on **every** push,
  that the strategy flag belongs to the queue, that arming follows review — is
  the **`creating-pull-requests`** skill's, and it is the one to read. The
  parallel-specific delta is the check: after arming, confirm one of two things
  is true — the PR reports an auto-merge request, **or** it appears in the merge
  queue. A queued PR reports _no_ auto-merge request, so the first field alone
  answers wrongly. A zero exit proves nothing, and the request silently no-ops
  while mergeability is unknown. In this repo a janitor (`merge-tail.yml`) also
  arms finished PRs on a 10-minute tick, so the population that actually strands
  is the one it skips by design — unresolved review threads, any check pending,
  failing or cancelled, a `hold`/`wip`/`blocked` label, a conflicting tree,
  unknown mergeability (`scripts/should-arm-automerge.sh` names each reason).
  Straight off a push, most PRs are in that set.
- **Rebase deliberately.** When a branch falls behind, resolve to **both
  intents** — the incoming change and yours — rather than picking a side by
  reflex; when one side deleted what the other edited, the **deletion wins**, and
  the edit's intent gets re-applied elsewhere if it still matters. Then run the
  **full** suite (`pnpm test -- --run` here — the pre-push hook runs
  affected-only, and a bare `vitest` full run skips the per-package env turbo
  sets up), because semantic conflicts carry no markers and nothing else will
  tell you that your renamed string broke another branch's assertion. A
  conflicting PR runs no CI at all, so after resolving, re-push **and**
  re-request the review that never ran. When the fallen-behind branch is a
  stacked PR rebasing onto its own now-merged predecessor, take the
  predecessor's merged state as the base and re-apply the stacked change on
  top rather than resolving hunk-by-hunk — treat each component and its test
  as one indivisible unit, because a mixed-side resolution produces a green
  suite asserting a contract the code no longer implements.
- **Test-merge before trusting two in-flight branches together.** Once your
  branch is in the merge queue this is structurally handled — the queue builds
  and tests your PR on top of `main` plus everything ahead of it. Before that,
  do it by hand from the branch:

  ```bash
  git merge --no-commit --no-ff origin/main   # or the other branch's ref
  pnpm test -- --run                          # the full suite, on the combined tree
  git merge --abort                           # throw the trial merge away
  ```

### Rolling dispatch, load-aware

Waves are a scheduling model, not a batching requirement. Prefer **rolling
dispatch**: when one batch lands, top the pool back up to its ceiling rather
than waiting for a whole wave to drain. Two conditions on that:

- **Check machine load before topping up.** Other agents and the operator's own
  dev servers share the machine; an over-subscribed machine starves hooks and
  turns green work red. If load is high, hold the slot.
- **Reuse veterans for repeat rebases.** Continue the agent that already owns a
  branch (`SendMessage`) instead of spawning a fresh one — it holds the conflict
  history a new agent would have to rediscover.
- **Give push-capable agents foreground-only instructions.** An agent that
  backgrounds a long command and then waits for a notification stalls
  indefinitely; tell it to run gates in the foreground.
- **Never stop a process you did not start**, and never by name — see the
  process rule in `AGENTS.md`.

### Close-out discipline

- **Keep a follow-ups ledger during the run.** Anything deferred, out of scope,
  or larger than its batch gets written down the moment it is found, with enough
  context to act on later.
- **File the ledger before declaring the programme done.** An unfiled follow-up
  is a lost one; every entry becomes a real tracker issue with its evidence.
- **Remove a worktree only once its content is provably on `main`.** "The PR was
  green" is not proof, and neither is "it merged" on its own — a squash rewrites
  history, so the test is that the PR merged **and** the branch tip is still the
  commit that merged (anything pushed after the merge is not in `main`). In this
  repo `/worktree:prune` and `scripts/should-reap-worktree.sh` make exactly that
  decision; use them rather than eyeballing it, and never remove a worktree
  holding uncommitted or unpushed work.

> Non-normative: this playbook is written against the `Agent` tool so it works
> in any harness that can spawn a subagent — and runs the same way sequentially,
> one batch at a time, in a harness that spawns none. A session orchestrator that
> can drive several sessions at once parallelizes the same method without
> changing any of it.

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
