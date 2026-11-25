#!/usr/bin/env bash
# rolling-bisect.sh — which merge broke a rolling main run?
#
#   scripts/rolling-bisect.sh decide <facts.json>
#   scripts/rolling-bisect.sh facts <run-id>
#
# DOR-5122, under DOR-5098 (Dorian, Nov 23: release fast, fix forward). The
# decision behind .github/workflows/rolling-bisect.yml.
#
# A ROLLING workflow (browser-test's push run, DOR-5130) keeps one run in
# flight on main, so one run covers every merge since the previous one. When it
# fails at H, auto-revert.sh leaves it alone (it never re-runs or reverts a
# rolling workflow: see "WHY ROLLING RUNS ARE NEVER RE-RUN HERE" there), and
# this takes it from the FIRST failure. The first probe re-tests H itself: the
# same workflow is dispatched on main with `bisect_sha=<sha>`, which checks
# that merge out and runs the full suite on it in a concurrency group of its
# own, so it never cancels or waits behind a rolling push run. H passing on
# that probe is a flake: said once, no culprit. H failing again (its second
# failure) starts the binary search for the first bad merge between the last
# green push run (G) and H. Each dispatch halves the range, so a range of N
# merges costs one probe of H plus at most ceil(log2(N)) runs (N <= 16, so at
# most 5 in all), plus at most one re-run of the failed jobs of each other run
# that fails, so a flake never blames anyone. A range of one merge is H: the
# probe alone names it.
#
# `decide` prints one line:
#   dispatch <sha>          test this merge next (H itself first);
#   rerun <run-id>          a bisect run below H failed once: re-run its failed
#                           jobs, so a flake never counts as a bad merge (the
#                           probe of H is never re-run: it is H's second try);
#   wait                    a bisect run is still in flight;
#   culprit <sha> <pr>      the first bad merge: it failed twice, in the same
#                           job as H, and the merge before it passed;
#   inconclusive <reason>   stop and say so on the failure-group issue; never
#                           revert on doubt (head-passed-on-re-test: H was a
#                           flake; flaky, budget-exhausted, too-many-merges,
#                           workflow-changed, ...);
#   skip <reason>           nothing to bisect (not a rolling failure, main
#                           recovered).
#
# facts.json: {origin, workflow, workflowFile, url, event, branch, sha,
#              conclusion, attempt, good, newerGreen, workflowChanged,
#              originFamilies, range: [{sha, subject, pr}] (oldest first, H
#              last) | null, points: [{sha, kind, id, status, conclusion,
#              attempt, families}]}
# A point is a completed push run or a bisect run of the same workflow; a
# family is a failed job's name without its " (i/N)" shard suffix.
#
# `facts` builds it from GitHub reads (GH overrides the binary; REPO defaults
# to $GITHUB_REPOSITORY, then dork-labs/dorkos). <run-id> is the failed push
# run, or one of its bisect runs (titled "bisect <sha> for run <id>"), which
# resolves to the push run it bisects. Reads only.
#
# Bisect runs use main's copy of the workflow on an older tree, which is only
# the tree's own workflow when that file did not change since G; when it did,
# the answer is `inconclusive workflow-changed`.
#
# Exit codes: 0 a decision was printed; 2 usage or unreadable input.
# Fixtures: scripts/test-rolling-bisect.sh.
set -uo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
MAX_MERGES=16

usage() {
  sed -n '4,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
err() {
  echo "rolling-bisect: $*" >&2
  exit 2
}

decide() {
  local f=$1
  jq -e 'type == "object"' "$f" >/dev/null 2>&1 || err "unreadable facts: $f"
  jq -r --argjson max "$MAX_MERGES" '
    def out(r): "inconclusive " + r;
    def skip(r): "skip " + r;
    def failed: .conclusion == "failure" or .conclusion == "timed_out";
    # One point: pending | good | bad | rerun | other | void | ignore. A
    # failure counts once it has happened twice: a run re-run once, or the
    # probe of H, which is the second failure of H (its push run was the first).
    def state($fam; $isH):
      if .status != "completed" then "pending"
      elif .conclusion == "success" then "good"
      elif failed then
        if (.attempt // 1) < 2 and ((.kind == "bisect" and $isH) | not) then
          (if .kind == "bisect" then "rerun" else "ignore" end)
        elif any((.families // [])[]; . as $x | $fam | index($x) != null) then "bad"
        else "other" end
      else "void" end;
    . as $f
    | if .event != "push" or .branch != "main" then skip("not-a-push-to-main")
      elif (failed | not) then skip("not-a-failure")
      elif .newerGreen == true then skip("main-recovered")
      elif ((.good // "") | test("^[0-9a-f]{40}$") | not) then out("no-green-run-before")
      elif (.range | type) != "array" or (.range | length) == 0 or (.range | last | .sha) != .sha
        then out("range-unreadable")
      elif (.range | length) > $max then out("too-many-merges")
      elif .workflowChanged != false then out("workflow-changed")
      else
        ($f.range | map(.sha)) as $shas
        | ($shas | length) as $n
        | ($f.originFamilies // []) as $fam
        | [ $f.points[]? | . as $p | ($shas | index($p.sha)) as $i | select($i != null)
            | {i: $i, id, kind, st: state($fam; $i == $n - 1)} ] as $pts
        | [$pts[] | select(.i == $n - 1) | .st] as $h
        | ([$pts[] | select(.st == "bad") | .i] + [$n - 1] | min) as $hi
        | ([$pts[] | select(.st == "good") | .i] + [-1] | max) as $lo
        | ([$pts[] | select(.kind == "bisect" and .i < $n - 1) | .i] | unique | length) as $used
        | (($n | log2 | ceil)) as $budget
        | if any($pts[]; .st == "other") then out("different-failure")
          elif any($pts[]; .st == "void") then out("bisect-run-cancelled")
          elif any($h[]; . == "good") then out("head-passed-on-re-test")
          elif any($h[]; . == "bad") | not then
            (if any($h[]; . == "pending") then "wait" else "dispatch \($f.sha)" end)
          elif $lo >= $hi then out("flaky")
          elif any($pts[]; .st == "rerun") then "rerun \([$pts[] | select(.st == "rerun") | .id] | first)"
          elif any($pts[]; .st == "pending") then "wait"
          elif $hi == $lo + 1 then
            $f.range[$hi] as $c
            | if ($c.subject // "") | test("^chore\\(release\\)"; "i") then out("culprit-is-the-release-commit")
              elif ($c.subject // "") | test("^(revert|Revert)\\b") then out("culprit-is-a-revert")
              elif (($c.pr // 0) | type != "number" or . < 1) then out("no-merged-pr")
              else "culprit \($c.sha) \($c.pr)"
              end
          elif $used >= $budget then out("budget-exhausted")
          else "dispatch \($shas[(($lo + $hi) / 2) | floor])"
          end
      end' "$f" || err "could not decide"
}

# Failed job families of one run's latest attempt, the fan-in (the job named
# after the workflow) dropped when anything else failed.
families() {
  local run=$1 wf=$2
  "$GH" api "repos/$REPO/actions/runs/$run/jobs?filter=latest&per_page=100" \
    --jq "[.jobs[] | select(.conclusion == \"failure\" or .conclusion == \"timed_out\") | .name | sub(\" \\\\([0-9]+/[0-9]+\\\\)\$\"; \"\")] | unique | (. - [$(jq -Rn --arg w "$wf" '$w')]) as \$g | if (\$g | length) > 0 then \$g else . end"
}

facts() {
  local run=$1 r title origin wfid wf file h created pushes bisects good newer range changed fam pts
  r=$("$GH" api "repos/$REPO/actions/runs/$run" \
    --jq '{id, attempt: .run_attempt, status, conclusion, event, branch: .head_branch, sha: .head_sha, wf: .workflow_id, name, path, url: .html_url, title: .display_title, created: .created_at}') ||
    err "could not read run $run"
  title=$(jq -r '.title // ""' <<<"$r")
  if [ "$(jq -r .event <<<"$r")" = workflow_dispatch ] &&
    [[ "$title" =~ ^bisect\ [0-9a-f]{40}\ for\ run\ ([1-9][0-9]*)$ ]]; then
    origin=${BASH_REMATCH[1]}
    r=$("$GH" api "repos/$REPO/actions/runs/$origin" \
      --jq '{id, attempt: .run_attempt, status, conclusion, event, branch: .head_branch, sha: .head_sha, wf: .workflow_id, name, path, url: .html_url, title: .display_title, created: .created_at}') ||
      err "could not read run $origin"
  fi
  origin=$(jq -r .id <<<"$r")
  wfid=$(jq -r .wf <<<"$r")
  wf=$(jq -r .name <<<"$r")
  file=$(jq -r '.path | sub("^.*/"; "") | sub("@.*$"; "")' <<<"$r")
  h=$(jq -r .sha <<<"$r")
  created=$(jq -r .created <<<"$r")
  [[ "$h" =~ ^[0-9a-f]{40}$ ]] && [[ "$wfid" =~ ^[0-9]+$ ]] || err "unexpected run $origin"

  pushes=$("$GH" api "repos/$REPO/actions/workflows/$wfid/runs?branch=main&event=push&per_page=100" \
    --jq '[.workflow_runs[] | {sha: .head_sha, kind: "push", id, status, conclusion, attempt: .run_attempt, created: .created_at}]') ||
    err "could not read the push runs"
  good=$(jq -r --arg c "$created" '[.[] | select(.conclusion == "success" and .created < $c)] | sort_by(.created) | last | .sha // ""' <<<"$pushes")
  newer=$(jq --arg c "$created" 'any(.[]; .conclusion == "success" and .created > $c)' <<<"$pushes")

  range=null
  changed=true
  if [[ "$good" =~ ^[0-9a-f]{40}$ ]]; then
    range=$("$GH" api "repos/$REPO/compare/$good...$h" \
      --jq "(.commits | map({key: .sha, value: {sha, parent: .parents[0].sha, subject: (.commit.message | split(\"\\n\")[0])}}) | from_entries) as \$m
        | if .status != \"ahead\" or \$m[\"$h\"] == null then null
          else [\"$h\" | recurse(\$m[.].parent as \$p | if \$p == \"$good\" or \$m[\$p] == null then empty else \$p end)]
            | reverse
            | if \$m[.[0]].parent == \"$good\" then map(\$m[.] | {sha, subject}) else null end
          end") || err "could not compare ${good:0:7}...${h:0:7}"
    [ -n "$range" ] || range=null
    # Bisect runs use main's copy of the workflow: only trustworthy when that
    # copy did not change since G. 300 files is the API's cap: unknown, so changed.
    changed=$("$GH" api "repos/$REPO/compare/$good...main" \
      --jq "[.files[]?.filename] | length >= 300 or index(\".github/workflows/$file\") != null") ||
      err "could not compare ${good:0:7}...main"
  fi

  # The merged PR behind each merge, only for a range small enough to bisect.
  if [ "$range" != null ] && [ "$(jq length <<<"$range")" -le "$MAX_MERGES" ]; then
    local c pr withpr='[]'
    for c in $(jq -r '.[].sha' <<<"$range"); do
      pr=$("$GH" api "repos/$REPO/commits/$c/pulls" \
        --jq '[.[] | select(.merged_at != null)] | first | .number // 0') || err "could not read the PR behind ${c:0:7}"
      withpr=$(jq --arg s "$c" --argjson pr "${pr:-0}" '. + [{sha: $s, pr: $pr}]' <<<"$withpr")
    done
    range=$(jq --argjson p "$withpr" 'map(. as $c | $c + {pr: ($p[] | select(.sha == $c.sha) | .pr)})' <<<"$range")
  fi

  bisects=$("$GH" api "repos/$REPO/actions/workflows/$wfid/runs?event=workflow_dispatch&branch=main&per_page=100" \
    --jq '[.workflow_runs[] | select((.display_title // "") | test("^bisect [0-9a-f]{40} for run [0-9]+$"))
      | {sha: (.display_title | split(" ")[1]), kind: "bisect", id, status, conclusion, attempt: .run_attempt}]') ||
    err "could not read the bisect runs"

  fam=$(families "$origin" "$wf") || err "could not read the jobs of run $origin"
  # Every completed push run and every bisect run, with its families when it
  # failed after a re-run, or when it is a probe of H (H's second failure):
  # the only failures that count.
  pts='[]'
  local p id
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if jq -e --arg h "$h" '.status == "completed" and (.conclusion == "failure" or .conclusion == "timed_out")
      and (.attempt >= 2 or (.kind == "bisect" and .sha == $h))' <<<"$p" >/dev/null; then
      id=$(jq -r .id <<<"$p")
      if [ "$id" = "$origin" ]; then
        p=$(jq --argjson f "$fam" '. + {families: $f}' <<<"$p")
      else
        p=$(jq --argjson f "$(families "$id" "$wf")" '. + {families: $f}' <<<"$p") || err "could not read the jobs of run $id"
      fi
    fi
    pts=$(jq --argjson p "$p" '. + [$p | del(.created)]' <<<"$pts")
  done < <(jq -c --argjson b "$bisects" '[.[] | select(.status == "completed")] + $b | .[]' <<<"$pushes")

  jq -n --argjson r "$r" --arg file "$file" --arg good "$good" --argjson newer "$newer" \
    --argjson range "$range" --argjson changed "$changed" --argjson fam "$fam" --argjson pts "$pts" \
    '{origin: $r.id, workflow: $r.name, workflowFile: $file, url: $r.url, event: $r.event,
      branch: $r.branch, sha: $r.sha, conclusion: $r.conclusion, attempt: $r.attempt,
      good: (if $good == "" then null else $good end), newerGreen: $newer, workflowChanged: $changed,
      originFamilies: $fam, range: $range, points: $pts}'
}

case "${1:-}" in
  decide) [ $# -eq 2 ] || usage; decide "$2" ;;
  facts) [ $# -eq 2 ] && [[ "$2" =~ ^[1-9][0-9]*$ ]] || usage; facts "$2" ;;
  *) usage ;;
esac
