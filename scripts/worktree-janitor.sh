#!/usr/bin/env bash
# Remove the worktrees and local branches that finished work left behind.
#
# This is the driver; scripts/should-reap-worktree.sh is the decision, and every
# refusal it can make is pinned by fixtures. Read that header before changing
# anything here — the safety argument lives there, not in this file.
#
# Scope is deliberately LOCAL ONLY. Branches on origin are handled by GitHub's
# "automatically delete head branches" setting, enabled 2026-08-03; a janitor
# that also pushed deletions would be a second, slower answer to a question the
# platform already answers at merge time. This one cleans the things GitHub
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
# Requires: git, jq, gh (authenticated). Without gh the PR state of every branch
# is UNKNOWN, the gate refuses everything, and you get an honest empty plan
# rather than a permissive one.

set -uo pipefail

MODE=report
for arg in "$@"; do
  case "$arg" in
    --fix) MODE=fix ;;
    --json) MODE=json ;;
    -h | --help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DECIDE="$SCRIPT_DIR/should-reap-worktree.sh"
if [[ ! -x "$DECIDE" ]]; then
  echo "missing or non-executable: $DECIDE" >&2
  exit 2
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$REPO_ROOT" ]]; then
  echo "not inside a git repository" >&2
  exit 2
fi

# The worktree this process is standing in. Never reaped, whatever else is true:
# removing the directory out from under a running shell is how a cleanup run
# takes its own operator down with it.
CURRENT_WT=$(git rev-parse --path-format=absolute --git-common-dir >/dev/null 2>&1 && git rev-parse --show-toplevel)

# Counting local-only commits against a stale remote-tracking state is the one
# way this gate silently gets more permissive, so refresh before counting.
[[ "$MODE" != json ]] && echo "Fetching origin (so local-only counts are honest)..."
git fetch --prune --quiet origin 2>/dev/null || {
  echo "warning: git fetch failed; local-only counts may be stale — refusing to write" >&2
  [[ "$MODE" == fix ]] && exit 2
}

DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}

# The primary worktree — the original clone — is never a candidate. `git worktree
# remove` refuses it anyway, but naming it here keeps the plan honest instead of
# listing something that would fail at --fix time.
PRIMARY_WT=$(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10); exit}')

# Branch names that exist on origin right now. Empty means the lookup failed, and
# add_entry reads that as "assume everything is on origin" — the safe direction.
ORIGIN_HEADS=$(git ls-remote --heads origin 2>/dev/null |
  sed 's|.*refs/heads/||' | tr '\n' ' ' | sed 's/^/ /; s/$/ /')
if [[ -z "${ORIGIN_HEADS// /}" ]]; then
  echo "warning: could not list origin branches — treating every branch as still on origin" >&2
  ORIGIN_HEADS=""
fi

# One GitHub round trip for every PR the repo has ever had, collapsed to the
# best state per branch: MERGED beats OPEN beats CLOSED. A branch reused across
# several PRs would otherwise be judged by whichever record came back first.
PR_MAP=$(gh pr list --state all --limit 1000 --json headRefName,state,headRefOid 2>/dev/null |
  jq -c 'reduce .[] as $p ({};
    ($p.state) as $s
    | (if $s == "MERGED" then 3 elif $s == "OPEN" then 2 else 1 end) as $rank
    | if (.[$p.headRefName] // {rank: 0}).rank < $rank
      then .[$p.headRefName] = {state: $s, sha: $p.headRefOid, rank: $rank}
      else . end)' 2>/dev/null)
if [[ -z "$PR_MAP" ]]; then
  echo "warning: could not read pull requests from GitHub — every branch will be UNKNOWN" >&2
  PR_MAP='{}'
fi

# Build one payload per candidate. Worktrees first (they carry dirty state and
# may be detached), then branches that have no worktree at all.
PLAN='[]'
SEEN_BRANCHES=""

add_entry() {
  local branch=$1 sha=$2 localonly=$3 dirty=$4 current=$5 protected=$6 detached=$7 wt=$8
  local pr_state pr_sha on_origin payload verdict
  if [[ -n "$branch" ]]; then
    pr_state=$(jq -r --arg b "$branch" '(.[$b].state // "NONE")' <<<"$PR_MAP")
    pr_sha=$(jq -r --arg b "$branch" '(.[$b].sha // "")' <<<"$PR_MAP")
    # The conservative value is true, so a failed lookup keeps the branch. Both
    # halves of rule 2 have to be established, not assumed.
    if [[ -n "$ORIGIN_HEADS" ]]; then
      on_origin=false
      [[ "$ORIGIN_HEADS" == *" $branch "* ]] && on_origin=true
    else
      on_origin=true
    fi
  else
    pr_state="NONE"
    pr_sha=""
    on_origin=false
  fi
  payload=$(jq -nc \
    --arg branch "$branch" --arg branchSha "$sha" \
    --arg prState "$pr_state" --arg prHeadSha "$pr_sha" \
    --argjson localOnlyCommits "$localonly" --argjson dirtyFiles "$dirty" \
    --argjson isCurrent "$current" --argjson isProtected "$protected" \
    --argjson isDetached "$detached" --argjson existsOnOrigin "$on_origin" \
    --arg worktree "$wt" \
    '$ARGS.named')
  verdict=$("$DECIDE" - <<<"$payload" 2>/dev/null)
  PLAN=$(jq -c --argjson e "$payload" --arg v "$verdict" '. + [$e + {verdict: $v}]' <<<"$PLAN")
}

while IFS= read -r wt; do
  [[ -z "$wt" ]] && continue
  branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
  detached=false
  [[ -z "$branch" ]] && detached=true
  head=$(git -C "$wt" rev-parse HEAD 2>/dev/null || echo "")
  [[ -z "$head" ]] && continue
  dirty=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  localonly=$(git rev-list --count "$head" --not --remotes=origin 2>/dev/null || echo 0)
  current=false
  [[ "$wt" == "$CURRENT_WT" ]] && current=true
  protected=false
  [[ "$branch" == "$DEFAULT_BRANCH" ]] && protected=true
  [[ "$wt" == "$PRIMARY_WT" ]] && protected=true
  add_entry "$branch" "$head" "$localonly" "$dirty" "$current" "$protected" "$detached" "$wt"
  [[ -n "$branch" ]] && SEEN_BRANCHES="$SEEN_BRANCHES $branch "
done < <(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10)}')

while IFS= read -r branch; do
  [[ -z "$branch" ]] && continue
  [[ "$SEEN_BRANCHES" == *" $branch "* ]] && continue
  head=$(git rev-parse "$branch" 2>/dev/null || echo "")
  [[ -z "$head" ]] && continue
  localonly=$(git rev-list --count "$branch" --not --remotes=origin 2>/dev/null || echo 0)
  protected=false
  [[ "$branch" == "$DEFAULT_BRANCH" ]] && protected=true
  add_entry "$branch" "$head" "$localonly" 0 false "$protected" false ""
done < <(git for-each-ref --format='%(refname:short)' refs/heads)

if [[ "$MODE" == json ]]; then
  jq . <<<"$PLAN"
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

jq -r '.[] | select(.verdict != "REAP")
  | "  KEEP  \(if .branch == "" then "(detached) " + .worktree else .branch end)\t\(.verdict | sub("^KEEP ";""))"' <<<"$PLAN" |
  sort -t$'\t' -k2 | awk -F'\t' '{printf "  %-52s %s\n", substr($1,9), $2}'

[[ "$keep_count" -gt 0 ]] && echo

removed=0
failed=0
# Unit separator, not tab: a branch with no worktree emits an empty middle field,
# and bash collapses runs of *whitespace* IFS characters, so a tab-delimited read
# would slide isDetached into the worktree slot. It did exactly that on the first
# run, printing "false" as a worktree path.
while IFS=$'\x1f' read -r branch wt detached; do
  [[ -z "$branch$wt" ]] && continue
  label=${branch:-"(detached) $wt"}
  if [[ "$MODE" != fix ]]; then
    printf "  REAP  %-52s %s\n" "$label" "${wt:-branch only}"
    continue
  fi
  ok=true
  if [[ -n "$wt" ]]; then
    git worktree remove --force "$wt" >/dev/null 2>&1 || ok=false
  fi
  if [[ "$ok" == true && -n "$branch" ]]; then
    git branch -D "$branch" >/dev/null 2>&1 || ok=false
  fi
  if [[ "$ok" == true ]]; then
    removed=$((removed + 1))
    printf "  removed  %s\n" "$label"
  else
    failed=$((failed + 1))
    printf "  FAILED   %s\n" "$label"
  fi
done < <(jq -r '.[] | select(.verdict == "REAP") | [.branch, .worktree, (.isDetached | tostring)] | join("\u001f")' <<<"$PLAN")

if [[ "$MODE" == fix ]]; then
  git worktree prune
  echo
  echo "worktree-janitor: removed $removed, failed $failed"
  [[ "$failed" -gt 0 ]] && exit 1
fi

exit 0
