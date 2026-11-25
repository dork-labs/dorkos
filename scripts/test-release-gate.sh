#!/usr/bin/env bash
# The single-quoted jq programs below name jq variables ($p, $x), not shell ones.
# shellcheck disable=SC2016
# Fixture suite for scripts/release-gate.sh (DOR-5123). `decide` is pure; `facts`
# runs against a stubbed `gh` (GH=...) that answers from fixture files and logs
# every call. Needs bash and jq.
#
#   bash scripts/test-release-gate.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/release-gate.sh
tmp=$(mktemp -d -t release-gate-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0
P=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
X=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
H=cccccccccccccccccccccccccccccccccccccccc
Q=dddddddddddddddddddddddddddddddddddddddd
export RELEASE_GATE_RETRY_SLEEP=0

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
# Base facts: P (#42) then X then H on main, a green push run of browser-test
# on P, and both required contexts green in P's merge-queue build (suite 7).
d() {
  jq -n --arg p "$P" --arg x "$X" --arg h "$H" '{
    version: "0.150.0", p: $p, mainHead: $h, unreadable: [],
    compare: {status: "ahead", ahead_by: 2, behind_by: 0, commits: [
      {sha: $x, parents: [$p], message: "fix(y): another thing (#43)"},
      {sha: $h, parents: [$x], message: "feat(z): more (#44)\n\nmentions #42 in passing"}]},
    pSubject: "fix(x): a thing (#42)", pr: 42, revertPrOpen: false,
    fullRuns: {workflows: ["browser-test.yml"], events: ["push", "schedule"], runs: [
      {workflow: "browser-test.yml", id: 10, event: "push", status: "completed", conclusion: "success",
       head_sha: $p, head_branch: "main", created_at: "2026-11-23T10:00:00Z"}]},
    required: ["typecheck", "browser-test"],
    checkRuns: [
      {id: 100, name: "typecheck", status: "completed", conclusion: "success", app_id: 15368, suite: 7},
      {id: 101, name: "browser-test", status: "completed", conclusion: "success", app_id: 15368, suite: 7}],
    suites: [{id: 7, head_branch: "gh-readonly-queue/main/pr-42-1234", app_id: 15368},
             {id: 8, head_branch: "main", app_id: 15368}]}' |
    jq --arg p "$P" --arg x "$X" --arg h "$H" --arg q "$Q" "${1:-.}" >"$tmp/f.json"
  out=$("$SCRIPT" decide "$tmp/f.json" 2>&1)
  rc=$?
}
p12=${P:0:12}

d
check 'everything holds: ship' SHIP "$out"
check 'a decision exits 0' 0 "$rc"
d '.mainHead = $p | .compare = {status: "identical", ahead_by: 0, behind_by: 0, commits: []}'
check 'P is main head itself: ship' SHIP "$out"
d '.version = "1.2"'
check 'a bad version refuses' 'REFUSE bad version' "$out"
d '.p = "abc"'
check 'a bad P refuses' 'REFUSE bad P sha' "$out"

# --- unreadable reads refuse ---
d '.unreadable = ["check runs", "main history"]'
check 'any unreadable read refuses, naming it' 'REFUSE unreadable: check runs, main history' "$out"
d 'del(.unreadable)'
check 'facts with no unreadable list refuse' 'REFUSE unreadable: facts' "$out"
d '.mainHead = null'
check 'no main head refuses' 'REFUSE unreadable: main head' "$out"
echo 'not json' >"$tmp/f.json"
out=$("$SCRIPT" decide "$tmp/f.json" 2>&1)
check 'unreadable facts file: exit 2' 2 "$?"
"$SCRIPT" decide "$tmp/missing.json" >/dev/null 2>&1
check 'missing facts file: exit 2' 2 "$?"

# --- 1. on main, first parent, not reverted ---
d '.compare.status = "diverged" | .compare.behind_by = 3'
check 'P not an ancestor of main refuses' "REFUSE P $p12 is not on main (compare says diverged)" "$out"
d '.compare.behind_by = 1'
check 'main behind P refuses' "REFUSE P $p12 is not on main (compare says ahead)" "$out"
d '.compare.ahead_by = 300'
check 'a short history read refuses' 'REFUSE main history read incomplete (2 of 300 commits)' "$out"
d '.compare.commits[0].parents = [$q, $p]'
check 'P only on a side branch (second parent) refuses' "REFUSE P $p12 is not on main first-parent history" "$out"
d ".compare.commits[1].message = \"Revert \\\"fix(x): a thing (#42)\\\" (#45)\\n\\nThis reverts commit $P.\""
check 'a revert naming P refuses' "REFUSE P $p12 (#42) was reverted on main by ${H:0:12}" "$out"
d '.compare.commits[0].message = "revert: the thing\n\nReverts \($p) because it broke main."'
check 'a hand-written revert naming P refuses' "REFUSE P $p12 (#42) was reverted on main by ${X:0:12}" "$out"
d '.compare.commits[0].message = "Revert \"fix(x): a thing (#42)\" (#45)"'
check 'a GitHub revert of P subject refuses' "REFUSE P $p12 (#42) was reverted on main by ${X:0:12}" "$out"
d '.compare.commits[0].message = "Revert #42: test failed on main (auto-revert) (#45)"'
check 'an auto-revert of P PR refuses' "REFUSE P $p12 (#42) was reverted on main by ${X:0:12}" "$out"
d '.compare.commits[0].message = "Revert #420: test failed on main (auto-revert) (#45)"'
check 'a revert of #420 is not a revert of #42' SHIP "$out"
d '.compare.commits[0].message = "fix: follow up on #42 (#45)"'
check 'a later PR naming #42 without reverting it ships' SHIP "$out"
d '.revertPrOpen = true'
check 'an open auto-revert PR for P refuses' "REFUSE an auto-revert PR is open for P $p12" "$out"
d '.revertPrOpen = null'
check 'an unknown auto-revert state refuses' "REFUSE an auto-revert PR is open for P $p12" "$out"

# --- 2. P own full run ---
d '.fullRuns.runs = []'
check 'no full run on P refuses' "REFUSE no completed full browser-test.yml run on P $p12 from push/schedule on main" "$out"
d '.fullRuns.runs[0].event = "merge_group" | .fullRuns.runs[0].head_branch = "gh-readonly-queue/main/pr-42-1"'
check 'the queue run is not the rolling full run' "REFUSE no completed full browser-test.yml run on P $p12 from push/schedule on main" "$out"
d '.fullRuns.runs[0].head_branch = "release/v0.150.0"'
check 'a push run off main does not count' "REFUSE no completed full browser-test.yml run on P $p12 from push/schedule on main" "$out"
d '.fullRuns.runs[0].head_sha = $x'
check 'a run on another commit does not count' "REFUSE no completed full browser-test.yml run on P $p12 from push/schedule on main" "$out"
d '.fullRuns.runs[0].status = "in_progress" | .fullRuns.runs[0].conclusion = null'
check 'a run still going does not count' "REFUSE no completed full browser-test.yml run on P $p12 from push/schedule on main" "$out"
d '.fullRuns.runs[0].conclusion = "failure"'
check 'a red full run refuses' 'REFUSE the newest full browser-test.yml run on P (10) concluded failure' "$out"
d '.fullRuns.runs += [.fullRuns.runs[0] | .id = 11 | .event = "schedule" | .conclusion = "cancelled" | .created_at = "2026-11-23T12:00:00Z"]'
check 'the newest completed run decides, even over an older green one' 'REFUSE the newest full browser-test.yml run on P (11) concluded cancelled' "$out"
d '.fullRuns.runs = [(.fullRuns.runs[0] | .id = 9 | .conclusion = "failure" | .created_at = "2026-11-23T08:00:00Z")] + .fullRuns.runs'
check 'a green run newer than a red one ships' SHIP "$out"
d '.fullRuns.runs += [.fullRuns.runs[0] | .id = 12 | .status = "in_progress" | .conclusion = null | .created_at = "2026-11-23T13:00:00Z"]'
check 'a newer run still going does not hide the completed one' SHIP "$out"
d '.fullRuns.workflows += ["unit-full.yml"]'
check 'every configured full-run workflow must have run' "REFUSE no completed full unit-full.yml run on P $p12 from push/schedule on main" "$out"
d '.fullRuns.workflows = []'
check 'no full-run workflow configured refuses' 'REFUSE no full-run workflow configured' "$out"

# --- 3. required checks from P merge-queue build ---
d '.required += ["lint"]'
check 'a required context with no run refuses' "REFUSE required check lint has no merge-queue run on P $p12" "$out"
d '.checkRuns[0].suite = 8'
check 'a push run on main is not the queue build' "REFUSE required check typecheck has no merge-queue run on P $p12" "$out"
d '.checkRuns[0].app_id = 999'
check 'a check run from another app does not count' "REFUSE required check typecheck has no merge-queue run on P $p12" "$out"
d '.checkRuns[1].conclusion = "failure"'
check 'a red required check refuses' 'REFUSE required check browser-test on P merge-queue build is failure' "$out"
d '.checkRuns[1].status = "in_progress" | .checkRuns[1].conclusion = null'
check 'a pending required check refuses' 'REFUSE required check browser-test on P merge-queue build is in_progress' "$out"
d '.checkRuns[1].conclusion = "neutral"'
check 'neutral is not a pass' 'REFUSE required check browser-test on P merge-queue build is neutral' "$out"
d '.checkRuns[1].conclusion = "skipped"'
check 'skipped passes, as the queue counts it' SHIP "$out"
d '.checkRuns = [(.checkRuns[0] | .id = 90 | .conclusion = "failure")] + .checkRuns'
check 'the latest attempt in a build decides' SHIP "$out"
d '.checkRuns += [(.checkRuns[0] | .id = 200 | .conclusion = "failure")]'
check 'a later red attempt refuses' 'REFUSE required check typecheck on P merge-queue build is failure' "$out"
d '.checkRuns += [(.checkRuns[0] | .id = 300 | .suite = 8 | .conclusion = "failure")]'
check 'a red push run of the same name is not this gate' SHIP "$out"
d '.required = []'
check 'an empty required list refuses' 'REFUSE main required-checks list is empty' "$out"
d '.suites = null'
check 'no suites read refuses' "REFUSE required check typecheck has no merge-queue run on P $p12" "$out"

# --- facts, through a stubbed gh ---
cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
# Print a --jq result the way gh does: a string raw, a null as an empty line
# (`jq -r` alone prints "null"), anything else as compact JSON.
gh_jq() {
  jq -rc "($1
) | if . == null then \"\" else . end" "${@:2}"
}
filter=.
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[$i]}" = --jq ] && filter=${args[$((i + 1))]}; done
case "$*" in
  *"/commits/main"*) f=main ;;
  *"/compare/"*) f=compare ;;
  *"/contents/ci/required-checks.json"*) f=contents ;;
  *"/check-runs"*) f=checkruns ;;
  *"/check-suites"*) f=suites ;;
  *"/commits/"*"/pulls"*) f=pulls ;;
  *"/commits/"*) f=commit ;;
  *"/pulls?"*) f=open ;;
  *"/actions/workflows/"*) all="$*" && w=${all#*/actions/workflows/} && f=runs-${w%%/*} ;;
  *) exit 1 ;;
esac
[ -f "$FX/$f" ] || exit 1
gh_jq "$filter" "$FX/$f"
EOF
chmod +x "$tmp/gh"
fx=$tmp/fx
mkdir -p "$fx"
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" REPO=made-up/repo FX=$fx
echo "{\"sha\":\"$H\"}" >"$fx/main"
# Two pages, as `gh api --paginate` hands them to --jq.
jq -nc --arg p "$P" --arg x "$X" '{status: "ahead", ahead_by: 2, behind_by: 0,
  commits: [{sha: $x, parents: [{sha: $p}], commit: {message: "fix(y): another (#43)"}}]}' >"$fx/compare"
jq -nc --arg x "$X" --arg h "$H" '{status: "ahead", ahead_by: 2, behind_by: 0,
  commits: [{sha: $h, parents: [{sha: $x}], commit: {message: "feat(z): more (#44)"}}]}' >>"$fx/compare"
jq -nc --arg c "$(printf '{"ruleset":1,"contexts":["typecheck","browser-test"]}\n' | base64 | tr -d '\n')" \
  '{content: ($c | .[0:20] + "\n" + .[20:])}' >"$fx/contents"
printf '%s\n' '{"commit":{"message":"fix(x): a thing (#42)\n\nbody"}}' >"$fx/commit"
echo '[{"number":41,"merged_at":null},{"number":42,"merged_at":"2026-11-23T09:00:00Z"}]' >"$fx/pulls"
echo '[]' >"$fx/open"
jq -nc --arg p "$P" '{total_count: 2, workflow_runs: [
  {id: 10, event: "push", status: "completed", conclusion: "success", head_sha: $p, head_branch: "main",
   created_at: "2026-11-23T10:00:00Z", path: ".github/workflows/browser-test.yml"},
  {id: 5, event: "merge_group", status: "completed", conclusion: "success", head_sha: $p,
   head_branch: "gh-readonly-queue/main/pr-42-1", created_at: "2026-11-23T09:00:00Z", path: ".github/workflows/browser-test.yml"}]}' \
  >"$fx/runs-browser-test.yml"
jq -nc '{total_count: 3, check_runs: [
  {id: 100, name: "typecheck", status: "completed", conclusion: "success", app: {id: 15368}, check_suite: {id: 7}},
  {id: 101, name: "browser-test", status: "completed", conclusion: "success", app: {id: 15368}, check_suite: {id: 7}}]}' >"$fx/checkruns"
jq -nc '{total_count: 3, check_runs: [
  {id: 102, name: "db-check", status: "completed", conclusion: "success", app: {id: 15368}, check_suite: {id: 8}}]}' >>"$fx/checkruns"
jq -nc '{total_count: 2, check_suites: [{id: 7, head_branch: "gh-readonly-queue/main/pr-42-1", app: {id: 15368}},
  {id: 8, head_branch: "main", app: {id: 15368}}]}' >"$fx/suites"

: >"$GH_LOG"
"$SCRIPT" facts 0.150.0 "$P" >"$tmp/facts.json" 2>"$tmp/err"
check 'facts exits 0' 0 "$?"
out=$("$SCRIPT" decide "$tmp/facts.json")
check 'facts feed decide end to end' SHIP "$out"
check 'nothing unreadable' '[]' "$(jq -c .unreadable "$tmp/facts.json")"
check 'the merged PR is P PR' 42 "$(jq -r .pr "$tmp/facts.json")"
check 'the subject is the first line only' 'fix(x): a thing (#42)' "$(jq -r .pSubject "$tmp/facts.json")"
check 'both history pages are read' "$X $H" "$(jq -r '[.compare.commits[].sha] | join(" ")' "$tmp/facts.json")"
check 'required contexts come from main copy' 'typecheck,browser-test' "$(jq -r '.required | join(",")' "$tmp/facts.json")"
check 'it reads main required checks at the head it compared' yes "$(grep -qF "contents/ci/required-checks.json?ref=$H" "$GH_LOG" && echo yes || echo no)"
check 'it compares P to that same head' yes "$(grep -qF "compare/$P...$H" "$GH_LOG" && echo yes || echo no)"
check 'it reads only GitHub Actions check runs' yes "$(grep -qF "check-runs?app_id=15368" "$GH_LOG" && echo yes || echo no)"
check 'it looks for P own auto-revert branch' yes "$(grep -qF "head=made-up:auto-revert/${P:0:12}" "$GH_LOG" && echo yes || echo no)"
check 'facts makes no write call' no "$(grep -qE -- '--method|-X |-f |--field|--input' "$GH_LOG" && echo yes || echo no)"

FULL_RUN_WORKFLOWS='browser-test.yml unit-full.yml' "$SCRIPT" facts 0.150.0 "$P" >"$tmp/facts.json" 2>/dev/null
check 'an unreadable extra full-run workflow is named' '["unit-full.yml runs"]' "$(jq -c .unreadable "$tmp/facts.json")"
check '... and refuses' 'REFUSE unreadable: unit-full.yml runs' "$("$SCRIPT" decide "$tmp/facts.json")"

mv "$fx/checkruns" "$fx/checkruns.ok"
jq -c '.total_count = 9' "$fx/checkruns.ok" >"$fx/checkruns"
: >"$GH_LOG"
"$SCRIPT" facts 0.150.0 "$P" >"$tmp/facts.json" 2>/dev/null
check 'a check-run list that does not add up is unreadable' 'REFUSE unreadable: check runs' "$("$SCRIPT" decide "$tmp/facts.json")"
check 'it is read three times before giving up' 3 "$(grep -c 'check-runs' "$GH_LOG" | tr -d ' ')"
mv "$fx/checkruns.ok" "$fx/checkruns"

echo '{"content":"bm90IGpzb24K"}' >"$fx/contents.bad"
mv "$fx/contents" "$fx/contents.ok" && mv "$fx/contents.bad" "$fx/contents"
"$SCRIPT" facts 0.150.0 "$P" >"$tmp/facts.json" 2>/dev/null
check 'an unparseable required-checks file refuses' 'REFUSE unreadable: required checks' "$("$SCRIPT" decide "$tmp/facts.json")"
mv "$fx/contents.ok" "$fx/contents"

mv "$fx/main" "$fx/main.ok"
"$SCRIPT" facts 0.150.0 "$P" >"$tmp/facts.json" 2>/dev/null
check 'an unreadable main still writes facts' 0 "$?"
check '... that refuse on it' 'REFUSE unreadable: main head' "$("$SCRIPT" decide "$tmp/facts.json")"
mv "$fx/main.ok" "$fx/main"

mv "$fx/pulls" "$fx/pulls.ok"
"$SCRIPT" facts 0.150.0 "$P" >"$tmp/facts.json" 2>/dev/null
check 'an unreadable PR lookup refuses' 'REFUSE unreadable: P pull request' "$("$SCRIPT" decide "$tmp/facts.json")"
mv "$fx/pulls.ok" "$fx/pulls"

# --- usage ---
"$SCRIPT" >/dev/null 2>&1
check 'no arguments is a usage error' 2 "$?"
"$SCRIPT" facts 1.2 "$P" >/dev/null 2>&1
check 'a bad version is a usage error' 2 "$?"
"$SCRIPT" facts 0.150.0 abc >/dev/null 2>&1
check 'a short P is a usage error' 2 "$?"
"$SCRIPT" facts 0.150.0 >/dev/null 2>&1
check 'a missing P is a usage error' 2 "$?"
"$SCRIPT" decide >/dev/null 2>&1
check 'decide with no file is a usage error' 2 "$?"
"$SCRIPT" ship 0.150.0 "$P" >/dev/null 2>&1
check 'an unknown command is a usage error' 2 "$?"

echo "release-gate fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
