#!/usr/bin/env bash
# release-window-check.sh — may this PR merge now, given freezes and releases?
#
#   scripts/release-window-check.sh pr <pr-number>
#   scripts/release-window-check.sh group <pr-number> <base-sha> <head-sha>
#   scripts/release-window-check.sh open
#   scripts/release-window-check.sh rerun-list <runs.json> <open-heads.txt>
#
# --help
# Purpose: may this PR merge now, given a merge freeze and an unreleased version?
# Runs in: the required `release-window` check, and release-window-refresh.yml.
# To fix:  nothing on your PR: wait for the freeze to lift or the release to
#          reach npm. It re-runs by itself. The WAIT line says which.
# Usage:   scripts/release-window-check.sh pr <pr> | group <pr> <base> <head> | open
#          scripts/release-window-check.sh rerun-list <runs.json> <open-heads.txt>
# --help end
#
# The decision behind .github/workflows/release-window.yml (DOR-5102, under
# DOR-5098: every merge gate in the cloud, then auto-merge at PR open). Until
# now these rules lived only in the local arm script (.temp/coord/arm.sh), so
# they held only while one laptop armed every PR. As a required check, GitHub
# enforces them whoever or whatever turns on auto-merge.
#
# THE RULES
#   1. Freeze. While the repository variable MERGE_FREEZE is set, only the PR
#      it names may merge. Format: "<pr-number> <reason>", or "- <reason>" to
#      freeze everything. Set and clear it with `gh variable set MERGE_FREEZE`
#      / `gh variable delete MERGE_FREEZE`: no PR is needed, so a freeze can
#      always be lifted. (It replaces .temp/coord/FREEZE.)
#   2. A release goes into the queue alone. A release PR is one that changes
#      VERSION. On its merge-queue entry, the group must hold exactly one
#      commit (its own), or the release would carry code QA never verified.
#      The previous release must also be on npm by then.
#   3. A release is cut until it is on npm. Every other PR fails while the
#      VERSION it would merge onto is not yet on the registry: main's VERSION on
#      the PR, the merge group head's on a queue entry (so a PR queued behind a
#      release waits too).
#
# `open` exits 0 when the window is open for an ordinary PR (no freeze, main's
# VERSION on npm), 1 when not. `rerun-list` prints the ids of failed
# release-window runs worth re-running: the latest run for a head that is still
# some open PR's head, when that run failed. release-window-refresh.yml uses
# both, because nothing else re-runs the check when a freeze lifts or a publish
# lands.
#
# Reads only, through `gh api` (GH overrides the binary) and the public npm
# registry (CURL overrides). REPO defaults to $GITHUB_REPOSITORY, then
# dork-labs/dorkos; NPM_PACKAGE defaults to dorkos.
#
# Exit codes: 0 may merge; 1 may not (the reason is printed); 2 usage, or
# GitHub or npm could not be read. A gate that cannot read fails closed, as
# arm.sh did (an npm outage blocks merges; Security ruled that a PM call).
#
# Fixtures: scripts/test-release-window-check.sh.

# --help (DOR-4950). A gate checked out alone, as the PR-side gates are, runs without it.
gate_help="$(dirname "$0")/lib/gate-help.sh"
# shellcheck source=lib/gate-help.sh
[ ! -r "$gate_help" ] || . "$gate_help"

set -euo pipefail

GH=${GH:-gh}
CURL=${CURL:-curl}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
PKG=${NPM_PACKAGE:-dorkos}

usage() {
  sed -n '4,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
err() {
  echo "release-window-check: $*" >&2
  exit 2
}
no() {
  echo "WAIT: $*" >&2
  exit 1
}

# VERSION at a ref, strict x.y.z.
version_at() {
  local v
  v=$("$GH" api "repos/$REPO/contents/VERSION?ref=$1" -H 'Accept: application/vnd.github.raw') ||
    err "could not read VERSION at $1"
  v=$(tr -d '[:space:]' <<<"$v")
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || err "VERSION at $1 is not x.y.z ('$v')"
  echo "$v"
}

# 0 when $PKG@$1 is on npm, 1 when npm says it is not, exit 2 otherwise.
on_npm() {
  local code
  code=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 20 "https://registry.npmjs.org/$PKG/$1") || code=000
  case "$code" in
    200) return 0 ;;
    404) return 1 ;;
    *) err "npm answered $code for $PKG@$1" ;;
  esac
}

# Rule 1. Prints nothing and returns when the PR may pass the freeze.
check_freeze() {
  local pr=$1 freeze allowed reason
  freeze=$(sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' <<<"${MERGE_FREEZE:-}")
  [ -n "$freeze" ] || return 0
  allowed=${freeze%%[[:space:]]*}
  reason=${freeze#"$allowed"}
  reason=${reason#"${reason%%[![:space:]]*}"}
  allowed=${allowed#\#}
  if [[ "$allowed" =~ ^[1-9][0-9]*$ ]] && [ "$allowed" = "$pr" ]; then
    echo "Freeze is on, and #$pr is the PR it lets through (${reason:-no reason given})."
    return 0
  fi
  [[ "$allowed" =~ ^[1-9][0-9]*$ ]] && allowed="#$allowed" || allowed="nothing"
  no "merges are frozen (${reason:-no reason given}); only $allowed may merge. Whoever set MERGE_FREEZE lifts it; this check re-runs within 15 minutes."
}

is_release() {
  local files
  files=$("$GH" api --paginate "repos/$REPO/pulls/$1/files?per_page=100" --jq '.[].filename') ||
    err "could not read the files of #$1"
  grep -qxF VERSION <<<"$files"
}

check_pr_number() { [[ "${1:-}" =~ ^[1-9][0-9]*$ ]] || usage; }
check_sha() { [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || usage; }

mode=${1:-}
case "$mode" in
  pr)
    [ $# -eq 2 ] || usage
    check_pr_number "$2"
    pr=$2
    check_freeze "$pr"
    if is_release "$pr"; then
      echo "OK: #$pr is a release (it changes VERSION); the queue checks that it goes in alone."
      exit 0
    fi
    v=$(version_at main)
    on_npm "$v" || no "main is at $v and $PKG@$v is not on npm yet: a release is being cut. This check re-runs once it is published."
    echo "OK: #$pr may merge (no freeze; $PKG@$v is on npm)."
    ;;
  group)
    [ $# -eq 4 ] || usage
    check_pr_number "$2"
    check_sha "$3"
    check_sha "$4"
    pr=$2 base=$3 head=$4
    check_freeze "$pr"
    if is_release "$pr"; then
      n=$("$GH" api "repos/$REPO/compare/$base...$head" --jq .total_commits) || err "could not compare the merge group"
      [ "$n" = 1 ] || no "release #$pr must go into the queue alone, and its group holds $n commits. Wait for the PRs ahead of it to land, then queue it again."
      v=$(version_at "$base")
      on_npm "$v" || no "the previous release, $PKG@$v, is not on npm yet."
      echo "OK: release #$pr is alone in its merge group."
      exit 0
    fi
    v=$(version_at "$head")
    on_npm "$v" || no "this merge group would land on $v, which is not on npm yet: a release is ahead of #$pr or being cut."
    echo "OK: #$pr may merge (no freeze; $PKG@$v is on npm)."
    ;;
  open)
    [ $# -eq 1 ] || usage
    freeze=$(tr -d '[:space:]' <<<"${MERGE_FREEZE:-}")
    [ -z "$freeze" ] || {
      echo "closed: MERGE_FREEZE is set"
      exit 1
    }
    v=$(version_at main)
    on_npm "$v" || {
      echo "closed: $PKG@$v is not on npm yet"
      exit 1
    }
    echo "open: no freeze, $PKG@$v is on npm"
    ;;
  rerun-list)
    [ $# -eq 3 ] || usage
    # runs.json: [{databaseId, headSha, conclusion, createdAt}] from gh run list.
    # open-heads.txt: one head SHA per line, of the open PRs.
    jq -r --rawfile heads "$3" '
      ($heads | split("\n") | map(select(length > 0))) as $open
      | group_by(.headSha)[]
      | max_by(.createdAt)
      | select(.conclusion == "failure" and (.headSha as $h | $open | index($h)))
      | .databaseId' "$2" || err "could not read $2"
    ;;
  *) usage ;;
esac
