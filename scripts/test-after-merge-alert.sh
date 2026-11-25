#!/usr/bin/env bash
# Fixture suite for scripts/after-merge-alert.sh (DOR-5121). A stubbed `gh`
# (GH=...) answers reads from fixture files, applies the script's own --jq
# filter, and logs every call, so writes can be asserted. Needs bash and jq.
#
#   bash scripts/test-after-merge-alert.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/after-merge-alert.sh
tmp=$(mktemp -d -t after-merge-alert-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
fx=$tmp/fx
mkdir -p "$fx"
pass=0
fail=0

# Reads map to fixture files; writes are logged and answer {"number": 900}.
# FAIL_ON=<substring> fails any call whose arguments contain it.
cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
[ -n "${FAIL_ON:-}" ] && [[ "$*" == *"$FAIL_ON"* ]] && exit 1
# Print a --jq result the way gh does: a string raw, a null as an empty line
# (`jq -r` alone prints "null"), anything else as compact JSON.
gh_jq() {
  jq -rc "($1
) | if . == null then \"\" else . end" "${@:2}"
}
filter=.
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [ "${args[$i]}" = --jq ] && filter=${args[$((i + 1))]}
done
case "$*" in
  *"--method"*) echo '{"number":900}' | gh_jq "$filter"; exit 0 ;;
  *"/actions/runs/77 "*|*"/actions/runs/77") f=run ;;
  *"/actions/workflows/"*) f=wfruns ;;
  *"/compare/"*) f=compare ;;
  *"/commits/"*"/pulls"*)
    c=$(sed -n 's#.*/commits/\([0-9a-f]*\)/pulls.*#\1#p' <<<"$*")
    if [ -f "$FX/pulls-$c" ]; then f=pulls-$c; else f=pulls; fi
    ;;
  *"/actions/runs/"*"/jobs"*) f=jobs ;;
  *"/issues/"*"/comments"*) f=comments ;;
  *"/issues?"*) f=issues ;;
  *"/labels/"*) f=label ;;
  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;
esac
[ -f "$FX/$f" ] || exit 1
gh_jq "$filter" "$FX/$f"
EOF
chmod +x "$tmp/gh"
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" REPO=made-up/repo FX=$fx

S=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
URL=https://example.invalid/run/77
reset() {
  echo '[{"number":12,"merged_at":"2026-11-23T10:00:00Z","user":{"login":"dev1"}}]' >"$fx/pulls"
  echo '{"jobs":[{"name":"Unit tests","conclusion":"failure"},{"name":"Lint","conclusion":"success"}]}' >"$fx/jobs"
  echo '[]' >"$fx/comments"
  echo '[]' >"$fx/issues"
  echo '{"name":"after-merge-failure"}' >"$fx/label"
}
out=""
rc=0
run() {
  : >"$GH_LOG"
  out=$("$SCRIPT" "$@" 2>&1)
  rc=$?
}
check() {
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n        output:   %s\n' "$1" "$2" "$3" "$out" >&2
  fi
}
has() { grep -qF -- "$2" <<<"$1" && echo yes || echo no; }
log() { cat "$GH_LOG"; }
count() { grep -cF -- "$1" "$GH_LOG"; }

reset
run failed 77 $S scripts-test $URL
check 'a failure exits 0' 0 "$rc"
check 'it comments on the merged PR' yes "$(has "$(log)" 'api --method POST repos/made-up/repo/issues/12/comments')"
check 'the comment names the author' yes "$(has "$(log)" '@dev1')"
check 'the comment carries the run marker' yes "$(has "$(log)" '<!-- after-merge-alert run=77 -->')"
check 'the comment names the failed job only' no "$(has "$(log)" 'Lint')"
check 'it opens one group issue' 1 "$(count 'repos/made-up/repo/issues -f title=')"
check 'titled by workflow and job' yes "$(has "$(log)" 'title=After merge: scripts-test / Unit tests fails on main')"
check 'assigned to the author' yes "$(has "$(log)" 'assignees[]=dev1')"
check 'labelled' yes "$(has "$(log)" 'labels[]=after-merge-failure')"

reset
printf '%s\n' '[{"id":5,"body":"<!-- after-merge-alert run=77 --> old"}]' >"$fx/comments"
run failed 77 $S scripts-test $URL
check 'a re-run of the alert does not comment twice' 0 "$(count 'issues/12/comments -f body')"

reset
echo '[{"number":40,"title":"After merge: scripts-test / Unit tests fails on main"}]' >"$fx/issues"
run failed 77 $S scripts-test $URL
check 'an open group gets a comment' yes "$(has "$(log)" 'api --method POST repos/made-up/repo/issues/40/comments')"
check 'and no second issue' 0 "$(count 'repos/made-up/repo/issues -f title=')"

reset
echo '[{"number":41,"title":"After merge: scripts-test / Unit tests fails on main","pull_request":{}}]' >"$fx/issues"
run failed 77 $S scripts-test $URL
check 'a PR with the same title is not a group issue' 1 "$(count 'repos/made-up/repo/issues -f title=')"

reset
echo '{"jobs":[{"name":"A","conclusion":"failure"},{"name":"B","conclusion":"timed_out"}]}' >"$fx/jobs"
run failed 77 $S scripts-test $URL
check 'each failed job is its own group' 2 "$(count 'repos/made-up/repo/issues -f title=')"

reset
echo '{"jobs":[]}' >"$fx/jobs"
run failed 77 $S scripts-test $URL
check 'no failed job: the workflow is the group' yes "$(has "$(log)" 'title=After merge: scripts-test / scripts-test fails on main')"

reset
echo '[]' >"$fx/pulls"
run failed 77 $S scripts-test $URL
check 'no merged PR: still exits 0' 0 "$rc"
check 'no merged PR: no PR comment' 0 "$(count 'comments -f body')"
check 'no merged PR: the issue still opens' 1 "$(count 'repos/made-up/repo/issues -f title=')"
check 'no merged PR: no assignee' no "$(has "$(log)" 'assignees')"

reset
echo '[{"number":12,"merged_at":"2026-11-23T10:00:00Z","user":{"login":"dependabot[bot]"}}]' >"$fx/pulls"
run failed 77 $S scripts-test $URL
check 'a bot author is not assigned' no "$(has "$(log)" 'assignees')"

reset
FAIL_ON='assignees' run failed 77 $S scripts-test $URL
check 'an unassignable author still gets the issue' 0 "$rc"
check 'retried without the assignee' yes "$(has "$(log)" 'labels[]=after-merge-failure --jq .number')"

reset
FAIL_ON='/pulls' run failed 77 $S scripts-test $URL
check 'an unreadable PR lookup is exit 2' 2 "$rc"

reset
run failed 77 abc scripts-test $URL
check 'a bad sha is a usage error' 2 "$rc"
run failed x $S scripts-test $URL
check 'a bad run id is a usage error' 2 "$rc"
run
check 'no arguments is a usage error' 2 "$rc"

reset
echo '[{"number":40,"title":"After merge: scripts-test / Unit tests fails on main"},{"number":42,"title":"After merge: db-check / db fails on main"}]' >"$fx/issues"
run passed scripts-test $URL
check 'green again closes that workflow s groups' yes "$(has "$(log)" 'api --method PATCH repos/made-up/repo/issues/40 -f state=closed')"
check 'and leaves other workflows open' no "$(has "$(log)" 'issues/42')"

reset
run passed scripts-test $URL
check 'green with nothing open is quiet' 0 "$rc"
check 'and writes nothing' 0 "$(count '--method')"


# --- ROLLING=1: a run that covers several merges (DOR-5130) ---
P1=1111111111111111111111111111111111111111
P2=2222222222222222222222222222222222222222
rolling() {
  reset
  echo '{"workflow_id":9,"created_at":"2026-11-24T05:00:00Z"}' >"$fx/run"
  echo "{\"workflow_runs\":[{\"id\":70,\"head_sha\":\"$P1\",\"created_at\":\"2026-11-24T04:00:00Z\"},{\"id\":77,\"head_sha\":\"$S\",\"created_at\":\"2026-11-24T05:00:00Z\"}]}" >"$fx/wfruns"
}
rolling
echo "{\"commits\":[{\"sha\":\"$P2\"},{\"sha\":\"$S\"}]}" >"$fx/compare"
echo '[{"number":30,"merged_at":"2026-11-24T04:30:00Z","user":{"login":"dev2"}}]' >"$fx/pulls-$P2"
ROLLING=1 run failed 77 $S browser-test $URL
check 'a rolling run over two merges exits 0' 0 "$rc"
check 'it comments on neither PR' 0 "$(count 'comments -f body=<!--')"
check 'the issue names both merges' yes "$(has "$(log)" '#12 (dev1), #30 (dev2)')"
check 'and the range' yes "$(has "$(log)" "${P1:0:7}..${S:0:7}")"
check 'it assigns nobody' no "$(has "$(log)" 'assignees')"
check 'it diffs from the previous push run' yes "$(has "$(log)" "compare/$P1...$S")"

rolling
echo "{\"commits\":[{\"sha\":\"$S\"}]}" >"$fx/compare"
ROLLING=1 run failed 77 $S browser-test $URL
check 'a rolling run over one merge comments on that PR' yes "$(has "$(log)" 'issues/12/comments -f body=<!--')"
check 'and assigns its author' yes "$(has "$(log)" 'assignees[]=dev1')"

rolling
echo '{"workflow_runs":[]}' >"$fx/wfruns"
ROLLING=1 run failed 77 $S browser-test $URL
check 'no previous run: exits 0' 0 "$rc"
check 'no previous run: blames nobody' 0 "$(count 'comments -f body=<!--')"
check 'and says so in the issue' yes "$(has "$(log)" 'Could not list the merges')"

reset
run failed 77 $S scripts-test $URL
check 'without ROLLING nothing reads the range' no "$(has "$(log)" '/compare/')"

# --- blame / note: a rolling failure bisected (DOR-5122) ---
reset
echo '[{"number":40,"title":"After merge: browser-test / browser-shard (3/6) fails on main"},{"number":42,"title":"After merge: db-check / db fails on main"}]' >"$fx/issues"
run blame 77 $S browser-test $URL
check 'blame exits 0' 0 "$rc"
check 'it comments on the culprit PR' yes "$(has "$(log)" 'api --method POST repos/made-up/repo/issues/12/comments')"
# shellcheck disable=SC2016 # the backticks are the comment's Markdown
check 'naming its author' yes "$(has "$(log)" '@dev1 `browser-test` failed on main in a rolling run')"
check 'with one marker per culprit' yes "$(has "$(log)" "<!-- after-merge-alert bisect=$S -->")"
check 'it says so on the workflow s group' yes "$(has "$(log)" 'api --method POST repos/made-up/repo/issues/40/comments')"
check 'and assigns the author there' yes "$(has "$(log)" 'issues/40/assignees -f assignees[]=dev1')"
check 'other workflows groups are untouched' no "$(has "$(log)" 'issues/42')"

reset
echo '[{"number":40,"title":"After merge: browser-test / browser-shard (3/6) fails on main"}]' >"$fx/issues"
printf '%s\n' "[{\"id\":5,\"body\":\"<!-- after-merge-alert bisect=$S -->\\nold\"}]" >"$fx/comments"
run blame 77 $S browser-test $URL
check 'a second blame of the same merge says nothing' 0 "$(count 'comments -f body')"

reset
echo '[]' >"$fx/pulls"
run blame 77 $S browser-test $URL
check 'no merged PR behind the culprit: exit 2' 2 "$rc"
run blame 77 abc browser-test $URL
check 'blame: a bad sha is a usage error' 2 "$rc"

reset
echo '[{"number":40,"title":"After merge: browser-test / first-run fails on main"}]' >"$fx/issues"
run note 77 browser-test $URL 'Bisect stopped without naming a merge (flaky).'
check 'note exits 0' 0 "$rc"
check 'note goes on the group' yes "$(has "$(log)" 'issues/40/comments -f body=<!-- after-merge-alert bisect-note run=77 -->')"
check 'with the reason' yes "$(has "$(log)" '(flaky)')"
check 'note blames nobody' no "$(has "$(log)" 'issues/12')"
printf '%s\n' '[{"id":5,"body":"<!-- after-merge-alert bisect-note run=77 --> x"}]' >"$fx/comments"
run note 77 browser-test $URL 'again'
check 'note says it once per run' 0 "$(count 'comments -f body')"
reset
run note 77 browser-test $URL 'nothing open'
check 'note with no open group is quiet' 0 "$(count '--method')"
run note 77 browser-test $URL
check 'note: missing text is a usage error' 2 "$rc"

echo "after-merge-alert fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
