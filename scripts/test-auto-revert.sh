#!/usr/bin/env bash
# Fixture suite for scripts/auto-revert.sh (DOR-5122). `decide` is pure; `facts`
# runs against a stubbed `gh` (GH=...) that answers from fixture files and logs
# every call; `revert` runs in a throwaway git repo with a bare origin. Needs
# bash, git and jq.
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

# A ROLLING run (one run for several merges): re-run first, before anything
# about its head commit, so rolling-bisect.yml (attempt >= 2 only) can start.
# Nov 25, 7878dda: `skip red-before-this-merge` at attempt 1 meant no bisect.
d '.workflow = "browser-test" | .rolling = true | .attempt = 1 | .parentConclusion = "none"'
check 'rolling, attempt 1, parent never ran: re-run' rerun "$out"
d '.workflow = "browser-test" | .rolling = true | .attempt = 1 | .parentConclusion = "failure"'
check 'rolling, attempt 1, parent red: re-run' rerun "$out"
d '.rolling = true | .attempt = 1 | .subject = "chore(release): v0.142.0 (#4200)"'
check 'rolling, attempt 1, at the release commit: still re-run (the bisect never blames it)' rerun "$out"
d '.rolling = true | .attempt = 1 | .pr = 0'
check 'rolling, attempt 1, no PR at the head: still re-run' rerun "$out"
d '.rolling = true | .attempt = 1 | .conclusion = "cancelled"'
check 'rolling, a cancel does nothing' 'skip not-a-failure' "$out"
d '.rolling = true | .attempt = 1 | .event = "workflow_dispatch"'
check 'rolling, a bisect (dispatch) run is never re-run here' 'skip not-a-push-to-main' "$out"
d '.rolling = true | .parentConclusion = "none"'
check 'rolling, attempt 2, parent never ran: skip (the bisect names the merge)' 'skip red-before-this-merge' "$out"
d '.rolling = true | .parentConclusion = "failure"'
check 'rolling, attempt 2, parent red: skip (the bisect names the merge)' 'skip red-before-this-merge' "$out"
d '.rolling = true'
check 'rolling, attempt 2, green parent: the merge is H, revert as before' "revert $S 12" "$out"
d '.rolling = false | .attempt = 1 | .parentConclusion = "none"'
check 'not rolling, attempt 1, parent never ran: skip, no re-run (as before)' 'skip red-before-this-merge' "$out"
d '.rolling = false | .attempt = 1 | .parentConclusion = "failure"'
check 'not rolling, attempt 1, parent red: skip, no re-run (as before)' 'skip red-before-this-merge' "$out"
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
echo "{\"run_attempt\":2,\"conclusion\":\"failure\",\"event\":\"push\",\"head_branch\":\"main\",\"head_sha\":\"$S\",\"workflow_id\":5,\"name\":\"db-check\"}" >"$tmp/fx/run"
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
check 'facts names the workflow' db-check "$(jq -r .workflow "$tmp/facts.json")"
check 'a non-rolling workflow is not rolling' false "$(jq -r .rolling "$tmp/facts.json")"
# The Nov 25 shape end to end: browser-test, attempt 1, the parent never ran.
jq '.run_attempt = 1 | .name = "browser-test"' "$tmp/fx/run" >"$tmp/fx/run.new" && mv "$tmp/fx/run.new" "$tmp/fx/run"
echo '{"workflow_runs":[]}' >"$tmp/fx/wfruns"
"$SCRIPT" facts 77 >"$tmp/facts.json" 2>"$tmp/err"
check 'browser-test is rolling' true "$(jq -r .rolling "$tmp/facts.json")"
check 'its parent never ran' none "$(jq -r .parentConclusion "$tmp/facts.json")"
check 'rolling facts at attempt 1 feed a re-run' rerun "$("$SCRIPT" decide "$tmp/facts.json")"

# --- the rolling list cannot drift from the workflows that act on it ---
rolling_list=$(sed -n "s/^ROLLING_WORKFLOWS='\(.*\)'$/\1/p" "$SCRIPT" | jq -c 'sort')
bisect_list=$(awk '/^on:/{on=1} on && /^  workflow_run:/{wr=1} wr && /^    workflows:/{print; exit}' \
  "$repo_root/.github/workflows/rolling-bisect.yml" |
  sed 's/^ *workflows: *//' | tr -d '[]' | tr ',' '\n' | sed 's/^ *//; s/ *$//' | sed '/^$/d' | jq -Rsc 'split("\n") | map(select(. != "")) | sort')
check 'ROLLING_WORKFLOWS is rolling-bisect.yml'"'"'s workflows:' "$bisect_list" "$rolling_list"
check 'the rolling list is not empty' yes "$([ "$(jq length <<<"$rolling_list")" -gt 0 ] && echo yes || echo no)"
ar_block=$(awk '/^    workflows:/{on=1} on{print} on && /\]/{exit}' "$repo_root/.github/workflows/auto-revert.yml")
alert_expr=$(grep -E '^ *ROLLING:' "$repo_root/.github/workflows/after-merge-alert.yml")
for w in $(jq -r '.[]' <<<"$rolling_list"); do
  check "rolling $w is in auto-revert.yml's workflows: (or it is never re-run)" yes \
    "$(grep -qE "^ *$w,?\$" <<<"$ar_block" && echo yes || echo no)"
  check "after-merge-alert.yml sets ROLLING=1 for $w" yes "$(grep -qF "== '$w'" <<<"$alert_expr" && echo yes || echo no)"
done
rm "$tmp/fx/main"
"$SCRIPT" facts 77 >/dev/null 2>&1
check 'an unreadable main is exit 2' 2 "$?"

# --- revert, in a real git repo with a bare origin and a stubbed gh ---
cat >"$tmp/gh2" <<'EOF2'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
case "$*" in
  "pr create"*) echo "https://example.invalid/pull/900" ;;
  "pr merge"*) ;;
  *"/pulls/"*) echo dev1 ;;
  *"--method POST"*) ;;
  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;
esac
EOF2
chmod +x "$tmp/gh2"
gitrepo() {
  rm -rf "$tmp/origin.git" "$tmp/wc"
  git init -q --bare -b main "$tmp/origin.git"
  git init -q -b main "$tmp/wc"
  (
    cd "$tmp/wc" || exit 1
    git config user.name t && git config user.email t@t.invalid && git config commit.gpgsign false
    echo a >a && git add a && git commit -qm 'feat: base (#1)'
    echo b >b && git add b && git commit -qm 'feat: the culprit (#12)'
    echo c >c && git add c && git commit -qm 'chore(release): v1.0.0 (#13)'
    echo d >d && git add d && git commit -qm 'feat: later (#14)'
    git remote add origin "$tmp/origin.git" && git push -q origin main
  )
}
rv() { # sha [ANYWHERE]
  : >"$GH_LOG"
  out=$(cd "$tmp/wc" && GH="$tmp/gh2" ANYWHERE=${2:-} "$SCRIPT" revert "$1" 12 browser-test https://example.invalid/run/77 2>&1)
  rc=$?
}
sha_of() { git -C "$tmp/wc" log --format=%H --grep="$1" -1; }
gitrepo
CUL=$(sha_of culprit)
rv "$CUL"
check 'main moved past it, not ANYWHERE: no revert' 0 "$rc"
check 'and nothing opened' 0 "$(grep -c 'pr create' "$GH_LOG")"
rv "$CUL" 1
check 'ANYWHERE: a merge main moved past is reverted' 0 "$rc"
check 'the revert branch is pushed' yes "$(git -C "$tmp/origin.git" rev-parse -q --verify "refs/heads/auto-revert/${CUL:0:12}" >/dev/null && echo yes || echo no)"
subj=$(git -C "$tmp/origin.git" log -1 --format=%s "auto-revert/${CUL:0:12}")
check 'the branch holds a revert of it' yes "$(grep -q '^Revert "feat: the culprit' <<<"$subj" && echo yes || echo no)"
check 'a PR is opened with auto-merge' 1 "$(grep -c 'pr merge https://example.invalid/pull/900 --repo made-up/repo --auto' "$GH_LOG")"
check 'the bisect wording' yes "$(grep -q 'a bisect found #12' "$GH_LOG" && echo yes || echo no)"
check 'the author is told' 1 "$(grep -c 'issues/12/comments' "$GH_LOG")"
git -C "$tmp/wc" switch -q main
rv "$CUL" 1
check 'a revert branch already there: not twice' 0 "$(grep -c 'pr create' "$GH_LOG")"
gitrepo
rv "$(sha_of 'release')" 1
check 'never the release commit' 0 "$(grep -c 'pr create' "$GH_LOG")"
check 'and says so' yes "$(grep -q 'release commit' <<<"$out" && echo yes || echo no)"
gitrepo
LATER=$(sha_of later)
rv "$LATER"
check 'at main head: the old path still reverts' 0 "$rc"
check 'with the old wording' yes "$(grep -q 'failed twice on main after #12' "$GH_LOG" && echo yes || echo no)"
gitrepo
rv cccccccccccccccccccccccccccccccccccccccc 1
check 'a sha not in the checkout: exit 1' 1 "$rc"
gitrepo
(cd "$tmp/wc" && echo b2 >b && git commit -qam 'feat: touches b (#15)' && git push -q origin main)
rv "$CUL" 1
check 'a revert that does not apply cleanly: exit 1' 1 "$rc"
check 'and nothing pushed' no "$(git -C "$tmp/origin.git" rev-parse -q --verify "refs/heads/auto-revert/${CUL:0:12}" >/dev/null && echo yes || echo no)"
"$SCRIPT" revert abc 12 wf url >/dev/null 2>&1
check 'a bad sha is a usage error' 2 "$?"

"$SCRIPT" >/dev/null 2>&1
check 'no arguments is a usage error' 2 "$?"
"$SCRIPT" facts x >/dev/null 2>&1
check 'a bad run id is a usage error' 2 "$?"

echo "auto-revert fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
