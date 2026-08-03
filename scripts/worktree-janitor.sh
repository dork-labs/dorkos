#!/usr/bin/env bash
# Remove the worktrees and local branches that finished work left behind.
#
# This is the driver; scripts/should-reap-worktree.sh is the decision, and every
# refusal it can make is pinned by fixtures. Read that header before changing
# anything here — the safety argument lives there, not in this file.
#
# Scope is deliberately LOCAL ONLY. Branches on origin are handled by GitHub's
# "automatically delete head branches" setting, enabled 2026-08-03, which covers
# everything merged from that date on. (It did not clear the pre-existing
# backlog; that was deleted by hand on 2026-08-01 — see
# research/20260801_worktree-and-branch-sweep.md.) This script cleans what GitHub
# cannot see: your worktrees and your local refs.
#
# Usage:
#   scripts/worktree-janitor.sh            # report what would go, write nothing
#   scripts/worktree-janitor.sh --fix      # actually remove them
#   scripts/worktree-janitor.sh --json     # machine-readable plan, writes nothing
#
# Dry run is the default and --fix is the only thing that writes, because the
# habit this replaces was "an agent decides cleanup is in scope and starts
# deleting". Seeing the plan first is the whole point.
#
# Requires git, jq and an authenticated gh. All three are checked up front: a
# missing one is a hard error, never a quiet empty plan.
#
# Known limit: a gh call that SUCCEEDS and returns `[]` is indistinguishable from
# a repo that genuinely has no pull requests, so it is taken at face value and
# every branch reports "NONE". What bounds that is rule 2's second half — a ref is
# only reaped under NONE when origin also carries no branch of its name, and a
# branch with a live pull request is on origin by definition. So the damage from a
# wrongly-empty listing is bounded to refs whose branch origin has already
# deleted, which are merged or abandoned. It is a bound, not a proof, and it is
# the reason that second half is not optional.
#
# EVERY failure path must refuse rather than permit. The gate's permissive inputs
# are `localOnlyCommits: 0`, `dirtyFiles: 0`, `ignoredFiles: 0` and
# `existsOnOrigin: false`, so anything this script cannot measure is reported as
# -1 (unmeasurable) or true, never as the convenient value. The first version got
# this backwards in two places: `|| echo 0` on a failed rev-list, and a failed
# `gh` lookup that reached the gate as prState "NONE" — the one substitution the
# gate's own header forbids, because "nobody proposed it" and "I could not ask"
# are different facts and only one is safe.

set -uo pipefail

MODE=""
for arg in "$@"; do
  case "$arg" in
    --fix | --json)
      want=${arg#--}
      # Last-flag-wins would silently turn an intended write into a read.
      if [[ -n "$MODE" && "$MODE" != "$want" ]]; then
        echo "conflicting modes: --$MODE and --$want" >&2
        exit 2
      fi
      MODE=$want
      ;;
    -h | --help)
      # Anchored on content, not line numbers: a hardcoded range silently starts
      # printing `set -uo pipefail` (or half a paragraph) the next time the
      # header grows, which is exactly what it did.
      sed -n '2,/^# Known limit/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done
MODE=${MODE:-report}

for tool in git jq gh; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "required tool not found: $tool" >&2
    exit 2
  }
done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DECIDE="$SCRIPT_DIR/should-reap-worktree.sh"
if [[ ! -x "$DECIDE" ]]; then
  echo "missing or non-executable: $DECIDE" >&2
  exit 2
fi

# The worktree this process is standing in. Never reaped, whatever else is true:
# removing the directory out from under a running shell is how a cleanup run
# takes its own operator down with it. An empty value here would silently drop
# that protection, so it is a hard error.
CURRENT_WT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$CURRENT_WT" ]]; then
  echo "not inside a git repository" >&2
  exit 2
fi

WARNINGS=()
note() {
  WARNINGS+=("$1")
  echo "warning: $1" >&2
}

# Counting local-only commits against a stale remote-tracking state is one way
# this gate silently gets more permissive, so refresh before counting.
[[ "$MODE" != json ]] && echo "Fetching origin (so local-only counts are honest)..."
if ! git fetch --prune --quiet origin 2>/dev/null; then
  note "git fetch failed; local-only counts may be stale"
  [[ "$MODE" == fix ]] && {
    echo "refusing to write on stale data" >&2
    exit 2
  }
fi

DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
if [[ -z "$DEFAULT_BRANCH" ]]; then
  DEFAULT_BRANCH=main
  note "could not read origin/HEAD; assuming the default branch is '$DEFAULT_BRANCH'"
fi

# The primary worktree — the original clone — is never a candidate.
PRIMARY_WT=$(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10); exit}')

# Branch names that exist on origin right now. A failed lookup means every branch
# is reported as still on origin, which is the KEEP direction.
ORIGIN_OK=true
ORIGIN_HEADS=$(git ls-remote --heads origin 2>/dev/null |
  sed 's|^[^	]*	refs/heads/||' | tr '\n' ' ' | sed 's/^/ /; s/$/ /')
if [[ -z "${ORIGIN_HEADS// /}" ]]; then
  ORIGIN_OK=false
  note "could not list origin branches; treating every branch as still on origin"
fi

# "No pull request has ever carried this branch" and "I could not ask GitHub" are
# different facts, and the gate refuses the second. Both the query FAILING and the
# query being TRUNCATED collapse into "I could not ask", so both set PR_OK=false
# and every branch then reports UNKNOWN.
PR_LIMIT=5000
PR_OK=true
PR_RAW=$(gh pr list --state all --limit "$PR_LIMIT" --json headRefName,state,headRefOid 2>/dev/null)
if [[ -z "$PR_RAW" ]] || ! jq -e 'type == "array"' >/dev/null 2>&1 <<<"$PR_RAW"; then
  PR_OK=false
  note "could not read pull requests from GitHub; every branch will report pr-state-unknown"
  PR_MAP='{}'
elif [[ $(jq 'length' <<<"$PR_RAW") -ge $PR_LIMIT ]]; then
  # A truncated page would turn every PR beyond the cut into "nobody proposed it".
  PR_OK=false
  note "pull request listing hit the $PR_LIMIT limit and may be truncated; every branch will report pr-state-unknown"
  PR_MAP='{}'
else
  # Rank OPEN highest, then CLOSED, then MERGED — the CONSERVATIVE order, not the
  # chronological one. A branch carrying both an old merged PR and a live open one
  # must reach `KEEP pr-open`, not be judged under rule 1 against the old merge.
  # `<=` rather than `<` so that among equals the LAST record wins deterministically
  # instead of depending on gh's undocumented newest-first ordering.
  PR_MAP=$(jq -c 'reduce .[] as $p ({};
    ($p.state) as $s
    | (if $s == "OPEN" then 3 elif $s == "CLOSED" then 2 else 1 end) as $rank
    | if (.[$p.headRefName] // {rank: 0}).rank <= $rank
      then .[$p.headRefName] = {state: $s, sha: ($p.headRefOid // ""), rank: $rank}
      else . end)' <<<"$PR_RAW")
fi

# Ignored paths that this repo can rebuild from source or from the worktree-setup
# hook. Anything ignored and NOT matching this is treated as work: the dev data
# directory apps/server/.temp/.dork/ (SQLite, agent.json) and a session handoff
# under .temp/ both live here, and `git status --porcelain` cannot see either
# while `git worktree remove --force` deletes both.
REGENERABLE='^(node_modules|\.turbo|dist|build|coverage|\.next|\.source|\.env|\.mcp\.json|\.DS_Store)|/(node_modules|\.turbo|dist|build|coverage|\.next|\.source)/|\.tsbuildinfo|next-env\.d\.ts'

# How long a worktree must sit untouched before it is even a candidate. This repo
# is routinely multi-agent and a freshly-created worktree is the most
# reapable-LOOKING thing there is — no commits, no pull request, no branch on
# origin — so without this the janitor races peers that are still setting up.
IDLE_HOURS=${DORKOS_JANITOR_IDLE_HOURS:-24}

# Newest mtime of the worktree root and its git admin dir, in epoch seconds.
# BSD and GNU stat disagree on flags, so try both; an unreadable timestamp means
# "assume active", which is the KEEP direction.
mtime_of() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo ""
}
is_recently_active() {
  local wt=$1 gitdir newest now t
  gitdir=$(git -C "$wt" rev-parse --git-dir 2>/dev/null)
  newest=""
  # Deliberately NOT the git-dir directory itself. Git bumps that directory's
  # mtime during routine maintenance — this script's own `git fetch --prune`
  # does it — so using it made every worktree permanently "active" and the
  # janitor a guaranteed no-op. Measured: three worktrees idle 137-186h by root
  # mtime all reported 0h by git-dir mtime, with nothing inside them newer than
  # a week.
  #
  # These four move only when somebody works: a top-level file appears, the
  # index is written, HEAD moves, or a ref moves.
  for p in "$wt" "$gitdir/index" "$gitdir/HEAD" "$gitdir/logs/HEAD"; do
    [[ -e "$p" ]] || continue
    t=$(mtime_of "$p")
    [[ -z "$t" ]] && continue
    [[ -z "$newest" || "$t" -gt "$newest" ]] && newest=$t
  done
  if [[ -z "$newest" ]]; then
    echo true
    return
  fi
  now=$(date +%s)
  if [[ $((now - newest)) -lt $((IDLE_HOURS * 3600)) ]]; then echo true; else echo false; fi
}

PLAN='[]'
SEEN_BRANCHES=""

add_entry() {
  local branch=$1 sha=$2 localonly=$3 dirty=$4 ignored=$5 current=$6 protected=$7 detached=$8 wt=$9 active=${10}
  local pr_state pr_sha on_origin payload verdict
  if [[ "$PR_OK" != true ]]; then
    pr_state="UNKNOWN"
    pr_sha=""
  elif [[ -n "$branch" ]]; then
    pr_state=$(jq -r --arg b "$branch" '(.[$b].state // "NONE")' <<<"$PR_MAP")
    pr_sha=$(jq -r --arg b "$branch" '(.[$b].sha // "")' <<<"$PR_MAP")
  else
    # A detached checkout has no branch a pull request could name.
    pr_state="NONE"
    pr_sha=""
  fi
  if [[ -n "$branch" && "$ORIGIN_OK" == true ]]; then
    on_origin=false
    [[ "$ORIGIN_HEADS" == *" $branch "* ]] && on_origin=true
  elif [[ -n "$branch" ]]; then
    on_origin=true
  else
    on_origin=false
  fi
  payload=$(jq -nc \
    --arg branch "$branch" --arg branchSha "$sha" \
    --arg prState "$pr_state" --arg prHeadSha "$pr_sha" \
    --argjson localOnlyCommits "$localonly" --argjson dirtyFiles "$dirty" \
    --argjson ignoredFiles "$ignored" \
    --argjson isCurrent "$current" --argjson isProtected "$protected" \
    --argjson recentlyActive "$active" \
    --argjson isDetached "$detached" --argjson existsOnOrigin "$on_origin" \
    --arg worktree "$wt" \
    '$ARGS.named')
  verdict=$("$DECIDE" - <<<"$payload" 2>/dev/null)
  if [[ -z "$verdict" ]]; then
    verdict="KEEP unreadable-payload"
    note "decision script returned nothing for '${branch:-$wt}'"
  fi
  PLAN=$(jq -c --argjson e "$payload" --arg v "$verdict" '. + [$e + {verdict: $v}]' <<<"$PLAN")
}

# -1 means "could not measure", which the gate refuses. Never 0 — that is the
# value that unlocks rule 2.
count_local_only() {
  git rev-list --count "$1" --not --remotes=origin 2>/dev/null || echo -1
}

while IFS= read -r wt; do
  [[ -z "$wt" ]] && continue
  branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
  detached=false
  [[ -z "$branch" ]] && detached=true
  head=$(git -C "$wt" rev-parse HEAD 2>/dev/null || echo "")
  [[ -z "$head" ]] && continue

  if dirty_out=$(git -C "$wt" status --porcelain 2>/dev/null); then
    dirty=$(printf '%s' "$dirty_out" | grep -c . || true)
  else
    dirty=-1
    note "could not read status of $wt"
  fi
  if ignored_out=$(git -C "$wt" status --porcelain --ignored 2>/dev/null); then
    ignored=$(printf '%s\n' "$ignored_out" | awk '/^!! /{print substr($0,4)}' | grep -vEc "$REGENERABLE" || true)
  else
    ignored=-1
  fi

  localonly=$(count_local_only "$head")
  current=false
  [[ "$wt" == "$CURRENT_WT" ]] && current=true
  protected=false
  [[ "$branch" == "$DEFAULT_BRANCH" ]] && protected=true
  [[ "$wt" == "$PRIMARY_WT" ]] && protected=true
  add_entry "$branch" "$head" "$localonly" "$dirty" "$ignored" "$current" "$protected" "$detached" "$wt" "$(is_recently_active "$wt")"
  [[ -n "$branch" ]] && SEEN_BRANCHES="$SEEN_BRANCHES $branch "
done < <(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10)}')

while IFS= read -r branch; do
  [[ -z "$branch" ]] && continue
  [[ "$SEEN_BRANCHES" == *" $branch "* ]] && continue
  head=$(git rev-parse "$branch" 2>/dev/null || echo "")
  [[ -z "$head" ]] && continue
  protected=false
  [[ "$branch" == "$DEFAULT_BRANCH" ]] && protected=true
  # A branch with no worktree has no working tree to be dirty.
  add_entry "$branch" "$head" "$(count_local_only "$branch")" 0 0 false "$protected" false "" false
done < <(git for-each-ref --format='%(refname:short)' refs/heads)

if [[ "$MODE" == json ]]; then
  # Warnings ride inside the document: a consumer capturing stdout would never
  # see them on stderr, and they are exactly the staleness signal it needs.
  jq -n --argjson plan "$PLAN" --argjson warnings "$(printf '%s\n' "${WARNINGS[@]+"${WARNINGS[@]}"}" | jq -R . | jq -s 'map(select(. != ""))')" \
    '{warnings: $warnings, entries: $plan}'
  exit 0
fi

reap_count=$(jq -r '[.[] | select(.verdict == "REAP")] | length' <<<"$PLAN")
keep_count=$(jq -r '[.[] | select(.verdict != "REAP")] | length' <<<"$PLAN")

echo
if [[ "$MODE" == fix ]]; then
  echo "worktree-janitor: removing $reap_count of $((reap_count + keep_count))"
else
  echo "worktree-janitor: $reap_count reapable, $keep_count kept (dry run — pass --fix to act)"
fi
echo

# Two aligned columns, and the verdict word is actually printed — the first
# version built "KEEP " into the string and then sliced it back off, so the word
# the docs told operators to look for never appeared in the output.
jq -r '.[] | select(.verdict != "REAP")
  | [(.verdict | sub("^KEEP ";"")), (if .branch == "" then "(detached) " + .worktree else .branch end)]
  | @tsv' <<<"$PLAN" |
  sort | awk -F'\t' '{printf "  KEEP  %-52s %s\n", $2, $1}'

[[ "$keep_count" -gt 0 ]] && echo

REAP_LOG="${DORK_HOME:-$HOME/.dork}/worktree-janitor.log"
removed=0
failed=0
while IFS=$'\x1f' read -r branch wt sha; do
  [[ -z "$branch$wt" ]] && continue
  label=${branch:-"(detached) $wt"}
  if [[ "$MODE" != fix ]]; then
    printf "  REAP  %-52s %s\n" "$label" "${wt:-branch only}"
    continue
  fi
  ok=true
  # No --force. The gate already refuses a dirty or ignored-content worktree, so
  # git's own refusal is a free second opinion on anything that changed between
  # the plan and this line — and --force is precisely what would suppress it.
  if [[ -n "$wt" ]]; then
    git worktree remove "$wt" >/dev/null 2>&1 || ok=false
  fi
  if [[ "$ok" == true && -n "$branch" ]]; then
    git branch -D "$branch" >/dev/null 2>&1 || ok=false
  fi
  if [[ "$ok" == true ]]; then
    removed=$((removed + 1))
    # `git branch -D` also deletes the ref's reflog, so this line is the only
    # remaining handle on what was deleted. Recovery is `git branch <name> <sha>`
    # while the object survives gc.
    mkdir -p "$(dirname "$REAP_LOG")" 2>/dev/null
    printf '%s\treaped\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sha" "${branch:-(detached)}" "$wt" >>"$REAP_LOG" 2>/dev/null
    printf "  removed  %-50s %s\n" "$label" "$sha"
  else
    failed=$((failed + 1))
    printf "  FAILED   %s\n" "$label"
  fi
done < <(jq -r '.[] | select(.verdict == "REAP") | [.branch, .worktree, .branchSha] | join("\u001f")' <<<"$PLAN")

if [[ "$MODE" == fix ]]; then
  git worktree prune
  echo
  echo "worktree-janitor: removed $removed, failed $failed"
  [[ "$removed" -gt 0 ]] && echo "  recovery log: $REAP_LOG"
  [[ "$failed" -gt 0 ]] && exit 1
fi

exit 0
