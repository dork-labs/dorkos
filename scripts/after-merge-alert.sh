#!/usr/bin/env bash
# after-merge-alert.sh — tell the author when a check fails after their merge.
#
#   scripts/after-merge-alert.sh failed <run-id> <head-sha> <workflow-name> <run-url>
#   scripts/after-merge-alert.sh passed <workflow-name> <run-url>
#
# DOR-5121, under DOR-5098 (Dorian, Nov 23: release fast, fix forward). Checks
# that rarely catch real failures run after merge, on `push` to main. When one
# fails, the author must hear about it without anyone watching main:
#
#   failed: finds the merged PR behind <head-sha>, comments on it once per run
#           (check, failed jobs, run link), and opens or updates ONE issue per
#           failure group (workflow + failed job), labelled after-merge-failure
#           and assigned to the author when GitHub allows it.
#   passed: the workflow is green on main again, so its open groups are closed
#           with a comment naming the run.
#
# The room ping comes from the red-main alarm, which reads main's runs.
#
# ROLLING=1 (DOR-5130) is for a workflow that runs once for several merges (the
# full browser suite on main: one run in flight, the newest main next). Its
# failure may belong to any merge since its previous push run, so the issue
# lists every merged PR in that range, and the PR comment goes out only when
# the range is a single PR. An unreadable range lists nobody and says so.
#
# Text written here is public: only workflow names, job names, run links and the
# author's handle. Never a log line.
#
# GH overrides the gh binary. REPO defaults to $GITHUB_REPOSITORY, then
# dork-labs/dorkos. Writes only issue comments, issues and the label.
# Exit codes: 0 done (including nothing to do); 2 usage or a failed GitHub call.
# Fixtures: scripts/test-after-merge-alert.sh.
set -uo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
LABEL=after-merge-failure
MAX_GROUPS=5

usage() {
  sed -n '4,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
err() {
  echo "after-merge-alert: $*" >&2
  exit 2
}

title_for() { printf 'After merge: %s / %s fails on main' "$1" "$2"; }

# Number of the open group issue with exactly this title, or empty.
find_issue() {
  "$GH" api --paginate "repos/$REPO/issues?state=open&labels=$LABEL&per_page=100" \
    --jq ".[] | select(.pull_request == null and .title == $(jq -Rn --arg t "$1" '$t')) | .number" |
    head -n 1
}

ensure_label() {
  "$GH" api "repos/$REPO/labels/$LABEL" >/dev/null 2>&1 && return 0
  "$GH" api --method POST "repos/$REPO/labels" -f name="$LABEL" -f color=d93f0b \
    -f description="A check failed on main after merge (DOR-5121)" >/dev/null 2>&1 || true
}

failed() {
  local run=$1 sha=$2 wf=$3 url=$4 pr author jobs marker existing body title n job
  [[ "$run" =~ ^[1-9][0-9]*$ ]] && [[ "$sha" =~ ^[0-9a-f]{40}$ ]] && [ -n "$wf" ] && [ -n "$url" ] || usage

  local line
  line=$("$GH" api "repos/$REPO/commits/$sha/pulls" \
    --jq '[.[] | select(.merged_at != null)] | first | if . == null then "" else "\(.number) \(.user.login)" end') ||
    err "could not read the PR behind ${sha:0:7}"
  read -r pr author <<<"$line"
  local range_note=""
  if [ "${ROLLING:-}" = 1 ]; then
    local meta wfid created prev prs count
    meta=$("$GH" api "repos/$REPO/actions/runs/$run" --jq '"\(.workflow_id) \(.created_at)"' 2>/dev/null) || meta=
    read -r wfid created <<<"$meta"
    prev=
    if [[ "${wfid:-}" =~ ^[0-9]+$ ]] && [ -n "${created:-}" ]; then
      prev=$("$GH" api "repos/$REPO/actions/workflows/$wfid/runs?branch=main&event=push&status=completed&per_page=30" \
        --jq "[.workflow_runs[] | select(.id != $run and .head_sha != \"$sha\" and .created_at < \"$created\")] | sort_by(.created_at) | last | .head_sha // empty" 2>/dev/null) || prev=
    fi
    prs=
    if [[ "$prev" =~ ^[0-9a-f]{40}$ ]]; then
      local c
      for c in $("$GH" api "repos/$REPO/compare/$prev...$sha" --jq '.commits[].sha' 2>/dev/null); do
        prs+=$("$GH" api "repos/$REPO/commits/$c/pulls" \
          --jq '[.[] | select(.merged_at != null)] | first | if . == null then "" else "#\(.number) (\(.user.login))" end' 2>/dev/null)$'\n'
      done
    fi
    prs=$(grep -v '^$' <<<"$prs" | sort -u)
    count=$(grep -c . <<<"$prs" || true)
    if [ "$count" -gt 1 ]; then
      range_note="This run covers $count merges since the previous full run (${prev:0:7}..${sha:0:7}): $(paste -sd, - <<<"$prs" | sed 's/,/, /g'). Any of them may have caused it."
      pr=
      author=
    elif [ "$count" -eq 0 ]; then
      range_note="Could not list the merges since the previous full run, so no author was named."
      pr=
      author=
    fi
  fi
  jobs=$("$GH" api --paginate "repos/$REPO/actions/runs/$run/jobs?per_page=100" \
    --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | .name') ||
    err "could not read the jobs of run $run"
  [ -n "$jobs" ] || jobs=$wf
  jobs=$(head -n "$MAX_GROUPS" <<<"$jobs")

  if [[ "${pr:-}" =~ ^[1-9][0-9]*$ ]]; then
    marker="<!-- after-merge-alert run=$run -->"
    existing=$("$GH" api --paginate "repos/$REPO/issues/$pr/comments?per_page=100" \
      --jq ".[] | select(.body | contains($(jq -Rn --arg m "$marker" '$m'))) | .id") ||
      err "could not read the comments of #$pr"
    if [ -z "$existing" ]; then
      body="$marker
@$author \`$wf\` failed on main after this PR merged (${sha:0:7}): $url

Failed: $(paste -sd, - <<<"$jobs" | sed 's/,/, /g').

Please fix forward with a new PR. If main is red, an auto-revert may follow."
      "$GH" api --method POST "repos/$REPO/issues/$pr/comments" -f body="$body" >/dev/null ||
        err "could not comment on #$pr"
      echo "Commented on #$pr."
    else
      echo "#$pr already has the alert for run $run."
    fi
  else
    if [ -n "$range_note" ]; then
      echo "Rolling run, no single PR to comment on. $range_note"
    else
      echo "No merged PR behind ${sha:0:7}; no PR comment."
    fi
    author=
  fi

  ensure_label
  while IFS= read -r job; do
    [ -n "$job" ] || continue
    title=$(title_for "$wf" "$job")
    n=$(find_issue "$title") || err "could not list the open $LABEL issues"
    if [ -n "$n" ]; then
      "$GH" api --method POST "repos/$REPO/issues/$n/comments" \
        -f body="Failed again at ${sha:0:7}${pr:+ (after #$pr)}: $url${range_note:+ $range_note}" >/dev/null ||
        err "could not update #$n"
      echo "Updated #$n: $title"
    else
      body="\`$wf\` / \`$job\` failed on main at ${sha:0:7}${pr:+, after #$pr by @$author}.

Run: $url
${range_note:+
$range_note
}
One issue per failure group (DOR-5121). It closes itself when \`$wf\` is green on main again."
      local args=(-f title="$title" -f body="$body" -f "labels[]=$LABEL")
      [ -n "${author:-}" ] && [[ "$author" != *"[bot]" ]] && args+=(-f "assignees[]=$author")
      if ! n=$("$GH" api --method POST "repos/$REPO/issues" "${args[@]}" --jq .number 2>/dev/null); then
        # An author GitHub can't assign must not lose the alert.
        n=$("$GH" api --method POST "repos/$REPO/issues" -f title="$title" -f body="$body" \
          -f "labels[]=$LABEL" --jq .number) || err "could not open an issue for $title"
      fi
      echo "Opened #$n: $title"
    fi
  done <<<"$jobs"
}

passed() {
  local wf=$1 url=$2 prefix nums n
  [ -n "$wf" ] && [ -n "$url" ] || usage
  prefix="After merge: $wf / "
  nums=$("$GH" api --paginate "repos/$REPO/issues?state=open&labels=$LABEL&per_page=100" \
    --jq ".[] | select(.pull_request == null and (.title | startswith($(jq -Rn --arg p "$prefix" '$p')))) | .number") ||
    err "could not list the open $LABEL issues"
  for n in $nums; do
    "$GH" api --method POST "repos/$REPO/issues/$n/comments" -f body="Green on main again: $url" >/dev/null ||
      err "could not comment on #$n"
    "$GH" api --method PATCH "repos/$REPO/issues/$n" -f state=closed -f state_reason=completed >/dev/null ||
      err "could not close #$n"
    echo "Closed #$n."
  done
  [ -n "$nums" ] || echo "No open $LABEL issues for $wf."
}

case "${1:-}" in
  failed) [ $# -eq 5 ] || usage; failed "$2" "$3" "$4" "$5" ;;
  passed) [ $# -eq 3 ] || usage; passed "$2" "$3" ;;
  *) usage ;;
esac
