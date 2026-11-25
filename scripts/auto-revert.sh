#!/usr/bin/env bash
# auto-revert.sh — should a merge that turned main red be reverted?
#
#   scripts/auto-revert.sh decide <facts.json>
#   scripts/auto-revert.sh facts <run-id>
#   scripts/auto-revert.sh revert <sha> <pr> <workflow-name> <run-url>
#
# DOR-5122, under DOR-5098 (Dorian, Nov 23: release fast, fix forward; a bot
# may revert a merge that turns main red, never the release commit). The
# decision behind .github/workflows/auto-revert.yml.
#
# `decide` prints one line:
#   rerun                 first failure of this run: re-run the failed jobs once,
#                         so a flake never reverts anyone's work;
#   revert <sha> <pr>     it failed again, and the same workflow was green on the
#                         parent commit, so this merge broke it;
#   skip <reason>         anything else (a rolling workflow, release or revert
#                         commit, red before this merge, main moved on, no PR,
#                         already reverting).
#
# THE ORDER. A failed push run on main is checked, in order:
#   1. a push to main, a failure, a real sha; else skip.
#   2. a ROLLING workflow (ROLLING_WORKFLOWS below): skip rolling, at any
#      attempt. rolling-bisect.yml owns it from its first failure.
#   3. release commit, revert commit, no merged PR: skip.
#   4. parent not green (failure, or no run of its own): skip.
#   5. attempt 1: rerun.
#   6. revert already open, main moved on: skip; else revert.
#
# WHY ROLLING RUNS ARE NEVER RE-RUN HERE (Nov 25). One rolling run covers
# several merges, so its head commit's parent rule says nothing (its parent
# almost never has a run of its own: at 7878dda step 4 answered
# `red-before-this-merge`, nothing was re-run, and the bisect, which then
# waited for attempt 2, never started). Re-running it is no fix either: a
# re-run of an old push run joins browser-test's `gate` concurrency group
# (same event and ref as a new push run), where it would cancel the pending
# newest-main run or be cancelled by the next merge. So rolling-bisect.yml
# starts on the first failure and re-tests the failing head itself in a
# dispatched bisect run, which has a concurrency group of its own.
#
# ROLLING_WORKFLOWS must match rolling-bisect.yml's `workflows:` and be the
# workflows after-merge-alert.yml sets ROLLING=1 for. test-auto-revert.sh reads
# both files and fails on any drift.
#
# facts.json: {attempt, conclusion, event, branch, sha, subject, pr,
#              parentConclusion, mainHead, revertOpen, workflow, rolling}
# `facts` builds it from GitHub reads (GH overrides the binary; REPO defaults to
# $GITHUB_REPOSITORY, then dork-labs/dorkos). Reads only.
#
# `revert` is the one revert path, for auto-revert.yml and rolling-bisect.yml
# (whose culprit is a merge main has moved past: ANYWHERE=1). Run in a checkout
# of main whose origin push credential starts workflows (the merge-tail app
# token), with GH_TOKEN set. It opens `auto-revert/<sha12>` as a revert PR with
# auto-merge on and tells the PR's author. It refuses the release commit, a sha
# that is not on main, a revert that is already open or pushed, and, without
# ANYWHERE=1, a sha main has moved past. A revert that does not apply cleanly
# is aborted, never resolved by hand.
#
# Exit codes: 0 a decision was printed, or the revert was opened or not needed;
# 1 the revert could not be made; 2 usage or unreadable input.
# Fixtures: scripts/test-auto-revert.sh.
set -uo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
# Workflow names whose push run on main is rolling (one run for several
# merges), as a JSON array: never re-run or reverted from here. Kept equal to
# rolling-bisect.yml's `workflows:` by scripts/test-auto-revert.sh.
ROLLING_WORKFLOWS='["browser-test"]'

usage() {
  sed -n '4,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
err() {
  echo "auto-revert: $*" >&2
  exit 2
}

decide() {
  local f=$1
  jq -e 'type == "object"' "$f" >/dev/null 2>&1 || err "unreadable facts: $f"
  jq -r '
    def skip(r): "skip " + r;
    if .event != "push" or .branch != "main" then skip("not-a-push-to-main")
    elif (.conclusion != "failure" and .conclusion != "timed_out") then skip("not-a-failure")
    elif ((.sha // "") | test("^[0-9a-f]{40}$") | not) then skip("bad-sha")
    elif .rolling == true then skip("rolling")
    elif ((.subject // "") | test("^chore\\(release\\)"; "i")) then skip("release-commit")
    elif ((.subject // "") | test("^(revert|Revert)\\b")) then skip("revert-commit")
    elif ((.pr // 0) | type != "number" or . < 1) then skip("no-merged-pr")
    elif .parentConclusion != "success" then skip("red-before-this-merge")
    elif (.attempt // 1) < 2 then "rerun"
    elif .revertOpen == true then skip("revert-already-open")
    elif .mainHead != .sha then skip("main-moved-on")
    else "revert \(.sha) \(.pr)"
    end' "$f" || err "could not decide"
}

facts() {
  local run=$1 r sha wfid parent subject pr pconc head open
  r=$("$GH" api "repos/$REPO/actions/runs/$run" \
    --jq '{attempt: .run_attempt, conclusion, event, branch: .head_branch, sha: .head_sha, wf: .workflow_id, workflow: .name}') ||
    err "could not read run $run"
  sha=$(jq -r .sha <<<"$r")
  wfid=$(jq -r .wf <<<"$r")
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || err "unexpected sha in run $run"
  local line
  line=$("$GH" api "repos/$REPO/commits/$sha" \
    --jq '"\(.parents[0].sha) \(.commit.message | split("\n")[0])"') || err "could not read ${sha:0:7}"
  read -r parent subject <<<"$line"
  [ -n "${parent:-}" ] || err "could not read ${sha:0:7}"
  pr=$("$GH" api "repos/$REPO/commits/$sha/pulls" \
    --jq '[.[] | select(.merged_at != null)] | first | .number // 0') || err "could not read the PR behind ${sha:0:7}"
  # The parent's own push run of this workflow (newest attempt wins).
  pconc=$("$GH" api "repos/$REPO/actions/workflows/$wfid/runs?head_sha=$parent&event=push&per_page=10" \
    --jq '[.workflow_runs[] | select(.status == "completed")] | sort_by(.updated_at) | last | .conclusion // "none"') ||
    err "could not read the parent's runs"
  head=$("$GH" api "repos/$REPO/commits/main" --jq .sha) || err "could not read main"
  open=$("$GH" api "repos/$REPO/pulls?state=open&head=${REPO%%/*}:auto-revert/${sha:0:12}" --jq 'length > 0') ||
    err "could not read open PRs"
  jq -n --argjson r "$r" --arg subject "$subject" --argjson pr "${pr:-0}" --arg p "$pconc" \
    --arg head "$head" --argjson open "$open" --argjson rolling "$ROLLING_WORKFLOWS" \
    '$r + {subject: $subject, pr: $pr, parentConclusion: $p, mainHead: $head, revertOpen: $open,
      rolling: ($rolling | index($r.workflow) != null)} | del(.wf)'
}

revert() {
  local sha=$1 pr=$2 wf=$3 url=$4 branch subject author title body prurl
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] && [[ "$pr" =~ ^[1-9][0-9]*$ ]] && [ -n "$wf" ] && [ -n "$url" ] || usage
  branch="auto-revert/${sha:0:12}"
  git cat-file -e "$sha^{commit}" 2>/dev/null || { echo "::error::${sha:0:7} is not in this checkout"; return 1; }
  git merge-base --is-ancestor "$sha" HEAD || { echo "::error::${sha:0:7} is not on main"; return 1; }
  if [ "${ANYWHERE:-}" != 1 ] && [ "$(git rev-parse HEAD)" != "$sha" ]; then
    echo "::notice::main moved on; not reverting."
    return 0
  fi
  subject=$(git log -1 --format=%s "$sha")
  if [[ "$subject" =~ ^[Cc][Hh][Oo][Rr][Ee]\([Rr][Ee][Ll][Ee][Aa][Ss][Ee]\) ]]; then
    echo "::notice::${sha:0:7} is the release commit; never reverted."
    return 0
  fi
  if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    echo "::notice::$branch already exists; not reverting twice."
    return 0
  fi
  git config user.name "github-actions[bot]"
  git config user.email "github-actions[bot]@users.noreply.github.com"
  git switch -q -c "$branch" || return 1
  if ! git revert --no-edit "$sha" >/dev/null; then
    git revert --abort 2>/dev/null
    echo "::error::reverting ${sha:0:7} does not apply cleanly on main; not reverting."
    return 1
  fi
  git push -q origin "$branch" || return 1
  author=$("$GH" api "repos/$REPO/pulls/$pr" --jq .user.login) || return 1
  title="Revert #$pr: $wf failed on main (auto-revert)"
  if [ "${ANYWHERE:-}" = 1 ]; then
    body="Auto-revert (DOR-5122): \`$wf\` failed on main in a rolling run, and a bisect found #$pr as the first merge it fails on (it failed twice there; the merge before it passed)."
  else
    body="Auto-revert (DOR-5122): \`$wf\` failed twice on main after #$pr merged, and was green on the commit before it."
  fi
  body="$body

Run: $url

@$author please fix forward: reopen the change in a new PR with the fix."
  prurl=$("$GH" pr create --repo "$REPO" --base main --head "$branch" --title "$title" \
    --body "$body" --label skip-changelog --label auto-revert) || return 1
  echo "Opened $prurl"
  "$GH" pr merge "$prurl" --repo "$REPO" --auto || echo "::warning::could not turn on auto-merge for $prurl"
  "$GH" api --method POST "repos/$REPO/issues/$pr/comments" \
    -f body="@$author this PR turned main red (\`$wf\`, $url) and is being reverted in $prurl. Please fix forward in a new PR." >/dev/null ||
    echo "::warning::could not comment on #$pr"
}

case "${1:-}" in
  decide) [ $# -eq 2 ] || usage; decide "$2" ;;
  facts) [ $# -eq 2 ] && [[ "$2" =~ ^[1-9][0-9]*$ ]] || usage; facts "$2" ;;
  revert) [ $# -eq 5 ] || usage; revert "$2" "$3" "$4" "$5" ;;
  *) usage ;;
esac
