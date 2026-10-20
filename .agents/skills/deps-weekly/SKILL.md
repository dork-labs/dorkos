---
name: deps-weekly
description: "Monday DorkOS dependency upkeep, called from @dorkos-qa's heartbeat: runs /app:upgrade unattended in a throwaway worktree, lands one PR per lane, files tickets for majors, and posts one line to @dorkos-pm. Never bumps the runtime SDKs (that is runtime-watch). Use only when a heartbeat checklist or a person asks for the weekly dependency upkeep."
---

# deps-weekly

The weekly dependency pass. It is `/app:upgrade` in its default `auto` mode, wrapped in the rules that make it safe to run from a heartbeat with nobody watching. It is a skill, not a schedule: @dorkos-qa's heartbeat calls it on Monday, so it runs with that agent's permissions and raises no approval cards.

The procedure is `.claude/commands/app/upgrade.md`; the judgment is the `maintaining-dependencies` skill (`.claude/skills/maintaining-dependencies/SKILL.md`). Read both before step 3. This file adds only what a heartbeat run needs on top.

## Run

1. **Work in a throwaway copy, never a shared checkout.** `git fetch origin`, pin `BASE=$(git rev-parse origin/main)` and compare against `$BASE` for the whole run. Clear a copy a killed run left behind (`git worktree remove --force "$TMPDIR/deps-weekly" 2>/dev/null; git worktree prune`), then `git worktree add --detach "$TMPDIR/deps-weekly" "$BASE"` and run everything from there. Each lane branches from it.
2. **Check room first.** Count worktrees on this machine that hold a `node_modules`. If two already do, stop and report "skipped: disk" rather than add a third. Check `df -h /`: under 20 GB free, stop and say so. Then `pnpm install --frozen-lockfile --prefer-offline` and `pnpm --filter @dorkos/shared build`, on Node 24.
3. **Run the procedure** in `.claude/commands/app/upgrade.md` with no arguments (`auto`). In Claude Code that is `/app:upgrade`; in any other harness, read the file and follow it step by step. Its autonomous contract holds as written: one PR per lane, idempotent branch prefixes, the ledger edited with the override, nothing merged by hand.
4. **Apply the DorkOS landing rules** to every PR the run opens:
   - Commits are `chore(deps)`, never `fix(` or `refactor(`, so no changelog fragment is seeded. Label `skip-changelog` and `review:light`.
   - A PR that touches auth, permissions, connectors, mini apps (extensions), relay or Cloud auth opens with the `hold` label and stays unarmed. Post it in #dorkos for @security-auditor; only their OK there lifts it.
   - Arm your own green PR with `gh pr merge --auto <n>` only when it needs no Security review. Never an admin merge, never an empty commit, never a branch update to satisfy a gate.
   - Patches and security fixes land on green. A major, or anything the run calls breaking, gets a ticket for @dorkos-pm and no commit.
5. **Leave the runtime SDKs alone.** The families in `.claude/config/runtime-deps.json`, plus the Pi packages in `packages/doe`, are excluded by the procedure's rule 2. If the run sees them drift, it names them in the report and points at `runtime-watch`.
6. **Escalate security by severity.** A critical or high advisory that the run fixed: ask @dorkos-pm for a same-day patch release once its PR merges. Critical with no fix: a PR (or a ticket with the blocker) within 48 hours. High: within 7 days. Medium and low: the monthly batch.
7. **Clean up.** Remove `$TMPDIR/deps-weekly` and any lane worktree whose PR is open and pushed. Spare nothing that holds unpushed work.

## Report

One line to @dorkos-pm, in #dorkos, in this shape:

`Deps (Mon <date>): updated <n> (<PR titles>), waiting <n> (<why>), alerts crit/high/med/low <a>/<b>/<c>/<d>, runtimes: <see runtime-watch | none>.`

A quiet week is one line too: `Deps (Mon <date>): nothing to update, alerts 0 open.` A lane that could not finish is the first thing in the line, never left out.

## Never

- Bump a runtime SDK, a major, or a `.github/dependabot.yml` family here.
- Run paid evals, set a paid flag, or spend money in any form.
- Touch another agent's worktree or PR, `git stash`, `git checkout -- <path>`, or kill a process by name.
