#!/usr/bin/env bash
# Fixture suite for scripts/auto-revert.sh (DOR-5122). `decide` is pure; `facts`
# runs against a stubbed `gh` (GH=...) that answers from fixture files and logs
# every call. Needs bash and jq.
#
#   bash scripts/test-auto-revert.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/auto-revert.sh
tmp=$(mktemp -d -t auto-revert-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0
S=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
P=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

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
# base facts, then jq edits
d() {
  jq -n --arg s "$S" '{attempt: 2, conclusion: "failure", event: "push", branch: "main", sha: $s,
    subject: "fix(x): a thing (#12)", pr: 12, parentConclusion: "success", mainHead: $s, revertOpen: false}' |
    jq "${1:-.}" >"$tmp/f.json"
  out=$("$SCRIPT" decide "$tmp/f.json" 2>&1)
  rc=$?
}

d
check 'second failure, green parent, main still here: revert' "revert $S 12" "$out"
d '.attempt = 1'
check 'first failure: re-run once' rerun "$out"
d '.conclusion = "timed_out"'
check 'a timeout counts as a failure' "revert $S 12" "$out"
d '.conclusion = "success"'
check 'a pass does nothing' 'skip not-a-failure' "$out"
d '.conclusion = "cancelled"'
check 'a cancel does nothing' 'skip not-a-failure' "$out"
d '.subject = "chore(release): v0.142.0 (#4200)"'
check 'never the release commit' 'skip release-commit' "$out"
d '.subject = "chore(release): v0.142.0 (#4200)" | .attempt = 1'
check 'not even a re-run for the release commit' 'skip release-commit' "$out"
d '.subject = "Revert \"fix(x): a thing (#12)\""'
check 'never a revert of a revert' 'skip revert-commit' "$out"
d '.parentConclusion = "failure"'
check 'red before this merge: not its fault' 'skip red-before-this-merge' "$out"
d '.parentConclusion = "none"'
check 'parent never ran: no proof' 'skip red-before-this-merge' "$out"
d '.pr = 0'
check 'no merged PR: skip' 'skip no-merged-pr' "$out"
d '.mainHead = "cccccccccccccccccccccccccccccccccccccccc"'
check 'main moved on: skip (alerts still go out)' 'skip main-moved-on' "$out"
d '.revertOpen = true'
check 'a revert already open: skip' 'skip revert-already-open' "$out"
d '.event = "merge_group"'
check 'only pushes count' 'skip not-a-push-to-main' "$out"
d '.branch = "release/v1"'
check 'only main counts' 'skip not-a-push-to-main' "$out"
d '.sha = "abc"'
check 'a bad sha is skipped' 'skip bad-sha' "$out"
echo 'not json' >"$tmp/f.json"
out=$("$SCRIPT" decide "$tmp/f.json" 2>&1)
rc=$?
check 'unreadable facts: exit 2' 2 "$rc"

# --- facts, through a stubbed gh ---
cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
filter=.
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[$i]}" = --jq ] && filter=${args[$((i + 1))]}; done
case "$*" in
  *"/actions/runs/77"*) f=run ;;
  *"/commits/main"*) f=main ;;
  *"/commits/"*"/pulls"*) f=pulls ;;
  *"/commits/"*) f=commit ;;
  *"/actions/workflows/"*) f=wfruns ;;
  *"/pulls?"*) f=open ;;
  *) exit 1 ;;
esac
jq -r "$filter" "$FX/$f"
EOF
chmod +x "$tmp/gh"
mkdir -p "$tmp/fx"
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" REPO=made-up/repo FX=$tmp/fx
echo "{\"run_attempt\":2,\"conclusion\":\"failure\",\"event\":\"push\",\"head_branch\":\"main\",\"head_sha\":\"$S\",\"workflow_id\":5}" >"$tmp/fx/run"
printf "%s\n" "{\"parents\":[{\"sha\":\"$P\"}],\"commit\":{\"message\":\"fix(x): a thing (#12)\\n\\nbody\"}}" >"$tmp/fx/commit"
echo '[{"number":12,"merged_at":"2026-11-23T10:00:00Z"}]' >"$tmp/fx/pulls"
echo '{"workflow_runs":[{"status":"completed","conclusion":"failure","updated_at":"2026-11-23T09:00:00Z"},{"status":"completed","conclusion":"success","updated_at":"2026-11-23T09:30:00Z"}]}' >"$tmp/fx/wfruns"
echo "{\"sha\":\"$S\"}" >"$tmp/fx/main"
echo '[]' >"$tmp/fx/open"
: >"$GH_LOG"
"$SCRIPT" facts 77 >"$tmp/facts.json" 2>"$tmp/err"
check 'facts exits 0' 0 "$?"
out=$("$SCRIPT" decide "$tmp/facts.json")
check 'facts feed decide end to end' "revert $S 12" "$out"
check 'the parent newest attempt wins' success "$(jq -r .parentConclusion "$tmp/facts.json")"
check 'the subject is the first line only' 'fix(x): a thing (#12)' "$(jq -r .subject "$tmp/facts.json")"
check 'it reads the parent runs of the same workflow' yes "$(grep -qF "workflows/5/runs?head_sha=$P&event=push" "$GH_LOG" && echo yes || echo no)"
check 'facts makes no write call' no "$(grep -qE -- '--method|-X ' "$GH_LOG" && echo yes || echo no)"
rm "$tmp/fx/main"
"$SCRIPT" facts 77 >/dev/null 2>&1
check 'an unreadable main is exit 2' 2 "$?"

"$SCRIPT" >/dev/null 2>&1
check 'no arguments is a usage error' 2 "$?"
"$SCRIPT" facts x >/dev/null 2>&1
check 'a bad run id is a usage error' 2 "$?"

echo "auto-revert fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
