---
name: working-in-worktrees
description: Decides when agent work needs an isolated git worktree and how to create, enter, and clean one up safely. Use when starting code changes in a checkout that may be shared with another agent, dispatching a Linear task, executing a spec, or running any parallel work that mutates tracked files.
---

# Working in Worktrees

## Overview

This skill governs **workspace isolation** for code work in DorkOS — a repo that is routinely worked by several agents and sessions at once. It teaches the one decision rule (_one checkout, one writer_), the concrete failure mode that makes isolation non-optional, and the exact mechanics for creating, entering, and cleaning up a worktree without losing anyone's work.

The repo-wide rule lives in `AGENTS.md` → **Worktrees**. This skill is the mechanics and the _why_.

## When to Use

- You are about to make a code change and the checkout **may be shared** with another agent or session.
- You are running the `/flow:execute` stage (the workspace-choice phase of the flow plugin's `executing-specs` skill) — the unified `/flow` execution gate.
- You are running parallel work that mutates tracked files.
- You need to create, enter, exit, or remove a worktree and want the safe procedure.
- You are _unsure_ whether to isolate — the default answer for code work in this repo is **yes**.

## Key Concepts

### The rule: one checkout, one writer

`main` is the **clean integration tree**, not a shared scratchpad. Code changes default to an **isolated worktree**; `main` stays clean and is where branches merge back.

**Default to a worktree for any code change.** Stay in `main` only when _all three_ hold:

1. You are **certainly the sole writer** in this checkout, **and**
2. The work is **non-code** (`research/`, `specs/`, tracker, docs prose) **or** a single commit you land immediately, **and**
3. **No long-running dev server** in this checkout needs to stay undisturbed.

Create a worktree when **any** trigger fires:

- 🔴 **Another agent/session may be active here** — the DorkOS default. You usually cannot prove you are alone, so assume you are not.
- 🔴 **Multi-commit / long-lived code work** — a feature, refactor, or spec implementation.
- 🟡 The checkout is already **dirty or on an unrelated topic** branch.
- 🟡 A **dev server or build** must run undisturbed (port isolation).

### Why this is non-negotiable: the auto-checkpoint race

The `Stop` hook `.claude/hooks/create-checkpoint.sh` runs on **every turn** and does `git add -A` → `git stash create` → `git reset`. In a checkout that a **second writer** is touching, that index churn races concurrent git operations:

- It can fire between another agent's `git add` and its commit write, **unstaging that agent's files** → an **empty-tree ("no-op") commit**.
- It can **sweep another agent's uncommitted changes** into your working tree.

This is not theoretical — it happened while dispatching `DOR-101` (an empty-tree commit that had to be recovered via `--amend`). Your own research documents the **identical** industry failure: Cursor "silently ran `git stash` + `git reset HEAD` mid-session"; Claude Code auto-cleanup deleted 10 days of uncommitted work (#46444). See `research/20260611_workspace_strategy_runtimes_symphony.md`. A worktree gives each agent its own tree, so each checkpoint only ever touches that agent's own work — the race cannot happen.

The hook also self-defends: it **bails when a git operation is in progress** (`index.lock`, rebase/merge/cherry-pick state). That narrows the window but does **not** replace isolation — worktrees are the structural fix.

### Non-code phases stay in `main`

The `/flow` intent stages — `/flow:ideate`, `/flow:specify`, `/flow:decompose` — write **only `specs/` markdown** (plus tracker breadcrumbs). They do not mutate code, so they run in `main` without a worktree. Isolation begins at **execution** — the `/flow:execute` stage, the workspace-choice phase of the flow plugin's `executing-specs` skill.

## Step-by-Step Approach

1. **Detect whether you are already in a worktree.**

   ```bash
   git rev-parse --git-dir --git-common-dir
   ```

   The two paths are **equal only in the main worktree**. If they differ, you are already in a secondary worktree — **work here, do not nest**. Never create a worktree from inside one.

2. **Judge "am I alone?"** You usually can't prove it. Heuristics, weakest to strongest:
   - Did _you_ start this checkout, or were you handed it mid-state? Handed-in ⇒ assume shared.
   - `git status` shows changes you did not make ⇒ another writer is here.
   - `git worktree list` shows siblings ⇒ multi-worktree work is already underway.
   - **Default for this repo: assume shared.** When in doubt, isolate.

3. **Create the worktree** (keyed by unit of work — `spec-<slug>`, `DOR-123`):

   ```
   /worktree:create <branch-name>            # from main (default)
   /worktree:create <branch-name> --from-current
   ```

   This provisions everything via `.gtrconfig`: copies `.env`/`.mcp.json`/`.vercel`, runs `pnpm install`, generates fumadocs types, and patches **unique `DORKOS_PORT`/`VITE_PORT`/`SITE_PORT`** values (`worktree-setup.sh`) so parallel `pnpm dev` instances never collide. Worktrees live at `~/.dork/workspaces/dorkos/<branch>/`.

   **Port isolation only works for dev scripts that read their port from one of those env vars.** A hardcoded port in any package's dev script collides with the main checkout, and one `EADDRINUSE` kills the entire `turbo dev` run (persistent tasks take their siblings down). If you add a dev script that listens on a port: take the port from an env var, patch that var in `worktree-setup.sh`, and add it to `globalPassThroughEnv` in `turbo.json` — Turbo's strict env mode silently strips undeclared vars before they reach the task process.

   **Lighter dev runs:** when you only need the app (e.g. testing a server/client change), skip the site and plugin builds entirely: `pnpm exec dotenv -- turbo dev --filter=@dorkos/server --filter=@dorkos/client`.

4. **Enter without restarting** — move the running session in with the **EnterWorktree** tool, passing `path` = the new worktree's absolute location. **`EnterWorktree` accepts gtr worktrees** — it works for any path that appears in `git worktree list`, which gtr's `~/.dork/workspaces/dorkos/…` worktrees do. The session cwd switches with no CLI restart and the SDK session continues. Do _not_ believe the stale claim that a gtr worktree must be re-created under `.claude/worktrees/` before it can be entered — that older limitation no longer holds (re-confirmed 2026-06-27). (`claude -w <name>` instead starts a _fresh_ session already inside one.)

5. **Do the work**, commit, push, open the PR from the worktree branch.

6. **Exit** with **ExitWorktree** (`keep` to leave it on disk, `remove` to delete) before cleanup, or `cd` back to the main checkout.

7. **Clean up after merge** — the `/flow:done` stage (`closing-work`) offers this; `/flow:execute` records the worktree in `04-implementation.md`:
   ```
   /worktree:remove <branch> --delete-branch
   ```

## Landing Work from a Shared or Diverged Checkout

When you've already committed on a shared `main` that has diverged from `origin/main` (another agent's merge landed upstream while you worked, so a plain `git push` is rejected), **do not rebase the shared checkout** — that churns the working tree and can yank the branch out from under the co-tenant agent. Land your commit through an isolated worktree instead:

1. `git fetch origin` — refs only; never touches the working tree.
2. `git worktree add <path> -b <branch> origin/main` — a fresh worktree at origin's tip.
3. `git -C <path> cherry-pick <your-sha>` — re-apply just your commit. The `[Unreleased]` CHANGELOG block is the usual conflict (your entry vs. upstream's) — resolve by **keeping both** lines.
4. **Watch for the changelog-populator duplicate.** The `post-commit` hook re-derives an entry from the commit subject; on older versions without a dedup guard it doubles your line. If so, fix it and `git commit --amend` with the hook suppressed: `touch <path>/.claude/.changelog-populator.lock` first, `rm` it after (`--no-verify` does **not** skip a post-commit hook). See `.claude/git-hooks/changelog-populator.py`.
5. `git -C <path> push -u origin <branch> --no-verify` — a native worktree has no `node_modules`, so the lefthook pre-push can't run; the commit already passed pre-commit lint in the source checkout, and CI is the backstop.
6. Open the PR, merge, then `git worktree remove <path>` + delete the branch.
7. **Reconcile the shared checkout** once its working tree is clean: `git fetch && git reset --hard origin/main` drops the now-redundant local commit (recoverable via reflog) so local `main` matches origin. Re-check `git status` is clean immediately before resetting.

Better still: start the work in a worktree from the outset (the steps above, minus the cherry-pick) so the divergence never happens.

## Best Practices

- **Key by unit of work, not session.** `spec-<slug>` or `DOR-123` — a workspace outlives any one session and can be reattached.
- **Prefer gtr worktrees** (`/worktree:create`) over native `claude -w`/`.claude/worktrees/` for anything that runs lint/typecheck hooks or a dev server — gtr ones are fully provisioned; native ones are instant but unprovisioned (fine for docs-only).
- **`main` is the merge target, not the workbench.** Land branches into it; don't accumulate ad-hoc code edits there.
- **Record the worktree** in `04-implementation.md` (specs) so completion and the `/flow:done` stage can offer cleanup.

## Common Pitfalls

- ❌ Starting code work in a shared checkout "because it's a small change" — the auto-checkpoint race does not care how small your change is.
- ❌ Creating a worktree from inside a worktree (always run the two-path `rev-parse` detection first).
- ❌ Auto-removing a worktree with **uncommitted, untracked, or unpushed** work — refuse and confirm first. This is where Claude Code and Cursor both shipped data-loss bugs.
- ❌ Forcing the `/flow` intent stages (`/flow:ideate`, `/flow:specify`, `/flow:decompose`) into worktrees — they only write `specs/` markdown; stay in `main`.
- ❌ Reading `.env` directly to learn a worktree's ports (the file-guard hook denies it) — use `/worktree:list`.

## References

- Repo rule: `AGENTS.md` → **Worktrees**
- Commands: `/worktree:create`, `/worktree:list`, `/worktree:remove`
- Execution gate: the `/flow:execute` stage, the workspace-choice phase of the flow plugin's `executing-specs` skill
- Cleanup: the `/flow:done` stage (`closing-work` skill)
- Strategy + industry failure modes: `research/20260611_workspace_strategy_runtimes_symphony.md`
- Parallel-vs-isolation tradeoffs: `contributing/parallel-execution.md`
