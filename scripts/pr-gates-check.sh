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
# Three differences from arm-door:
#   - The verify-proof reason (`no-proof`) is dropped. The proof arm-door looks
#     for is the other required checks being green, and as a required check
#     itself, this one sits beside them.
#   - Only Security's sign-off counts (DOR-5119, Dorian, Nov 23: release fast,
#     fix forward). No local agent reviews an open PR, so QA's `qa-real-data`
#     and the designer's `design-ok` are no longer merge gates: QA and the
#     designer sweep each day's merges instead (DOR-5120). Their reasons are
#     still printed, as a note, so the sweep can see what it will pick up.
#   - Security's sign-off is a signed review marker or the cloud verdict, never
#     a label. arm-door is shown no `security-reviewed` label events, and the
#     check asks for one of:
#       - a PR comment carrying Security's signed review marker for this PR's
#         own repo, number and current head, whose SSH signature verifies
#         against main's ci/security/allowed_signers (ALLOWED_SIGNERS gives the
#         path; pr-gates.yml passes main's copy, never the PR's):
#           <!-- dorkos-security-review v1 repo=<owner/name> pr=<n> head=<sha> verdict=pass
#           -----BEGIN SSH SIGNATURE-----
#           ...
#           -----END SSH SIGNATURE-----
#           -->
#         The signed text is the marker's first line without `<!-- `, and no
#         newline. The text is rebuilt from this PR's own values, then:
#           printf '%s' "$text" | ssh-keygen -Y verify -f <allowed_signers> \
#             -I security@dorkos -n dorkos-security-review -s <sig>
#         The newest marker comment for the head decides; who posted it does
#         not matter, the signature is the proof. With no key line on main, no
#         signature counts.
#       - the cloud Security lens's passing `security-verdict` status (below).
#     A `security-reviewed` label with neither is printed as a note.
#
# Fails closed: any read that fails is exit 2, and so is an `unreadable`
# verdict. (arm-door fails open because it must never jam the queue; a required
# check that cannot decide must not pass.)
#
# Reads only, through `gh api` (GH overrides the binary). REPO defaults to
# $GITHUB_REPOSITORY, then dork-labs/dorkos. Needs scripts/arm-door.sh,
# qa-real-data.sh and design-ok.sh beside it, ci/required-checks.json
# (REQUIRED_CHECKS overrides the path), and ssh-keygen when a marker is found.
#
# Exit codes: 0 gates met; 1 a gate is missing (the reasons are printed);
# 2 usage, or something could not be read or decided.
# Fixtures: scripts/test-pr-gates-check.sh.
set -uo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REQUIRED_CHECKS=${REQUIRED_CHECKS:-$here/../ci/required-checks.json}
ALLOWED_SIGNERS=${ALLOWED_SIGNERS:-$here/../ci/security/allowed_signers}
SIG_NAMESPACE=dorkos-security-review
SIG_PRINCIPAL=security@dorkos

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
    no-security-signoff) echo "Security has not signed off at this head: no signed review marker that verifies against main's key, and no passing cloud security-verdict." ;;
    no-qa-label) echo "this PR touches config or migration code and has no qa-real-data label from QA." ;;
    qa-label-older-than-head) echo "qa-real-data was added before the latest push; QA re-checks this head." ;;
    no-design-ok) echo "this PR changes something a person sees and has no design-ok from the designer." ;;
    design-ok-older-than-head) echo "design-ok was added before the latest push; the designer re-checks this head." ;;
    *) echo "$1" ;;
  esac
}

# Security's sign-off may come from the cloud Security lens (Dorian, Nov 23):
# the newest `security-verdict` commit status on the head, posted by GitHub
# Actions, in state `success` (security-verdict.yml, from main's copy).
cloud_security() { # <payload.json> -> pass | none
  jq -r '[.statuses[] | select(type == "object" and .context == "security-verdict"
            and (.creator.login // "") == "github-actions[bot]")]
         | sort_by(.created_at // "", .id // 0) | last
         | if . != null and .state == "success" then "pass" else "none" end' "$1" 2>/dev/null || echo none
}

# SECURITY_SIGNOFF (signed | cloud | none) says whether Security signed off at
# the head; anything else is none. arm-door's own Security-label reasons never
# count either way.
decide() {
  local line=$1 reasons="" r out=() later=() list=()
  case "$line" in
    "KEEP gates-met"*) ;;
    "PULL "*) reasons=${line#PULL } ;;
    "KEEP unreadable "*)
      err "could not decide: ${line#KEEP unreadable } could not be read. Re-run this check."
      ;;
    *) err "unexpected verdict '$line'" ;;
  esac
  case "${SECURITY_SIGNOFF:-none}" in
    signed | cloud) ;;
    *) out+=(no-security-signoff) ;;
  esac
  [ -n "$reasons" ] && IFS=, read -r -a list <<<"$reasons"
  for r in ${list[@]+"${list[@]}"}; do
    case "$r" in
      no-proof | no-security-label | security-label-older-than-head) continue ;;
      no-qa-label | qa-label-older-than-head | no-design-ok | design-ok-older-than-head)
        later+=("$r")
        continue
        ;;
    esac
    out+=("$r")
  done
  for r in ${later[@]+"${later[@]}"}; do
    echo "Note (not a merge gate; the daily sweep picks it up): $r: $(explain "$r")"
  done
  if [ "${#out[@]}" -eq 0 ]; then
    echo "OK: every sign-off gate is met at this head (the other required checks are the proof)."
    exit 0
  fi
  echo "WAIT: a sign-off is missing at this head:" >&2
  for r in "${out[@]}"; do echo "  - $r: $(explain "$r")" >&2; done
  echo "This check re-runs on every label change and push." >&2
  exit 1
}

# Security's signed review marker. The marker's first line, then the armor, then
# `-->`; bodies over 16 KiB are skipped. Fields are matched by exact patterns and
# the signature is only ever written to a file for ssh-keygen.
MARKER_LINE='(^|\n)<!-- dorkos-security-review v1 repo=(?<repo>[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}) pr=(?<pr>[0-9]{1,10}) head=(?<head>[0-9a-f]{40}) verdict=(?<verdict>[a-z]{1,16})\r?\n'
MARKER_ARMOR='(?<sig>-----BEGIN SSH SIGNATURE-----\r?\n(?:[A-Za-z0-9+/=]{1,100}\r?\n){1,40}-----END SSH SIGNATURE-----)\r?\n-->'

# signed_review <pr> <head> <workdir>: sets SIGNED (pass | none | bad) and
# SIGNED_WHY. A failed read is exit 2.
signed_review() {
  local pr=$1 head=$2 w=$3 sel repo mpr mhead verdict sig id line text
  SIGNED=none SIGNED_WHY="no signed review marker for this head"
  "$GH" api --paginate "repos/$REPO/issues/$pr/comments?per_page=100" \
    --jq '.[] | {id, created_at, body} | tojson' >"$w/comments" || err "could not read #$pr's comments"
  sel=$(jq -c -s --arg head "$head" --arg line "$MARKER_LINE" --arg armor "$MARKER_ARMOR" '
    [ .[] | select(type == "object" and (.body | type) == "string" and (.body | length) <= 16384)
      | . as $c
      | ([$c.body | capture($line)] | .[0]) as $m
      | select($m != null and $m.head == $head)
      | ([$c.body | capture($line + $armor)] | .[0]) as $a
      | {id: ($c.id // 0), at: ($c.created_at // ""), repo: $m.repo, pr: $m.pr, head: $m.head,
         verdict: $m.verdict,
         sig: (if $a != null and ([$a.repo, $a.pr, $a.head, $a.verdict] == [$m.repo, $m.pr, $m.head, $m.verdict])
               then ($a.sig | gsub("\r"; "")) else null end)} ]
    | sort_by(.at, .id) | last' "$w/comments") || err "could not read #$pr's comments"
  [ -n "$sel" ] && [ "$sel" != null ] || return 0
  id=$(jq -r '.id' <<<"$sel")
  repo=$(jq -r '.repo' <<<"$sel")
  mpr=$(jq -r '.pr' <<<"$sel")
  mhead=$(jq -r '.head' <<<"$sel")
  verdict=$(jq -r '.verdict' <<<"$sel")
  sig=$(jq -r '.sig // ""' <<<"$sel")
  SIGNED=bad
  [[ "$id" =~ ^[0-9]{1,20}$ ]] || id="?"
  if [ "$repo" != "$REPO" ] || [ "$mpr" != "$pr" ] || [ "$mhead" != "$head" ]; then
    SIGNED_WHY="the newest marker for this head (comment $id) names another repo or PR"
    return 0
  fi
  if [ "$verdict" != pass ]; then
    SIGNED_WHY="the newest marker for this head (comment $id) is not a pass"
    return 0
  fi
  if [ -z "$sig" ]; then
    SIGNED_WHY="the newest marker for this head (comment $id) has no well-formed SSH signature"
    return 0
  fi
  while IFS= read -r line; do
    [[ "$line" =~ ^(-----(BEGIN|END)\ SSH\ SIGNATURE-----|[A-Za-z0-9+/=]{1,100})$ ]] || {
      SIGNED_WHY="the newest marker for this head (comment $id) has no well-formed SSH signature"
      return 0
    }
  done <<<"$sig"
  if ! [ -f "$ALLOWED_SIGNERS" ] || ! grep -qvE '^[[:space:]]*(#|$)' "$ALLOWED_SIGNERS"; then
    SIGNED_WHY="main has no Security key in ci/security/allowed_signers, so no signature counts yet"
    return 0
  fi
  command -v ssh-keygen >/dev/null 2>&1 || err "ssh-keygen is not installed"
  printf '%s\n' "$sig" >"$w/review.sig"
  text="dorkos-security-review v1 repo=$REPO pr=$pr head=$head verdict=pass"
  if printf '%s' "$text" | ssh-keygen -Y verify -f "$ALLOWED_SIGNERS" -I "$SIG_PRINCIPAL" \
    -n "$SIG_NAMESPACE" -s "$w/review.sig" >"$w/verify.out" 2>&1; then
    SIGNED=pass SIGNED_WHY="comment $id"
  else
    SIGNED_WHY="the newest marker for this head (comment $id) does not verify against main's key"
  fi
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
    # A label proves nothing (every agent acts as one login): arm-door sees none.
    jq '.labelEvents = []' "$tmp/payload.json" >"$tmp/door.json" || err "could not build the payload"
    line=$(bash "$here/arm-door.sh" verdict "$tmp/door.json" | head -n 1)
    echo "arm-door verdict for #$2: ${line:-<none>}"
    head=$(jq -r .head "$tmp/payload.json")
    signed_review "$2" "$head" "$tmp"
    SECURITY_SIGNOFF=none
    if [ "$SIGNED" = pass ]; then
      SECURITY_SIGNOFF=signed
      echo "Security's signed review for this head verifies against main's key ($SIGNED_WHY), which counts as Security's sign-off."
    elif [ "$SIGNED" = bad ]; then
      echo "Signed review not counted: $SIGNED_WHY."
    fi
    if [ "$(cloud_security "$tmp/payload.json")" = pass ]; then
      [ "$SECURITY_SIGNOFF" = none ] && SECURITY_SIGNOFF=cloud
      echo "The cloud Security lens passed this head (security-verdict), which counts as Security's sign-off."
    fi
    if [ "$SIGNED" != pass ] && jq -e '.labels | any(. == "security-reviewed")' "$tmp/payload.json" >/dev/null 2>&1; then
      echo "Note: the security-reviewed label is on this PR, but a label alone is not Security's sign-off. Security signs off with a signed review marker in a comment (or the cloud verdict passes)."
    fi
    export SECURITY_SIGNOFF
    decide "$line"
    ;;
  *) usage ;;
esac
