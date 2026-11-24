#!/usr/bin/env bash
# daily-sweep.sh — the day's merges, for QA's and the designer's batch review.
#
#   scripts/daily-sweep.sh collect <since-iso> <out-dir>
#   scripts/daily-sweep.sh render <out-dir> <since-label> [previous-body-file]
#
# DOR-5120, under DOR-5098 (Dorian, Nov 23: no local agent reviews an open PR;
# QA and the designer review everything merged since the last release, once a
# day). The rules are the ones that used to gate each PR, unchanged:
# scripts/design-ok.sh (something a person sees) and scripts/qa-real-data.sh
# (config, migration or upgrade-floor code). A PR either rule flags is on that
# reviewer's list. Their labels are no longer merge gates (pr-gates prints them
# as notes); this list is where the review happens now.
#
# collect: reads every PR merged into main since <since-iso> and writes, per PR,
#          <out-dir>/<n>/{meta.json,labels.txt,files.txt,patches.txt}. Reads only
#          (GH overrides the gh binary; REPO defaults to $GITHUB_REPOSITORY, then
#          dork-labs/dorkos).
# render:  pure. Prints the markdown list: a design section, a QA section, and
#          a count of the rest. A PR whose inputs cannot be read is listed under
#          both, so nothing silently leaves the review. With the issue's
#          previous body, a PR already ticked there stays ticked.
#
# Public text only: PR numbers, titles, authors and the rule's own reason. No
# @-mentions: they would notify whatever GitHub account has that name.
# Exit codes: 0 done; 2 usage or a failed read.
# Fixtures: scripts/test-daily-sweep.sh.
set -uo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

usage() {
  sed -n '4,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
err() {
  echo "daily-sweep: $*" >&2
  exit 2
}

collect() {
  local since=$1 out=$2 n pjq
  [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+Z$ ]] || usage
  mkdir -p "$out" || err "no out dir"
  pjq=$(bash "$here/qa-real-data.sh" patches-jq) || err "could not load qa-real-data.sh's patch filter"
  "$GH" api --paginate -X GET search/issues \
    -f q="repo:$REPO is:pr is:merged base:main merged:>=$since" -f per_page=100 \
    --jq '.items[].number' >"$out/prs.txt" || err "could not search merged PRs"
  while IFS= read -r n; do
    [[ "$n" =~ ^[1-9][0-9]*$ ]] || continue
    mkdir -p "$out/$n"
    "$GH" api "repos/$REPO/pulls/$n" \
      --jq '{number, title, author: .user.login, merged_at}' >"$out/$n/meta.json" &&
      "$GH" api --paginate "repos/$REPO/issues/$n/labels?per_page=100" --jq '.[].name' >"$out/$n/labels.txt" &&
      "$GH" api --paginate "repos/$REPO/pulls/$n/files?per_page=100" \
        --jq '.[] | {filename, previous_filename, status, additions, deletions, patch} | tojson' >"$out/$n/files.jsonl" &&
      jq -r '.filename' "$out/$n/files.jsonl" >"$out/$n/files.txt" &&
      jq -r -s "$pjq" "$out/$n/files.jsonl" >"$out/$n/patches.txt" ||
      : >"$out/$n/unreadable"
  done <"$out/prs.txt"
}

# One line from a rule's reason: its first flagged path and how many more.
summarize() {
  local paths first count
  paths=$(grep -E '^  [^ ]' <<<"$1" | sed 's/^  //' | sort -u)
  first=$(head -n 1 <<<"$paths")
  count=$(grep -c . <<<"$paths" || true)
  if [ -z "$first" ]; then
    head -n 1 <<<"$1"
  elif [ "$count" -gt 1 ]; then
    echo "\`$first\` and $((count - 1)) more"
  else
    echo "\`$first\`"
  fi
}

render() {
  local out=$1 since=$2 prev=${3:-} d n title author line reason design="" qa="" rest=0 total=0 ticked=""
  if [ -n "$prev" ] && [ -f "$prev" ]; then
    ticked=$(grep -oE '^- \[[xX]\] #[0-9]+ ' "$prev" | grep -oE '[0-9]+' | sort -u)
  fi
  [ -d "$out" ] && [ -f "$out/prs.txt" ] || err "no collected sweep in $out"
  while IFS= read -r n; do
    [[ "$n" =~ ^[1-9][0-9]*$ ]] || continue
    d=$out/$n
    total=$((total + 1))
    title=$(jq -r '.title // "?"' "$d/meta.json" 2>/dev/null) || title="?"
    author=$(jq -r '.author // "?"' "$d/meta.json" 2>/dev/null) || author="?"
    line="- [ ] #$n $title (by $author)"
    grep -qxF "$n" <<<"$ticked" && line="- [x] #$n $title (by $author)"
    if [ -e "$d/unreadable" ]; then
      design+="$line: could not read this PR, check it by hand"$'\n'
      qa+="$line: could not read this PR, check it by hand"$'\n'
      continue
    fi
    local hit=0
    if reason=$(bash "$here/design-ok.sh" needs "$d/labels.txt" "$d/files.txt" "$title" 2>/dev/null); then
      design+="$line: $(summarize "$reason")"$'\n'
      hit=1
    fi
    if reason=$(bash "$here/qa-real-data.sh" needs "$d/labels.txt" "$d/files.txt" "$d/patches.txt" 2>/dev/null); then
      qa+="$line: $(summarize "$reason")"$'\n'
      hit=1
    fi
    [ "$hit" = 1 ] || rest=$((rest + 1))
  done <"$out/prs.txt"

  echo "## Daily sweep: merged since $since"
  echo
  echo "$total PR(s) merged. Review each one listed for you once, at main, and fix forward: open a PR or a Linear issue, then tick it here. Nothing here blocks a merge or the release (DOR-5120)."
  echo
  echo "### Design (the designer agent): $(grep -c . <<<"$design" || true)"
  echo
  [ -n "$design" ] && printf '%s' "$design" || echo "Nothing a person sees changed."
  echo
  echo "### QA (the QA agent): $(grep -c . <<<"$qa" || true)"
  echo
  [ -n "$qa" ] && printf '%s' "$qa" || echo "No config, migration or upgrade-floor change."
  echo
  echo "$rest other PR(s) need neither review."
}

case "${1:-}" in
  collect) [ $# -eq 3 ] || usage; collect "$2" "$3" ;;
  render) [ $# -eq 3 ] || [ $# -eq 4 ] || usage; render "$2" "$3" "${4:-}" ;;
  *) usage ;;
esac
