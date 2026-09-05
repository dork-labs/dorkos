---
name: working-in-worktrees
description: Decides when agent work needs an isolated git worktree and how to create, enter, and clean one up safely. Use when starting code changes in a checkout that may be shared with another agent, dispatching a Linear task, executing a spec, or running any parallel work that mutates tracked files.
---

# Working in Worktrees

## Overview

This skill governs **workspace isolation** for code work in DorkOS — a repo that is routinely worked by several agents and sessions at once. It teaches the one decision rule (_one checkout, one writer_), the concrete failure mode that makes isolation non-optional, the exact mechanics for creating, entering, and cleaning up a worktree without losing anyone's work — and the half that isolation does **not** buy you, because worktrees separate working trees but share every ref.

The repo-wide rule lives in `AGENTS.md` → **Worktrees**. This skill is the mechanics and the _why_.

## When to Use

- You are about to make a code change and the checkout **may be shared** with another agent or session.
- You are running the `/flow:execute` stage (the workspace-choice phase of the flow plugin's `executing-specs` skill) — the unified `/flow` execution gate.
- You are running parallel work that mutates tracked files.
- You are comparing your branch against `main` across **more than one command** — a conflict investigation, a red-before drill, a changelog gate, a "what did `main` change" question.
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

### Two readers, one ref namespace

The hazard above is about two **writers** sharing one working tree. There is a second, quieter one: two **readers** sharing one set of refs. A worktree isolates the working tree. It does **not** isolate the refs or the object store — those live in the common git dir, shared by every worktree of this repo:

```bash
git rev-parse --git-dir --git-common-dir              # differ ⇒ you are in a secondary worktree
git rev-parse --git-path refs/remotes/origin/main     # …yet this resolves under the COMMON dir
```

So you can hold a perfectly isolated tree and still share one `origin/main` with every other session on the machine. When any of them runs `git fetch`, that ref moves **for you too** — including between two commands of your own investigation.

**Nothing errors.** Every command exits `0`. Two `git` invocations seconds apart simply answer against different trees, and the inconsistency surfaces only as a conclusion that does not match the code. On 2026-09-01, with two sessions in one checkout, an agent resolving a merge conflict listed the files `main` had touched, reasoned about that list, and concluded `main` had modified client model-picker files it had never touched — a concurrent session had fetched mid-investigation. It recovered by re-deriving everything against a pinned SHA, but only because the answer had looked implausible. A wrong answer that looks reasonable does not get caught.

**The rule: pin the base once, then never name the moving ref again.**

```bash
BASE=$(git rev-parse origin/main)          # once, at the start of the comparison
git diff --name-only "$BASE"...HEAD
git log --oneline "$(git merge-base "$BASE" HEAD)"..HEAD
```

- Use `$BASE` for every step of a multi-step comparison — **never write `origin/main` twice** in one line of reasoning.
- Prefer `git merge-base "$BASE" HEAD` over re-reading the branch name. A merge base recomputed against a ref that moved is a _different_ merge base, silently.
- **Treat a surprising file list as evidence the ref moved, not as data.** A diff naming files nobody on your branch went near is a symptom, not a discovery — re-derive it against a pinned SHA before you reason one step further.
- **Hand people SHAs, not ref names.** "`main` touched 8 files" is unfalsifiable an hour later; "`2a8fb9c9b` touched 8 files" is checkable forever. `git show --name-only --format='' 2a8fb9c9b` returns the same eight paths on every machine, at every hour, regardless of who fetched — which is the whole property a moving ref lacks.

The same shape bites outside `git`. PR #1413 reported `mergeable: MERGEABLE` from the GitHub API while its own merge-queue entry read `UNMERGEABLE`, and a local test-merge disagreed with both — three answers to one question, each read at a slightly different moment. Any answer you did not pin is a snapshot, not a fact.

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
   /worktree:create <branch-name>            # from origin/main (default)
   /worktree:create <branch-name> --from-current
   ```

   **Do not key the branch by ticket id unless the branch will _complete_ that ticket.** Linear closes an issue whose identifier appears in the merged PR's branch name, so `DOR-123` on a branch that only partly delivers DOR-123 closes it anyway. Use a descriptive slug for partial work; see `creating-pull-requests` → **A merged PR closes the ticket it names**.

   This provisions everything via `.gtrconfig`: copies `.env`/`.mcp.json`/`.vercel`, runs `pnpm install`, generates fumadocs types, and patches **unique `DORKOS_PORT`/`VITE_PORT`/`SITE_PORT`** values (`worktree-setup.sh`) so parallel `pnpm dev` instances never collide. Worktrees live under `gtr.worktrees.dir` — `~/.dork/workspaces/<project>/<branch>/`, committed in `.gtrconfig` but overridable per machine by an untracked `.git/config`, so resolve it rather than assuming (`git config --get gtr.worktrees.dir`, or `git gtr go <branch>` for the full path).

   **Port isolation only works for dev scripts that read their port from one of those env vars.** A hardcoded port in any package's dev script collides with the main checkout, and one `EADDRINUSE` kills the entire `turbo dev` run (persistent tasks take their siblings down). If you add a dev script that listens on a port: take the port from an env var, patch that var in `worktree-setup.sh`, and add it to `globalPassThroughEnv` in `turbo.json` — Turbo's strict env mode silently strips undeclared vars before they reach the task process.

   **Lighter dev runs:** when you only need the app (e.g. testing a server/client change), skip the site and plugin builds entirely: `pnpm exec dotenv -- turbo dev --filter=@dorkos/server --filter=@dorkos/client`.

4. **Verify it exists before you rely on it — `gtr` reports success either way.** (`/worktree:create` runs `git gtr new` underneath, so this applies however you created it.)

   On 2026-07-28 `git gtr new … --yes` printed `[OK] Worktree created: <path>` **four times for paths that did not exist** when an agent went to use them; `git worktree list` had no record of them either. Worktrees that were **never written to** did not survive; every one an author actually committed in did. The mechanism is unknown, so treat that success line as a claim, not a fact:

   ```bash
   git gtr new <branch> --from origin/main --yes     # only if creating by hand
   W=$(git gtr go <branch> | tail -1)                 # resolves the folder: slashes become hyphens
   if [ -d "$W" ]; then
     git -C "$W" log --oneline -1
     git -C "$W" rev-list --count HEAD..origin/main   # 0 == based on origin's tip
   else
     echo "MISSING — recreate it"
   fi
   ```

   **Every line that touches `$W` must sit inside the guard.** `git gtr go` prints nothing to stdout when the worktree is missing, and `git -C ""` falls back to the _current_ directory — so a `git -C "$W" …` left outside the `if` reports on wherever you happen to be standing, exits `0`, and manufactures the success you were trying to disprove.

   Notice how far that defect travelled: `gtr` reported a creation that had not happened, the first check written against it could not fail, and the fix for _that_ check left its second line unguarded — three layers of the same mistake in one thread. A check that cannot fail is worse than no check, because it produces confidence instead of an answer.

   **Always pass `--from origin/main`.** A bare `git gtr new` bases on the _local_ default branch, which drifts behind; local `main` was three commits behind `origin/main` when this was written. An author who quietly recreated a missing worktree got exactly that, and caught it only just before writing code.

   **Then commit something before you hand the path to anyone.** An empty worktree is the kind that vanishes, and a path in a briefing is a promise someone else acts on. Equally, **if you were handed a path, verify it before you start and say so if it is wrong.** Of three agents briefed against paths that did not exist, two silently recreated or relocated them and only the third reported it — which is the only reason this was found at all. Adapting quietly costs the orchestrator more than failing loudly.

5. **Enter without restarting** — move the running session in with the **EnterWorktree** tool, passing `path` = the new worktree's absolute location. **`EnterWorktree` accepts gtr worktrees** — it works for any path that appears in `git worktree list`, which gtr's `~/.dork/workspaces/…` worktrees do. The session cwd switches with no CLI restart and the SDK session continues. Do _not_ believe the stale claim that a gtr worktree must be re-created under `.claude/worktrees/` before it can be entered — that older limitation no longer holds (re-confirmed 2026-06-27). (`claude -w <name>` instead starts a _fresh_ session already inside one.)

6. **Do the work**, commit, push, open the PR from the worktree branch.

7. **Exit** with **ExitWorktree** (`keep` to leave it on disk, `remove` to delete) before cleanup, or `cd` back to the main checkout.

8. **Clean up after merge** — for the one worktree you know about, `/worktree:remove <branch> --delete-branch`. But the merge usually lands after your session is over (auto-merge and the merge queue both run on their own clock), so the more reliable habit is to sweep at the **start** of a session rather than the end of one:

   ```
   /worktree:prune          # what would go, and why
   /worktree:prune --fix    # remove it
   ```

   That collects everything that merged while you were away, not just the branch you happen to be thinking about. It refuses anything it cannot prove is safe — uncommitted, unpushed, still open, or unaskable — and names the reason for each. `/flow:done` (`closing-work`) also offers cleanup for a worktree recorded in `04-implementation.md`, but only when a session is alive to accept the offer, which is exactly the case that keeps not happening.

   **Do not skip this because the worktree is "just" a review checkout.** Review checkouts were 47 of the 107 worktrees the 2026-08-01 sweep removed — the largest single category — at ~3.5 GB each (`research/20260801_worktree-and-branch-sweep.md`).

## Landing Work from a Shared or Diverged Checkout

When you've already committed on a shared `main` that has diverged from `origin/main` (another agent's merge landed upstream while you worked, so a plain `git push` is rejected), **do not rebase the shared checkout** — that churns the working tree and can yank the branch out from under the co-tenant agent. Land your commit through an isolated worktree instead:

1. `git fetch origin` — refs only; never touches the working tree.
2. `git worktree add <path> -b <branch> origin/main` — a fresh worktree at origin's tip.
3. `git -C <path> cherry-pick <your-sha>` — re-apply just your commit. It carries your changelog fragment (a uniquely-named file under `changelog/unreleased/`), which cannot conflict with anyone else's fragment — the shared `[Unreleased]` conflict is gone (ADR 260707-231641).
4. **Watch for a stray fragment on cherry-pick.** The `post-commit` hook re-derives a fragment from the commit subject; it dedupes by entry line, so a replay normally writes nothing. If a redundant fragment does appear, delete it and `git commit --amend` with the hook suppressed: `touch <path>/.claude/.changelog-populator.lock` first, `rm` it after (`--no-verify` does **not** skip a post-commit hook). See `.claude/git-hooks/changelog-populator.py`.
5. `git -C <path> push -u origin <branch> --no-verify` — a native worktree has no `node_modules`, so the lefthook pre-push can't run; the commit already passed pre-commit lint in the source checkout, and CI is the backstop.
6. Open the PR, merge, then `git worktree remove <path>` + delete the branch.
7. **Reconcile the shared checkout** once its working tree is clean: `git fetch && git reset --hard origin/main` drops the now-redundant local commit (recoverable via reflog) so local `main` matches origin. Re-check `git status` is clean immediately before resetting.

Better still: start the work in a worktree from the outset (the steps above, minus the cherry-pick) so the divergence never happens.

## Best Practices

- **Key by unit of work, not session.** `spec-<slug>` or `DOR-123` — a workspace outlives any one session and can be reattached. Use `DOR-123` only when the branch will **complete** that ticket; merging a branch whose name carries the id closes the issue (step 3).
- **Prefer gtr worktrees** (`/worktree:create`) over native `claude -w`/`.claude/worktrees/` for anything that runs lint/typecheck hooks or a dev server — gtr ones are fully provisioned; native ones are instant but unprovisioned (fine for docs-only).
- **`main` is the merge target, not the workbench.** Land branches into it; don't accumulate ad-hoc code edits there.
- **Record the worktree** in `04-implementation.md` (specs) so completion and the `/flow:done` stage can offer cleanup.

## Common Pitfalls

- ❌ Starting code work in a shared checkout "because it's a small change" — the auto-checkpoint race does not care how small your change is.
- ❌ Creating a worktree from inside a worktree (always run the two-path `rev-parse` detection first).
- ❌ Trusting `gtr`'s `[OK] Worktree created` line — check the path exists and commit in it before handing it to anyone.
- ❌ Silently recreating or relocating a worktree path you were handed. Say it is wrong; the orchestrator cannot see what you quietly fixed, and the replacement may be based on a stale local `main`.
- ❌ Auto-removing a worktree with **uncommitted, untracked, or unpushed** work — refuse and confirm first. This is where Claude Code and Cursor both shipped data-loss bugs.
- ❌ Forcing the `/flow` intent stages (`/flow:ideate`, `/flow:specify`, `/flow:decompose`) into worktrees — they only write `specs/` markdown; stay in `main`.
- ❌ Reading `.env` directly to learn a worktree's ports (the file-guard hook denies it) — use `/worktree:list`.
- ❌ Naming `origin/main` twice in one investigation. Pin it once (`BASE=$(git rev-parse origin/main)`) and compare against `$BASE` — another session's `git fetch` moves the shared ref between your commands, and every command still exits `0`.
- ❌ Believing a file list that surprised you. In a shared checkout that is first evidence the ref moved, not a finding to reason from.

## References

- Repo rule: `AGENTS.md` → **Worktrees**
- Commands: `/worktree:create`, `/worktree:list`, `/worktree:remove`
- Execution gate: the `/flow:execute` stage, the workspace-choice phase of the flow plugin's `executing-specs` skill
- Cleanup: the `/flow:done` stage (`closing-work` skill)
- Strategy + industry failure modes: `research/20260611_workspace_strategy_runtimes_symphony.md`
- Parallel-vs-isolation tradeoffs: `contributing/parallel-execution.md`
