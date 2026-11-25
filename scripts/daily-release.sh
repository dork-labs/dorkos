#!/usr/bin/env bash
# daily-release.sh — what the daily release does next, and from which commit.
#
#   scripts/daily-release.sh facts
#   scripts/daily-release.sh decide <facts.json>
#   scripts/daily-release.sh pick <version>
#   scripts/daily-release.sh pin <version> <P-sha>
#   scripts/daily-release.sh commits <checkout> <previous> <P-sha>
#   scripts/daily-release.sh summary <state.json>
#
# DOR-5123 (design §1, §2). daily-release.yml runs it as a state machine: each
# run reads GitHub's state and takes one step, so it resumes after any failure.
#
# `facts` reads (GitHub, npm; read-only) whether a release is in flight: a
#   release/vX.Y.Z branch newer than main's VERSION, its release PR, tag,
#   native artifact run, npm version, GitHub release and back-merge PR; the
#   oldest open issue labelled HOLD_LABEL (release-hold); and, for a rollback,
#   npm's versions and the commit the release before BAD_VERSION was cut at.
#   ACTION (cut|advance|rollback), BAD_VERSION and DAILY_RELEASE_HOLD come
#   from the env.
# `decide` prints exactly one line:
#   CUT                    pick P and cut release/vX.Y.Z there
#   ROLLBACK <bad> <prev> <P_prev>   cut release/v<bad+1> at P_prev, the
#                          commit v<prev> was cut at (design §6)
#   TAG|PUBLISH|SURFACES|BACKMERGE <X.Y.Z>   advance the release in flight
#   WAIT <why>             something is running or a person must act
#   NONE <why>             nothing to do
#   REFUSE <why>           a read failed, or the request is not built yet
# `pick` prints `P <sha>` for the newest main commit of the last WINDOW_HOURS
#   (48) whose newest full run (FULL_RUN_WORKFLOWS, push or schedule on main)
#   is green and that scripts/release-gate.sh (GATE) answers SHIP for: on main's
#   first parent, not reverted, every required check green in the merge queue.
#   Otherwise `NONE <why>`. At most MAX_CANDIDATES commits go to the gate.
#   <version> only satisfies the gate's version format; P has no version yet.
# `pin` asks the same gate about one named commit, with no window and no
#   full-run prefilter (the gate re-reads the full run itself): `P <sha>` when
#   it ships, otherwise `NONE <why>`. A rollback names P_prev this way.
# `commits` prints release-commit.ts's --commits file: `<sha> <subject>`, then
#   a tab and the tab-separated paths each commit added, for v<previous>..P.
# `summary` renders the step summary from the state the workflow assembled:
#   {live, decision, pick, plan, planExit, planError}.
#
# THE HOLD. A cut waits while DAILY_RELEASE_HOLD (a repository variable) is set
# or any issue labelled release-hold is open. A rollback opens that issue, with
# the workflow's own token, so the next daily cut does not ship the bad code
# again; closing it, once the fix is on main, lets the cuts resume. Either kind
# stops new cuts only, never a release already in flight.
#
# GH and NPM override the binaries; REPO defaults to $GITHUB_REPOSITORY, then
# dork-labs/dorkos; NOW (ISO 8601) overrides the clock.
# Exit codes: 0 an answer was printed; 2 usage or unreadable input.
# Fixtures: scripts/test-daily-release.sh.
set -uo pipefail

GH=${GH:-gh}
NPM=${NPM:-npm}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
WINDOW_HOURS=${WINDOW_HOURS:-48}
MAX_CANDIDATES=${MAX_CANDIDATES:-5}
FULL_RUN_WORKFLOWS=${FULL_RUN_WORKFLOWS:-browser-test.yml test.yml}
GATE=${GATE:-$(dirname "${BASH_SOURCE[0]}")/release-gate.sh}
HOLD_LABEL=${HOLD_LABEL:-release-hold}
PACKAGE=dorkos
SEMVER='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

usage() {
  sed -n '4,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
err() {
  echo "daily-release: $*" >&2
  exit 2
}

now_iso() { echo "${NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"; }

# since <hours>: NOW minus that many hours, as ISO 8601 UTC.
since() {
  jq -rn --arg now "$(now_iso)" --argjson h "$1" '$now | fromdateiso8601 - ($h * 3600) | todateiso8601'
}

decide() {
  local f=$1
  jq -e 'type == "object"' "$f" >/dev/null 2>&1 || err "unreadable facts: $f"
  jq -r '
    def semver: type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$");
    def sha: type == "string" and test("^[0-9a-f]{40}$");
    . as $f
    | ($f.inflight) as $i
    | ($f.rollback // {}) as $r
    | if ($f.unreadable // ["facts"] | length) > 0 then "REFUSE unreadable: " + ($f.unreadable // ["facts"] | join(", "))
      elif $f.action == "rollback" then
        if ($r.bad | semver | not) then "REFUSE a rollback needs bad_version as X.Y.Z"
        elif $r.newest != $r.bad then
          "REFUSE \($r.bad) is not the newest published version (npm has \($r.newest // "none")); only the newest can be rolled back"
        elif ($r.prev | semver | not) then "REFUSE npm has no version before \($r.bad) to roll back to"
        elif ($r.pPrev | sha | not) then
          "REFUSE the commit v\($r.prev) was cut at is unknown (no tag v\($r.prev), or GitHub could not compare it with main)"
        elif $r.aheadBy != 1 then
          "REFUSE v\($r.prev) is \($r.aheadBy) commits ahead of main, not one release commit on top of it, so main cannot rebuild it; roll back by hand"
        elif $i != null and $i.version != $r.bad then
          "REFUSE release v\($i.version) is in flight; a rollback cuts only when nothing newer than v\($r.bad) is (if it is this rollback, it advances on its own)"
        else "ROLLBACK \($r.bad) \($r.prev) \($r.pPrev)" end
      elif (["cut", "advance"] | index($f.action)) == null then "REFUSE unknown action \($f.action)"
      elif $i != null then
        ("v" + $i.version) as $v
        | if $i.pr == "open" then "WAIT the release PR #\($i.prNumber) for \($v) is open"
          elif $i.pr != "merged" then "WAIT release/\($v) has no merged release PR (cut by hand, or a cut that stopped half way)"
          elif $i.tag | not then "TAG \($i.version)"
          elif $i.onNpm | not then
            if $i.artifact == "success" then
              if $i.publishInFlight then "WAIT a Release Publish run is in progress"
              else "PUBLISH \($i.version)" end
            elif $i.artifact == "none" then "WAIT no native artifact run for \($v) yet"
            elif $i.artifact == "pending" then "WAIT the native artifact build for \($v) is running"
            else "REFUSE the native artifact build for \($v) concluded \($i.artifact)" end
          elif $i.ghRelease | not then "SURFACES \($i.version)"
          elif $i.backmerge == "none" then "BACKMERGE \($i.version)"
          elif $i.backmerge == "open" then "WAIT the \($v) back-merge PR is open"
          else "WAIT \($v) is back-merged but main VERSION reads \($f.mainVersion)" end
      elif $f.action == "advance" then "NONE no release in flight"
      elif ($f.hold // "") != "" then "WAIT DAILY_RELEASE_HOLD is set: \($f.hold)"
      elif $f.holdIssue != null then "WAIT the release-hold issue #\($f.holdIssue.number) is open: \($f.holdIssue.title)"
      elif $f.mainVersion != $f.previous then
        "WAIT main VERSION \($f.mainVersion) is not the latest release v\($f.previous) (a release by hand is in progress)"
      else "CUT"
      end' "$f" || err "could not decide"
}

# semver_gt <a> <b>: is a newer than b?
semver_gt() {
  jq -en --arg a "$1" --arg b "$2" '($a | split(".") | map(tonumber)) > ($b | split(".") | map(tonumber))' >/dev/null
}

facts() {
  local unreadable=() raw main='' previous='' inflight='null'
  mark() { unreadable+=("$1"); }

  if raw=$("$GH" api "repos/$REPO/contents/VERSION?ref=main" --jq '.content | @base64d | gsub("\\s"; "")') &&
    [[ "$raw" =~ $SEMVER ]]; then main=$raw; else mark 'main VERSION'; fi
  if raw=$("$GH" api "repos/$REPO/releases/latest" --jq '.tag_name | ltrimstr("v")') &&
    [[ "$raw" =~ $SEMVER ]]; then previous=$raw; else mark 'latest release'; fi

  # The newest release/vX.Y.Z branch newer than main's VERSION is in flight:
  # main's VERSION moves only when the back-merge lands (design §4).
  local version='' sha=''
  if [ -n "$main" ] && raw=$("$GH" api --paginate "repos/$REPO/git/matching-refs/heads/release/v" \
    --jq '.[] | "\(.ref | ltrimstr("refs/heads/release/v")) \(.object.sha)"'); then
    while read -r v s; do
      [[ "$v" =~ $SEMVER ]] || continue
      semver_gt "$v" "$main" || continue
      if [ -z "$version" ] || semver_gt "$v" "$version"; then version=$v sha=$s; fi
    done <<<"$raw"
  elif [ -n "$main" ]; then mark 'release branches'; fi

  if [ -n "$version" ]; then
    local base='' pr='none' prNumber=0 tag=false artifact=none onNpm=false ghRelease=false backmerge=none inflightPublish=false
    if raw=$("$GH" api "repos/$REPO/compare/main...$sha" --jq .merge_base_commit.sha) && [[ "$raw" =~ ^[0-9a-f]{40}$ ]]; then
      base=$raw
    else mark 'release base'; fi
    if raw=$("$GH" api --paginate "repos/$REPO/pulls?state=all&base=release/v$version&per_page=100" \
      --jq '.[] | "\(.number) \(.state) \(.merged_at != null)"'); then
      while read -r n s m; do
        [ -n "${n:-}" ] || continue
        if [ "$s" = open ]; then pr=open prNumber=$n
        elif [ "$m" = true ] && [ "$pr" != open ]; then pr=merged prNumber=$n; fi
      done <<<"$raw"
    else mark 'release PRs'; fi
    if raw=$("$GH" api "repos/$REPO/git/matching-refs/tags/v$version" --jq "any(.[]; .ref == \"refs/tags/v$version\")") &&
      [[ "$raw" =~ ^(true|false)$ ]]; then tag=$raw; else mark 'tags'; fi
    if raw=$("$GH" api "repos/$REPO/actions/workflows/browser-native-release-artifact.yml/runs?branch=v$version&event=workflow_dispatch&per_page=20" \
      --jq '.workflow_runs | sort_by(.created_at) | last | if . == null then "none" elif .status != "completed" then "pending" else .conclusion end'); then
      artifact=$raw
    else mark 'native artifact runs'; fi
    # npm answers a version it does not have with E404 and exit 1.
    local npmerr
    npmerr=$(mktemp) || err "no temp file"
    if raw=$("$NPM" view "dorkos@$version" version 2>"$npmerr"); then
      [ "$raw" = "$version" ] && onNpm=true
    elif ! grep -q E404 "$npmerr"; then mark 'npm'; fi
    rm -f "$npmerr"
    if raw=$("$GH" api "repos/$REPO/releases?per_page=30" --jq "any(.[]; .tag_name == \"v$version\")") &&
      [[ "$raw" =~ ^(true|false)$ ]]; then ghRelease=$raw; else mark 'GitHub releases'; fi
    if raw=$("$GH" api "repos/$REPO/pulls?state=all&head=${REPO%%/*}:release-backmerge/v$version" \
      --jq '[.[] | if .state == "open" then "open" elif .merged_at != null then "merged" else empty end] | if index("open") then "open" elif index("merged") then "merged" else "none" end'); then
      backmerge=$raw
    else mark 'back-merge PRs'; fi
    if raw=$("$GH" api "repos/$REPO/actions/workflows/release-publish.yml/runs?per_page=10" \
      --jq 'any(.workflow_runs[]; .status != "completed")') && [[ "$raw" =~ ^(true|false)$ ]]; then
      inflightPublish=$raw
    else mark 'Release Publish runs'; fi
    inflight=$(jq -n --arg version "$version" --arg sha "$sha" --arg base "$base" --arg pr "$pr" \
      --argjson prNumber "$prNumber" --argjson tag "$tag" --arg artifact "$artifact" --argjson onNpm "$onNpm" \
      --argjson ghRelease "$ghRelease" --arg backmerge "$backmerge" --argjson publish "$inflightPublish" \
      '{version: $version, branchSha: $sha, base: $base, pr: $pr, prNumber: $prNumber, tag: $tag,
        artifact: $artifact, onNpm: $onNpm, ghRelease: $ghRelease, backmerge: $backmerge, publishInFlight: $publish}')
  fi

  # The hold a rollback opens: the oldest open issue with the label. Pull
  # requests are issues to this API too; a labelled one holds just the same.
  local holdIssue='null'
  # gh prints nothing at all for a --jq result of null, so an empty answer from
  # a call that succeeded means no open hold issue.
  if raw=$("$GH" api "repos/$REPO/issues?labels=$HOLD_LABEL&state=open&sort=created&direction=asc&per_page=1" \
    --jq 'first | if . == null then null else {number, title} end') &&
    raw=${raw:-null} &&
    jq -e 'type == "null" or (type == "object" and (.number | type) == "number")' <<<"$raw" >/dev/null 2>&1; then
    holdIssue=$(jq -c . <<<"$raw")
  else mark 'release-hold issues'; fi

  local rollback='null'
  if [ "${ACTION:-cut}" = rollback ] && ! rollback=$(rollback_facts); then
    rollback='null'
    mark 'npm versions'
  fi

  jq -n --arg now "$(now_iso)" --arg action "${ACTION:-cut}" --arg hold "${DAILY_RELEASE_HOLD:-}" \
    --arg main "$main" --arg previous "$previous" --argjson inflight "$inflight" \
    --argjson holdIssue "$holdIssue" --argjson rollback "$rollback" --args \
    '{now: $now, action: $action, hold: $hold, holdIssue: $holdIssue, mainVersion: $main, previous: $previous,
      unreadable: $ARGS.positional, inflight: $inflight, rollback: $rollback}' ${unreadable[@]+"${unreadable[@]}"}
}

# rollback_facts: what a rollback of BAD_VERSION needs, as one JSON object:
# {bad, newest, prev, pPrev, aheadBy}. newest and prev come from npm's own
# version list (the newest plain X.Y.Z, and the one just below BAD_VERSION);
# pPrev is the merge base of tag v<prev> with main, which is the P it was cut
# at when that tag is exactly one release commit on top of main (aheadBy 1).
# An unknown P is pPrev "" and `decide` refuses; a failed npm read fails.
rollback_facts() {
  local bad=${BAD_VERSION:-} versions newest prev pPrev='' aheadBy=0 out
  versions=$("$NPM" view "$PACKAGE" versions --json 2>/dev/null) || return 1
  versions=$(jq -c --arg re "$SEMVER" '[if type == "array" then .[] else . end | select(type == "string" and test($re))]
    | sort_by(split(".") | map(tonumber))' <<<"$versions" 2>/dev/null) || return 1
  newest=$(jq -r 'last // ""' <<<"$versions")
  prev=$(jq -r --arg bad "$bad" 'index($bad) as $i | if $i == null or $i == 0 then "" else .[$i - 1] end' <<<"$versions")
  if [ -n "$prev" ] &&
    out=$("$GH" api "repos/$REPO/compare/main...v$prev" --jq '"\(.merge_base_commit.sha) \(.ahead_by)"' 2>/dev/null) &&
    [[ "$out" =~ ^([0-9a-f]{40})\ ([0-9]+)$ ]]; then
    pPrev=${BASH_REMATCH[1]} aheadBy=${BASH_REMATCH[2]}
  fi
  jq -cn --arg bad "$bad" --arg newest "$newest" --arg prev "$prev" --arg pPrev "$pPrev" --argjson aheadBy "$aheadBy" \
    '{bad: $bad, newest: $newest, prev: $prev, pPrev: $pPrev, aheadBy: $aheadBy}'
}

# candidates: main commits of the last WINDOW_HOURS, newest first, whose newest
# completed full run of every FULL_RUN_WORKFLOWS workflow (push or schedule on
# main) is green. A cheap filter: the gate re-reads all of it for the one it ships.
candidates() {
  local from commits w wfs green
  from=$(since "$WINDOW_HOURS") || return 1
  commits=$("$GH" api --paginate "repos/$REPO/commits?sha=main&since=$from&per_page=100" --jq '.[].sha') || return 1
  read -ra wfs <<<"$FULL_RUN_WORKFLOWS"
  [ "${#wfs[@]}" -gt 0 ] || return 1
  green=''
  for w in "${wfs[@]}"; do
    local runs
    runs=$("$GH" api --paginate "repos/$REPO/actions/workflows/$w/runs?branch=main&status=completed&created=%3E%3D$from&per_page=100" \
      --jq '.workflow_runs[] | select(.event == "push" or .event == "schedule") | {head_sha, conclusion, created_at, id}') || return 1
    # Newest completed run per commit; keep the commits where it passed.
    runs=$(jq -rs '[group_by(.head_sha)[] | sort_by(.created_at, .id) | last | select(.conclusion == "success") | .head_sha] | .[]' <<<"$runs") || return 1
    if [ -z "$green" ]; then green=$runs; else green=$(comm -12 <(sort <<<"$green") <(sort <<<"$runs")); fi
  done
  local c
  while read -r c; do
    [ -n "$c" ] && grep -qxF "$c" <<<"$green" && echo "$c"
  done <<<"$commits"
  return 0
}

pick() {
  local version=$1 list c n=0 first=''
  [ -f "$GATE" ] || { echo "NONE scripts/release-gate.sh is not on main yet (#4209), so no commit can be proved"; return 0; }
  list=$(candidates) || { echo "NONE could not read main's commits or full runs"; return 0; }
  [ -n "$list" ] || { echo "NONE no main commit of the last $WINDOW_HOURS h has a green full run"; return 0; }
  while read -r c; do
    [ "$n" -lt "$MAX_CANDIDATES" ] || break
    n=$((n + 1))
    local answer
    answer=$(gate_answer "$version" "$c")
    if [ "$answer" = SHIP ]; then
      echo "P $c"
      return 0
    fi
    [ -n "$first" ] || first="${c:0:12}: ${answer#REFUSE }"
  done <<<"$list"
  echo "NONE none of the newest $n main commits with a green full run passed the gate (newest, $first)"
}

# gate_answer <version> <sha>: the gate's one line for P, or a refusal when it
# cannot read or decide.
gate_answer() {
  local tmp answer
  tmp=$(mktemp) || err "no temp file"
  if bash "$GATE" facts "$1" "$2" >"$tmp" 2>/dev/null </dev/null; then
    answer=$(bash "$GATE" decide "$tmp" 2>/dev/null </dev/null) || answer="REFUSE the gate could not decide"
  else
    answer="REFUSE the gate could not read its facts"
  fi
  rm -f "$tmp"
  echo "$answer"
}

pin() {
  local version=$1 p=$2 answer
  [ -f "$GATE" ] || { echo "NONE scripts/release-gate.sh is not on main, so no commit can be proved"; return 0; }
  answer=$(gate_answer "$version" "$p")
  if [ "$answer" = SHIP ]; then echo "P $p"; else echo "NONE the gate refuses ${p:0:12}: ${answer#REFUSE }"; fi
}

commits() {
  local dir=$1 previous=$2 p=$3 c
  [[ "$previous" =~ $SEMVER ]] && [[ "$p" =~ ^[0-9a-f]{40}$ ]] || usage
  git -C "$dir" rev-parse -q --verify "v$previous^{commit}" >/dev/null || err "no tag v$previous in $dir"
  for c in $(git -C "$dir" rev-list "v$previous..$p") ; do
    printf '%s %s' "$c" "$(git -C "$dir" log -1 --format=%s "$c")"
    git -C "$dir" diff-tree --no-commit-id --name-only --no-renames --diff-filter=A -r "$c" | while IFS= read -r path; do
      printf '\t%s' "$path"
    done
    printf '\n'
  done
}

summary() {
  local f=$1
  jq -e 'type == "object"' "$f" >/dev/null 2>&1 || err "unreadable state: $f"
  jq -r '
    def code: "`" + . + "`";
    . as $s
    | ($s.decision // "REFUSE no decision") as $d
    | ($d | split(" ")) as $w
    | ($s.plan) as $plan
    | (($s.pick // "") | if startswith("P ") then .[2:] else null end) as $p
    | (if $s.live then "LIVE" else "DRY RUN: nothing was written" end) as $mode
    | ($w[0] == "ROLLBACK") as $rb
    | ($w[0] == "CUT" or $rb) as $cutting
    | (if $rb then "no rollback" else "no release today" end) as $none
    | [ "## Daily release (\($mode))", "" ]
      + (if $cutting and $p != null and $s.planExit == 0 and $plan != null then
          ("v" + $plan.version) as $v
          | [ (if $rb then "Decision: **roll back v\($w[1])**: cut \($v) at P, the commit v\($w[2]) was cut at, with the notes of v\($w[2]) under \("Rolled back \($w[1])." | code)."
               else "Decision: **cut \($v)**." end), "",
              "| | |", "|---|---|",
              "| Release point P | \($p | code) |",
              "| Version | \($plan.previous) → \($plan.version) (\($plan.bump): \($plan.bumpReason)) |",
              "| Breaking | \(if $plan.breaking then "yes, shipped as a flagged 0.x minor" else "no" end) |",
              "| Fragments | \($plan.fragments | length) |",
              "| Files in the release commit | \($plan.files | length) |",
              "| feat/fix commits with no fragment | \($plan.unfragmentedCommits | length) |",
              "",
              (if $s.live then "### What it does now" else "### What it would do" end) ]
            + ((if $rb then
                 ["Open an issue labelled `release-hold` (unless one is open): no daily cut runs while it is open. Close it once the fix for v\($w[1]) is on main."]
               else [] end)
               + [ "Create branch \("release/" + $v | code) at P.",
                   "Commit \($plan.subject | code) on \("release-commit/" + $v | code) through the Git Data API (signed by GitHub).",
                   "Open the release PR \("release-commit/" + $v | code) → \("release/" + $v | code), titled \($plan.subject | code), labelled `skip-changelog`, auto-merge by rebase.",
                   "Once it merges: tag \($v | code) at the tip and dispatch `browser-native-release-artifact.yml --ref \($v)`.",
                   "Once that run is green: dispatch `release-publish.yml` on main with `version=\($plan.version)`, `expected_sha=<the merged tip>`, `mode=routine`, `base=\($p)`.",
                   "Once npm has it: the GitHub release from the changelog section, the other surfaces, and the back-merge PR \("release-backmerge/" + $v | code) to main." ]
               | to_entries | map("\(.key + 1). \(.value)"))
            + (if ($plan.unfragmentedCommits | length) > 0 then
                ["", "Commits with no fragment (listed in the release PR body):"]
                + [$plan.unfragmentedCommits[] | "- \(.sha[0:12] | code) \(.subject)"]
              else [] end)
        elif $cutting and $p == null then
          [ "Decision: **\($none)**. \(($s.pick // "NONE no pick") | sub("^NONE "; ""))." ]
        elif $cutting and $s.planExit == 3 then
          [ "Decision: **\($none)**. P \($p | code) has no new changelog fragments." ]
        elif $cutting then
          [ "Decision: **\($none)**. The release commit for P \($p | code) was refused: \($s.planError // "unknown error")" ]
        elif $w[0] == "TAG" then
          [ "Decision: **tag v\($w[1])** at the merged release PR tip and dispatch `browser-native-release-artifact.yml --ref v\($w[1])`." ]
        elif $w[0] == "PUBLISH" then
          [ "Decision: **publish v\($w[1])**: dispatch `release-publish.yml` on main with `version=\($w[1])`, `expected_sha=<release/v\($w[1]) tip>`, `mode=routine`, `base=<P>`." ]
        elif $w[0] == "SURFACES" then
          [ "Decision: **surfaces for v\($w[1])**: the GitHub release from the changelog section, then desktop, Docker, Homebrew and the community image (not wired yet)." ]
        elif $w[0] == "BACKMERGE" then
          [ "Decision: **back-merge v\($w[1])**: open \("release-backmerge/v" + $w[1] | code) to main with auto-merge (not wired yet)." ]
        else
          [ "Decision: **\($w[0] | ascii_downcase)**. \($w[1:] | join(" "))" ]
        end)
      + (if $s.live then [] else ["", "Writes are off until the repository variable `DAILY_RELEASE_LIVE` is `on` (design build order row 11)."] end)
    | .[]' "$f" || err "could not render the summary"
}

case "${1:-}" in
  facts) [ $# -eq 1 ] || usage; facts ;;
  decide) [ $# -eq 2 ] || usage; decide "$2" ;;
  pick) [ $# -eq 2 ] && [[ "$2" =~ $SEMVER ]] || usage; pick "$2" ;;
  pin) [ $# -eq 3 ] && [[ "$2" =~ $SEMVER ]] && [[ "$3" =~ ^[0-9a-f]{40}$ ]] || usage; pin "$2" "$3" ;;
  commits) [ $# -eq 4 ] || usage; commits "$2" "$3" "$4" ;;
  summary) [ $# -eq 2 ] || usage; summary "$2" ;;
  *) usage ;;
esac
