#!/usr/bin/env bash
# Fixture suite for scripts/rolling-bisect.sh (DOR-5122). `decide` is pure and
# is walked through whole bisections; `facts` runs against a stubbed `gh`
# (GH=...) that answers from fixture files and logs every call. Needs bash and jq.
#
#   bash scripts/test-rolling-bisect.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/rolling-bisect.sh
tmp=$(mktemp -d -t rolling-bisect-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0
G=9999999999999999999999999999999999999999
c() { printf '%040d' "$1"; } # merge i of the range, oldest first

out=""
rc=0
check() {
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$2" "$3" >&2
  fi
}

# Facts for a range of N merges (PR 100+i), H = the last one, whose push run
# failed once in browser-shard (auto-revert never re-runs a rolling run); then
# jq edits. Points are added with pt. reset adds the probe of H (a bisect run
# at H that failed in browser-shard: H's second failure) unless told not to.
N=8
POINTS='[]'
pt() { # sha kind status conclusion attempt [families-json] [id]
  POINTS=$(jq --arg s "$1" --arg k "$2" --arg st "$3" --arg co "$4" --argjson a "$5" \
    --argjson f "${6:-[\"browser-shard\"]}" --argjson id "${7:-500}" \
    '. + [{sha: $s, kind: $k, id: $id, status: $st, conclusion: (if $co == "null" then null else $co end), attempt: $a, families: $f}]' <<<"$POINTS")
}
d() {
  local range='[]' i
  for ((i = 0; i < N; i++)); do
    range=$(jq --arg s "$(c $i)" --argjson pr $((100 + i)) '. + [{sha: $s, subject: "feat: merge \($pr) (#\($pr))", pr: $pr}]' <<<"$range")
  done
  jq -n --arg h "$(c $((N - 1)))" --arg g "$G" --argjson range "$range" --argjson pts "$POINTS" \
    '{origin: 77, workflow: "browser-test", workflowFile: "browser-test.yml", url: "u", event: "push",
      branch: "main", sha: $h, conclusion: "failure", attempt: 1, good: $g, newerGreen: false,
      workflowChanged: false, originFamilies: ["browser-shard"], range: $range,
      points: ([{sha: $h, kind: "push", id: 77, status: "completed", conclusion: "failure", attempt: 1}] + $pts)}' |
    jq "${1:-.}" >"$tmp/f.json"
  out=$("$SCRIPT" decide "$tmp/f.json" 2>&1)
  rc=$?
}
reset() { # [N] [noprobe]
  N=${1:-8}
  POINTS='[]'
  [ "${2:-}" = noprobe ] || pt "$(c $((N - 1)))" bisect completed failure 1 '["browser-shard"]' 590
}

# --- the gates before any bisecting ---
reset
d
check 'eight merges, nothing tested yet: the midpoint' "dispatch $(c 3)" "$out"
d '.attempt = 2'
check 'a push run someone re-ran by hand is bisected the same' "dispatch $(c 3)" "$out"
d '.conclusion = "success"'
check 'a pass is nothing to bisect' 'skip not-a-failure' "$out"
d '.conclusion = "timed_out"'
check 'a timeout is a failure' "dispatch $(c 3)" "$out"
d '.event = "workflow_dispatch"'
check 'only push runs are bisected' 'skip not-a-push-to-main' "$out"
d '.branch = "release/v1"'
check 'only main' 'skip not-a-push-to-main' "$out"
d '.newerGreen = true'
check 'main went green since: nothing to revert' 'skip main-recovered' "$out"
d '.good = null'
check 'no green run before it: no range' 'inconclusive no-green-run-before' "$out"
d '.range = null'
check 'an unreadable range' 'inconclusive range-unreadable' "$out"
d '.range |= .[:-1]'
check 'a range that does not end at H' 'inconclusive range-unreadable' "$out"
d '.workflowChanged = true'
check 'the workflow file changed since G' 'inconclusive workflow-changed' "$out"

# --- the probe of H: the first failure starts it, H is re-tested first ---
reset 8 noprobe
d
check 'first failure, nothing tested: re-test H itself, in a dispatched run' "dispatch $(c 7)" "$out"
pt "$(c 7)" bisect in_progress null 1 '[]' 590
d
check 'the probe of H in flight: wait' wait "$out"
reset 8 noprobe
pt "$(c 7)" bisect completed success 1 '[]' 590
d
check 'H passes on re-test: a flake, no culprit, no bisect' 'inconclusive head-passed-on-re-test' "$out"
reset 8 noprobe
pt "$(c 7)" bisect completed failure 1 '["first-run"]' 590
d
check 'H fails the re-test in another job: not the same break' 'inconclusive different-failure' "$out"
reset 8
d
check 'H fails the re-test in the same job: the bisect proceeds' "dispatch $(c 3)" "$out"
check 'the probe of H is never re-run (it is the second try)' no "$(grep -q '^rerun' <<<"$out" && echo yes || echo no)"
reset 8 noprobe
pt "$(c 7)" bisect completed cancelled 1 '[]' 590
d
check 'a cancelled probe of H' 'inconclusive bisect-run-cancelled' "$out"
reset 8 noprobe
d '.points[0].attempt = 2 | .points[0].families = ["browser-shard"]'
check 'a push run already failed twice needs no probe' "dispatch $(c 3)" "$out"
reset 1 noprobe
d
check 'one merge: re-test it' "dispatch $(c 0)" "$out"
reset 1
d
check 'one merge, failed again, G passed: it is the culprit' "culprit $(c 0) 100" "$out"
reset 1 noprobe
pt "$(c 0)" bisect completed success 1 '[]' 590
d
check 'one merge passing on re-test: a flake' 'inconclusive head-passed-on-re-test' "$out"
reset 17
d
check 'more than 16 merges: stop' 'inconclusive too-many-merges' "$out"
reset 16
d
check 'sixteen merges is still bisected' "dispatch $(c 7)" "$out"
check 'decide exits 0' 0 "$rc"

# --- a whole bisection: 8 merges, merge 5 broke it ---
reset 8
pt "$(c 3)" bisect in_progress null 1
d
check 'a bisect run in flight: wait' wait "$out"
reset 8
pt "$(c 3)" bisect completed success 1
d
check 'good at 3: look between 3 and 7' "dispatch $(c 5)" "$out"
pt "$(c 5)" bisect completed failure 1 '[]' 601
d
check 'a first failure is re-run, never trusted' 'rerun 601' "$out"
reset 8
pt "$(c 3)" bisect completed success 1
pt "$(c 5)" bisect queued null 2 '[]' 601
d
check 'the re-run in flight: wait' wait "$out"
reset 8
pt "$(c 3)" bisect completed success 1
pt "$(c 5)" bisect completed failure 2 '["browser-shard"]' 601
d
check 'bad at 5 after its re-run: look at 4' "dispatch $(c 4)" "$out"
pt "$(c 4)" bisect completed success 1
d
check 'good at 4, bad at 5: the culprit' "culprit $(c 5) 105" "$out"
check 'the probe of H plus three dispatches for eight merges' 4 "$(jq '[.points[] | select(.kind == "bisect") | .sha] | unique | length' "$tmp/f.json")"

# H itself is the culprit: its parent passed.
reset 8
pt "$(c 3)" bisect completed success 1
pt "$(c 5)" bisect completed success 1
pt "$(c 6)" bisect completed success 1
d
check 'the newest merge broke it' "culprit $(c 7) 107" "$out"

# The first merge broke it: G is the good side.
reset 4
pt "$(c 1)" bisect completed failure 2
pt "$(c 0)" bisect completed failure 2
d
check 'the oldest merge broke it' "culprit $(c 0) 100" "$out"

# A failed push run in the range, re-run once, counts as a bad point.
reset 8
pt "$(c 2)" push completed failure 2 '["browser-shard"]' 70
d
check 'a red push run inside the range narrows it' "dispatch $(c 0)" "$out"
reset 8
pt "$(c 2)" push completed failure 1 '[]' 70
d
check 'a push run not yet re-run is ignored' "dispatch $(c 3)" "$out"

# --- doubt stops it ---
reset 8
pt "$(c 3)" bisect completed failure 2
pt "$(c 5)" bisect completed success 1
d
check 'a pass after a failure: flaky, never a revert' 'inconclusive flaky' "$out"
reset 8
pt "$(c 3)" bisect completed success 1
pt "$(c 7)" bisect completed success 1 '[]' 591
d
check 'H passing on any bisect run: a flake' 'inconclusive head-passed-on-re-test' "$out"
reset 8
pt "$(c 3)" bisect completed failure 2 '["first-run"]'
d
check 'a different job failed: not the same break' 'inconclusive different-failure' "$out"
reset 8
pt "$(c 3)" bisect completed cancelled 1
d
check 'a cancelled bisect run' 'inconclusive bisect-run-cancelled' "$out"
reset 8
pt "$(c 5)" bisect completed success 1
pt "$(c 6)" bisect completed failure 2
d '.range[6].subject = "chore(release): v0.200.0 (#106)"'
check 'never the release commit' 'inconclusive culprit-is-the-release-commit' "$out"
reset 4
pt "$(c 0)" bisect completed failure 2
pt "$(c 1)" bisect completed failure 2
d '.range[0].subject = "Revert \"feat: x (#9)\""'
check 'a revert is never blamed' 'inconclusive culprit-is-a-revert' "$out"
d '.range[0].pr = 0'
check 'no merged PR behind the culprit' 'inconclusive no-merged-pr' "$out"

# Budget: ceil(log2(5)) = 3 below H; the probe of H does not count against
# it. Points from an earlier bisect count against it.
reset 5
pt "$(c 0)" bisect completed success 1
pt "$(c 1)" bisect completed success 1
pt "$(c 2)" bisect completed success 1
d
check 'three used of three, two merges left: budget exhausted' 'inconclusive budget-exhausted' "$out"
pt "$(c 3)" bisect completed failure 2
d
check 'but a range already down to one merge still names it' "culprit $(c 3) 103" "$out"

echo 'not json' >"$tmp/f.json"
"$SCRIPT" decide "$tmp/f.json" >/dev/null 2>&1
check 'unreadable facts: exit 2' 2 "$?"

# --- facts, through a stubbed gh ---
H=$(c 2)
cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
filter=.
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[$i]}" = --jq ] && filter=${args[$((i + 1))]}; done
case "$*" in
  *"/actions/runs/"*"/jobs"*)
    id=$(sed -n 's#.*/actions/runs/\([0-9]*\)/jobs.*#\1#p' <<<"$*")
    f=jobs-$id
    ;;
  *"/actions/runs/"*) f=run-$(sed -n 's#.*/actions/runs/\([0-9]*\).*#\1#p' <<<"$*") ;;
  *"event=push"*) f=pushes ;;
  *"event=workflow_dispatch"*) f=bisects ;;
  *"/compare/"*"...main"*) f=compare-main ;;
  *"/compare/"*) f=compare ;;
  *"/commits/"*"/pulls"*) f=pulls-$(sed -n 's#.*/commits/\([0-9a-f]*\)/pulls.*#\1#p' <<<"$*") ;;
  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;
esac
[ -f "$FX/$f" ] || { echo "stub gh: no fixture $f" >&2; exit 1; }
jq -r "$filter" "$FX/$f"
EOF
chmod +x "$tmp/gh"
fx=$tmp/fx
mkdir -p "$fx"
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" REPO=made-up/repo FX=$fx
run_json() { # id event sha attempt conclusion title
  jq -n --argjson id "$1" --arg e "$2" --arg s "$3" --argjson a "$4" --arg co "$5" --arg t "$6" \
    '{id: $id, run_attempt: $a, status: "completed", conclusion: $co, event: $e, head_branch: "main", head_sha: $s,
      workflow_id: 9, name: "browser-test", path: ".github/workflows/browser-test.yml",
      html_url: "https://example.invalid/run/\($id)", display_title: $t, created_at: "2026-11-24T05:00:00Z"}'
}
run_json 77 push "$H" 2 failure 'feat: merge 102 (#102)' >"$fx/run-77"
run_json 601 workflow_dispatch "$H" 1 success "bisect $(c 0) for run 77" >"$fx/run-601"
jq -n --arg g "$G" --arg h "$H" '{workflow_runs: [
  {id: 60, head_sha: $g, status: "completed", conclusion: "success", run_attempt: 1, created_at: "2026-11-24T03:00:00Z"},
  {id: 77, head_sha: $h, status: "completed", conclusion: "failure", run_attempt: 2, created_at: "2026-11-24T05:00:00Z"},
  {id: 80, head_sha: "8888888888888888888888888888888888888888", status: "in_progress", conclusion: null, run_attempt: 1, created_at: "2026-11-24T06:00:00Z"}]}' >"$fx/pushes"
jq -n --arg a "$(c 0)" --arg o "$(c 1)" '{workflow_runs: [
  {id: 601, display_title: "bisect \($a) for run 77", status: "completed", conclusion: "success", run_attempt: 1},
  {id: 650, display_title: "browser-test", status: "completed", conclusion: "failure", run_attempt: 1}]}' >"$fx/bisects"
# The compare lists the range in any order and includes a side commit off the
# first-parent chain, which the walk must leave out.
jq -n --arg g "$G" --arg a "$(c 0)" --arg b "$(c 1)" --arg h "$H" '{status: "ahead", commits: [
  {sha: $a, parents: [{sha: $g}], commit: {message: "feat: merge 100 (#100)\n\nbody"}},
  {sha: "5555555555555555555555555555555555555555", parents: [{sha: $a}], commit: {message: "side"}},
  {sha: $h, parents: [{sha: $b}, {sha: "5555555555555555555555555555555555555555"}], commit: {message: "feat: merge 102 (#102)"}},
  {sha: $b, parents: [{sha: $a}], commit: {message: "feat: merge 101 (#101)"}}]}' >"$fx/compare"
echo '{"files":[{"filename":"apps/client/x.ts"}]}' >"$fx/compare-main"
for i in 0 1 2; do echo "[{\"number\":$((100 + i)),\"merged_at\":\"2026-11-24T04:00:00Z\"}]" >"$fx/pulls-$(c $i)"; done
echo '{"jobs":[{"name":"browser-shard (3/6)","conclusion":"failure"},{"name":"browser-shard (1/6)","conclusion":"success"},{"name":"browser-test","conclusion":"failure"},{"name":"first-run","conclusion":"success"}]}' >"$fx/jobs-77"

: >"$GH_LOG"
"$SCRIPT" facts 77 >"$tmp/facts.json" 2>"$tmp/err"
check 'facts exits 0' 0 "$?"
cat "$tmp/err" >&2
check 'G is the last green push run before H' "$G" "$(jq -r .good "$tmp/facts.json")"
check 'the range is the first-parent chain, oldest first' "$(c 0) $(c 1) $H" "$(jq -r '[.range[].sha] | join(" ")' "$tmp/facts.json")"
check 'each merge carries its PR' '100 101 102' "$(jq -r '[.range[].pr] | join(" ")' "$tmp/facts.json")"
check 'subjects are first lines' 'feat: merge 100 (#100)' "$(jq -r '.range[0].subject' "$tmp/facts.json")"
check 'shard suffix and fan-in dropped from the families' '["browser-shard"]' "$(jq -c .originFamilies "$tmp/facts.json")"
check 'only titled bisect runs are points' '[601]' "$(jq -c '[.points[] | select(.kind == "bisect") | .id]' "$tmp/facts.json")"
check 'an unfinished push run is not a point' 'false' "$(jq '[.points[].id] | index(80) != null' "$tmp/facts.json")"
check 'the workflow file did not change' false "$(jq .workflowChanged "$tmp/facts.json")"
check 'no newer green run' false "$(jq .newerGreen "$tmp/facts.json")"
out=$("$SCRIPT" decide "$tmp/facts.json")
check 'facts feed decide end to end' "dispatch $(c 1)" "$out"
check 'facts makes no write call' no "$(grep -qE -- '--method|-X ' "$GH_LOG" && echo yes || echo no)"

# The first failure (attempt 1, never re-run): H is re-tested first, and the
# probe's failure is read as a bad point without a re-run.
run_json 77 push "$H" 1 failure 'feat: merge 102 (#102)' >"$fx/run-77"
jq '.workflow_runs |= map(if .id == 77 then .run_attempt = 1 else . end)' "$fx/pushes" >"$fx/p2" && mv "$fx/p2" "$fx/pushes"
"$SCRIPT" facts 77 >"$tmp/facts.json" 2>/dev/null
check 'first failure, end to end: re-test H' "dispatch $H" "$("$SCRIPT" decide "$tmp/facts.json")"
jq --arg h "$H" '.workflow_runs += [{id: 602, display_title: "bisect \($h) for run 77", status: "completed", conclusion: "failure", run_attempt: 1}]' \
  "$fx/bisects" >"$fx/b2" && mv "$fx/b2" "$fx/bisects"
echo '{"jobs":[{"name":"browser-shard (2/6)","conclusion":"failure"},{"name":"browser-test","conclusion":"failure"}]}' >"$fx/jobs-602"
"$SCRIPT" facts 77 >"$tmp/facts.json" 2>/dev/null
check 'the probe of H carries its failed families at attempt 1' '["browser-shard"]' "$(jq -c '[.points[] | select(.id == 602) | .families[]]' "$tmp/facts.json")"
check 'H failed again, end to end: the bisect proceeds' "dispatch $(c 1)" "$("$SCRIPT" decide "$tmp/facts.json")"

"$SCRIPT" facts 601 >"$tmp/facts2.json" 2>/dev/null
check 'a bisect run resolves to the run it bisects' 77 "$(jq .origin "$tmp/facts2.json")"

echo '{"files":[{"filename":".github/workflows/browser-test.yml"}]}' >"$fx/compare-main"
"$SCRIPT" facts 77 >"$tmp/facts.json" 2>/dev/null
check 'a changed workflow file is seen' true "$(jq .workflowChanged "$tmp/facts.json")"
echo '{"files":[]}' >"$fx/compare-main"

jq '.commits |= map(select(.sha != "'"$(c 1)"'"))' "$fx/compare" >"$fx/c2" && mv "$fx/c2" "$fx/compare"
"$SCRIPT" facts 77 >"$tmp/facts.json" 2>/dev/null
check 'a broken chain is no range' null "$(jq -c .range "$tmp/facts.json")"

rm "$fx/pushes"
"$SCRIPT" facts 77 >/dev/null 2>&1
check 'unreadable push runs: exit 2' 2 "$?"

"$SCRIPT" >/dev/null 2>&1
check 'no arguments is a usage error' 2 "$?"
"$SCRIPT" facts x >/dev/null 2>&1
check 'a bad run id is a usage error' 2 "$?"

echo "rolling-bisect fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
