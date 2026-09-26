#!/bin/bash
# sync-main-checkout.sh
# Keeps the main checkout's local `main` branch level with origin/main.
# Called by session-maintenance.sh with the SessionStart payload on stdin,
# whichever checkout (main or a linked worktree) the session starts in.
#
# Why this exists. Nothing in this repo ever moves local `main`: everything
# lands on GitHub through PRs and the merge queue, worktrees branch from
# origin/main, and `git fetch` moves origin/main but never `main`. So the main
# checkout drifted a day's worth of merges behind at a time (38 commits on
# 2026-09-26) while `pnpm dev` and `pnpm dev:dogfood` kept serving its stale
# tree, and an agent reading files there got stale answers.
#
# What it does, in the main checkout only, and only while it is on `main`:
#   - level with origin/main          -> nothing, silently
#   - behind, clean                   -> `git merge --ff-only`, one line
#   - behind, tracked changes         -> no change, one warning line
#   - has commits origin/main lacks   -> no change, one warning line
#   - merge/rebase/cherry-pick/lock   -> nothing, silently
# Untracked files do not count as dirty: build output lives there, and
# `merge --ff-only` already refuses to overwrite an untracked file in its way.
# A fast-forward can never lose work, but it is still skipped on a tree with
# tracked changes: dirty `main` is itself the mistake worth surfacing.
#
# It moves the tree only when a session truly STARTS (payload source
# "startup", or no payload at all when run by hand). SessionStart also fires on
# resume, /clear and compaction, and moving files under a session that is
# mid-task makes its in-context copies stale; those runs do nothing at all.
#
# It compares against the origin/main this clone already has, so it never waits
# on the network. Then it starts one background `git fetch` (never two at once,
# never prompting, abandoned after a 20s stall) so the next session compares
# against a fresher ref.
#
# The switch is per clone, in git config (never a tracked file, which would
# dirty `main` just to flip it), and every worktree shares it:
#   git config dorkos.mainSync warn      # report only, never move main
#   git config dorkos.mainSync off       # silent, no fetch
#   git config --unset dorkos.mainSync   # back to the default, ff
# DORKOS_MAIN_SYNC_FETCH=0 skips the background fetch (the fixtures use it).
#
# Always exits 0 and prints at most one "[Harness]" line. Fixtures:
# scripts/test-sync-main-checkout.sh

set -u

payload=""
[ -t 0 ] || payload=$(cat)
if [ -n "$payload" ] &&
  ! printf '%s' "$payload" | grep -Eq '"source"[[:space:]]*:[[:space:]]*"startup"'; then
  exit 0
fi

note=""
mode=$(git config --get dorkos.mainSync 2>/dev/null || true)
case "${mode:-ff}" in
  ff | warn) mode=${mode:-ff} ;;
  off) exit 0 ;;
  *)
    note="(dorkos.mainSync is '$mode', expected ff, warn or off, so only warning)"
    mode=warn
    ;;
esac

# The first porcelain block is the main working tree, or the bare repository
# when there is none; a bare repo has no checkout to sync.
first_block=$(git worktree list --porcelain 2>/dev/null | sed '/^$/q')
main=$(printf '%s\n' "$first_block" | sed -n '1s/^worktree //p')
[ -n "$main" ] && [ -d "$main" ] || exit 0
printf '%s\n' "$first_block" | grep -qx bare && exit 0
gitdir=$(git -C "$main" rev-parse --absolute-git-dir 2>/dev/null) || exit 0

# Refresh origin/main for the NEXT session, detached with every fd redirected
# so the hook returns immediately. Refs only, never the working tree; one at a
# time (pid file); a stalled transfer gives up instead of hanging forever; no
# credential or passphrase prompt; no auto-gc in the object store every
# worktree shares.
start_fetch() {
  [ "${DORKOS_MAIN_SYNC_FETCH:-1}" = 0 ] && return
  local pidfile="$gitdir/dorkos-main-sync-fetch.pid" pid
  pid=$(cat "$pidfile" 2>/dev/null)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && return
  if [ -z "${GIT_SSH_COMMAND:-}" ] && [ -z "$(git -C "$main" config --get core.sshCommand 2>/dev/null)" ]; then
    export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"
  fi
  GIT_TERMINAL_PROMPT=0 nohup git -C "$main" \
    -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 \
    -c maintenance.auto=false -c gc.auto=0 \
    fetch --quiet --no-write-fetch-head origin main \
    >/dev/null 2>&1 </dev/null &
  echo $! >"$pidfile" 2>/dev/null
}

finish() {
  local line=${1:-}
  if [ -n "$line" ] && [ -n "$note" ]; then
    line="$line $note"
  elif [ -n "$note" ]; then
    line="[Harness] $note"
  fi
  [ -n "$line" ] && echo "$line"
  start_fetch
  exit 0
}

[ "$(git -C "$main" symbolic-ref --quiet HEAD 2>/dev/null)" = refs/heads/main ] || finish
git -C "$main" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null || finish
for marker in index.lock MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  [ -e "$gitdir/$marker" ] && finish
done

counts=$(git -C "$main" rev-list --left-right --count refs/heads/main...refs/remotes/origin/main 2>/dev/null) || finish
read -r ahead behind <<<"$counts"
[ -n "${behind:-}" ] || finish

case $main in *" "*) shown="'$main'" ;; *) shown=$main ;; esac
pull="git -C $shown pull --ff-only"
if [ "$ahead" -gt 0 ]; then
  finish "[Harness] local main has $ahead commit(s) origin/main lacks, so it was not synced — land them from a worktree (working-in-worktrees: 'Landing Work from a Shared or Diverged Checkout')"
fi
[ "$behind" -eq 0 ] && finish

# --no-optional-locks: a plain status refreshes the index and takes index.lock,
# which would break a commit another session is making in the main checkout.
status=$(git -C "$main" --no-optional-locks status --porcelain --untracked-files=no 2>/dev/null) || finish
if [ -n "$status" ]; then
  dirty=$(printf '%s\n' "$status" | grep -c .)
  finish "[Harness] main is $behind commit(s) behind origin/main but has $dirty uncommitted change(s), so it was not synced — move the work to a worktree, then: $pull"
fi
if [ "$mode" = warn ]; then
  finish "[Harness] main is $behind commit(s) behind origin/main — $pull"
fi

old=$(git -C "$main" rev-parse refs/heads/main)
if git -C "$main" merge --ff-only --quiet refs/remotes/origin/main >/dev/null 2>&1; then
  new=$(git -C "$main" rev-parse refs/heads/main)
  moved=$(git -C "$main" rev-list --count "$old..$new")
  deps=""
  git -C "$main" diff --quiet "$old" "$new" -- pnpm-lock.yaml || deps=" — pnpm-lock.yaml changed, run pnpm install"
  finish "[Harness] main fast-forwarded $moved commit(s) to $(git -C "$main" rev-parse --short "$new")$deps (pause with: git config dorkos.mainSync warn)"
fi
finish "[Harness] main is $behind commit(s) behind origin/main and the fast-forward failed — $pull"
