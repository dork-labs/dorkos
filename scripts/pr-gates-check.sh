#!/usr/bin/env bash
# pr-gates-check.sh — are the sign-off gates met at this PR's head?
#
#   scripts/pr-gates-check.sh run <pr-number>
#   scripts/pr-gates-check.sh payload <pr-number>
#   scripts/pr-gates-check.sh decide <arm-door verdict line>
#
# The decision behind .github/workflows/pr-gates.yml (DOR-5107's prerequisite,
# under DOR-5098: every merge gate in the cloud, then auto-merge at PR open).
#
# Today arm-door (a `merge_group` workflow) takes a PR back out of the queue when
# its head lacks a sign-off: Security's `security-reviewed` label added at or
# after the head, QA's `qa-real-data` where scripts/qa-real-data.sh asks for it,
# and the designer's `design-ok` where scripts/design-ok.sh asks for it. That
# works only while a person or the local arm script waits for those labels
# before queueing. Once PRs turn on auto-merge when they open, GitHub queues a
# PR the moment its required checks are green, and arm-door would bounce it.
#
# This check asks the same question on the pull request, on every open, push and
# label change, with the same decision code: it builds arm-door's payload and runs
# `scripts/arm-door.sh verdict`. When `pr-gates` is a required check, auto-merge
# simply waits for the sign-offs.
#
# One difference from arm-door: the verify-proof reason (`no-proof`) is dropped.
# The proof arm-door looks for is the other required checks being green, and as
# a required check itself, this one sits beside them. Everything else counts.
#
# Fails closed: any read that fails is exit 2, and so is an `unreadable`
# verdict. (arm-door fails open because it must never jam the queue; a required
# check that cannot decide must not pass.)
#
# Reads only, through `gh api` (GH overrides the binary). REPO defaults to
# $GITHUB_REPOSITORY, then dork-labs/dorkos. Needs scripts/arm-door.sh,
# qa-real-data.sh and design-ok.sh beside it, and ci/required-checks.json
# (REQUIRED_CHECKS overrides the path).
#
# Exit codes: 0 gates met; 1 a gate is missing (the reasons are printed);
# 2 usage, or something could not be read or decided.
# Fixtures: scripts/test-pr-gates-check.sh.
set -uo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REQUIRED_CHECKS=${REQUIRED_CHECKS:-$here/../ci/required-checks.json}

usage() {
  sed -n '4,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
err() {
  echo "pr-gates-check: $*" >&2
  exit 2
}

# What each arm-door reason means, for the person reading a red check.
explain() {
  case "$1" in
    no-security-label) echo "Security has not added security-reviewed to this PR." ;;
    security-label-older-than-head) echo "security-reviewed was added before the latest push; Security re-reviews this head." ;;
    no-qa-label) echo "this PR touches config or migration code and has no qa-real-data label from QA." ;;
    qa-label-older-than-head) echo "qa-real-data was added before the latest push; QA re-checks this head." ;;
    no-design-ok) echo "this PR changes something a person sees and has no design-ok from the designer." ;;
    design-ok-older-than-head) echo "design-ok was added before the latest push; the designer re-checks this head." ;;
    *) echo "$1" ;;
  esac
}

# Security's sign-off may also come from the cloud Security lens (Dorian, Nov 23:
# while local agents are down, the cloud verdict stands in for the label): the
# newest `security-verdict` commit status on the head, posted by GitHub Actions,
# in state `success` (security-verdict.yml, from main's copy). CLOUD_SECURITY=pass
# then drops the two Security-label reasons; QA's and the designer's still count.
cloud_security() { # <payload.json> -> pass | none
  jq -r '[.statuses[] | select(type == "object" and .context == "security-verdict"
            and (.creator.login // "") == "github-actions[bot]")]
         | sort_by(.created_at // "", .id // 0) | last
         | if . != null and .state == "success" then "pass" else "none" end' "$1" 2>/dev/null || echo none
}

decide() {
  local line=$1 reasons r out=()
  case "$line" in
    "KEEP gates-met"*)
      echo "OK: every sign-off gate is met at this head."
      exit 0
      ;;
    "PULL "*)
      reasons=${line#PULL }
      IFS=, read -r -a list <<<"$reasons"
      for r in "${list[@]}"; do
        [ "$r" = no-proof ] && continue
        if [ "${CLOUD_SECURITY:-none}" = pass ]; then
          case "$r" in no-security-label | security-label-older-than-head) continue ;; esac
        fi
        out+=("$r")
      done
      if [ "${#out[@]}" -eq 0 ]; then
        echo "OK: every sign-off gate is met at this head (the other required checks are the proof)."
        exit 0
      fi
      echo "WAIT: a sign-off is missing at this head:" >&2
      for r in "${out[@]}"; do echo "  - $r: $(explain "$r")" >&2; done
      echo "This check re-runs on every label change and push." >&2
      exit 1
      ;;
    "KEEP unreadable "*)
      err "could not decide: ${line#KEEP unreadable } could not be read. Re-run this check."
      ;;
    *) err "unexpected verdict '$line'" ;;
  esac
}

# Prints arm-door's payload for <pr>, built from the same reads as
# .github/workflows/arm-door.yml, but any failed read is exit 2.
payload() {
  local pr=$1 w head committed seen branch
  w=$(mktemp -d) || err "no temp dir"
  trap 'rm -rf "$w"' RETURN
  head=$("$GH" api "repos/$REPO/pulls/$pr" --jq .head.sha) || err "could not read #$pr"
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || err "unexpected head '$head' for #$pr"
  "$GH" api "repos/$REPO/pulls/$pr" --jq '{title, changed_files, branch: .head.ref}' >"$w/pull" ||
    err "could not read #$pr"
  committed=$("$GH" api "repos/$REPO/commits/$head" --jq '.commit.committer.date') ||
    err "could not read the head commit"
  branch=$(jq -r .branch "$w/pull")
  # When this PR last got the head: its latest typecheck.yml pull_request run on
  # the PR's own branch, from this repo (DOR-4706; arm-door.yml has the why).
  "$GH" api --paginate "repos/$REPO/actions/runs?head_sha=$head&event=pull_request&per_page=100" \
    --jq '.workflow_runs[] | "\(.path)\t\(.head_branch)\t\(.head_repository.full_name)\t\(.created_at)"' \
    >"$w/runs-by-branch" || err "could not read the head's workflow runs"
  seen=$(awk -F'\t' -v b="$branch" -v r="$REPO" \
    '$1==".github/workflows/typecheck.yml" && $2==b && $3==r && $4!="" {print $4}' "$w/runs-by-branch" |
    sort | tail -1)
  "$GH" api --paginate "repos/$REPO/commits/$head/statuses?per_page=100" --jq '.[] | tojson' >"$w/statuses" ||
    err "could not read the head's statuses"
  "$GH" api --paginate "repos/$REPO/commits/$head/check-runs?per_page=100" --jq '.check_runs[] | tojson' >"$w/runs" ||
    err "could not read the head's check runs"
  "$GH" api --paginate "repos/$REPO/issues/$pr/events?per_page=100" \
    --jq '.[] | select(.event == "labeled") | {name: .label.name, at: .created_at} | tojson' >"$w/events" ||
    err "could not read #$pr's label events"
  "$GH" api --paginate "repos/$REPO/issues/$pr/labels?per_page=100" --jq '.[].name | tojson' >"$w/labels" ||
    err "could not read #$pr's labels"
  "$GH" api --paginate "repos/$REPO/pulls/$pr/files?per_page=100" \
    --jq '.[] | {filename, previous_filename, status, additions, deletions, patch} | tojson' >"$w/files" ||
    err "could not read #$pr's files"
  local pjq
  pjq=$(bash "$here/qa-real-data.sh" patches-jq) || err "could not load qa-real-data.sh's patch filter"
  jq -r -s "$pjq" "$w/files" >"$w/patches" || err "could not build the patch text"
  jq -c '.contexts // null' "$REQUIRED_CHECKS" >"$w/required" || err "could not read $REQUIRED_CHECKS"

  jq -n --arg head "$head" --arg committed "$committed" --arg seen "$seen" \
    --slurpfile pull "$w/pull" --slurpfile statuses "$w/statuses" --slurpfile runs "$w/runs" \
    --slurpfile events "$w/events" --slurpfile labels "$w/labels" --slurpfile files "$w/files" \
    --rawfile patches "$w/patches" --slurpfile required "$w/required" '
    {head: $head, headCommittedAt: $committed,
     headSeenAt: (if $seen == "" then null else $seen end),
     labelEvents: [$events[] | select(.name == "security-reviewed") | .at],
     qaLabelEvents: [$events[] | select(.name == "qa-real-data") | .at],
     designLabelEvents: [$events[] | select(.name == "design-ok") | .at],
     statuses: $statuses, checkRuns: $runs, required: $required[0],
     files: [$files[] | {filename, previous_filename}], changedFiles: $pull[0].changed_files,
     labels: $labels, patches: $patches, title: $pull[0].title}' || err "could not build the payload"
}

mode=${1:-}
case "$mode" in
  payload)
    [ $# -eq 2 ] && [[ "$2" =~ ^[1-9][0-9]*$ ]] || usage
    payload "$2"
    ;;
  decide)
    [ $# -eq 2 ] || usage
    decide "$2"
    ;;
  run)
    [ $# -eq 2 ] && [[ "$2" =~ ^[1-9][0-9]*$ ]] || usage
    tmp=$(mktemp -d) || err "no temp dir"
    trap 'rm -rf "$tmp"' EXIT
    payload "$2" >"$tmp/payload.json" || exit 2
    line=$(bash "$here/arm-door.sh" verdict "$tmp/payload.json" | head -n 1)
    echo "arm-door verdict for #$2: ${line:-<none>}"
    CLOUD_SECURITY=$(cloud_security "$tmp/payload.json")
    [ "$CLOUD_SECURITY" = pass ] && echo "The cloud Security lens passed this head (security-verdict), which counts as Security's sign-off."
    export CLOUD_SECURITY
    decide "$line"
    ;;
  *) usage ;;
esac
