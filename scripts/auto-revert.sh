#!/usr/bin/env bash
# auto-revert.sh — should a merge that turned main red be reverted?
#
#   scripts/auto-revert.sh decide <facts.json>
#   scripts/auto-revert.sh facts <run-id>
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
#   skip <reason>         anything else (release or revert commit, red before
#                         this merge, main moved on, no PR, already reverting).
#
# facts.json: {attempt, conclusion, event, branch, sha, subject, pr,
#              parentConclusion, mainHead, revertOpen}
# `facts` builds it from GitHub reads (GH overrides the binary; REPO defaults to
# $GITHUB_REPOSITORY, then dork-labs/dorkos). Reads only.
#
# Exit codes: 0 a decision was printed; 2 usage or unreadable input.
# Fixtures: scripts/test-auto-revert.sh.
set -uo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}

usage() {
  sed -n '4,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
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
    --jq '{attempt: .run_attempt, conclusion, event, branch: .head_branch, sha: .head_sha, wf: .workflow_id}') ||
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
    --arg head "$head" --argjson open "$open" \
    '$r + {subject: $subject, pr: $pr, parentConclusion: $p, mainHead: $head, revertOpen: $open} | del(.wf)'
}

case "${1:-}" in
  decide) [ $# -eq 2 ] || usage; decide "$2" ;;
  facts) [ $# -eq 2 ] && [[ "$2" =~ ^[1-9][0-9]*$ ]] || usage; facts "$2" ;;
  *) usage ;;
esac
