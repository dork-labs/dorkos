#!/usr/bin/env bash
# Fixture suite for scripts/should-reap-worktree.sh.
#
# The shape is deliberate and copied from test-should-arm-automerge.sh: start
# from ONE known-good payload and bend a single field per case, so a failure
# names the field that changed rather than just going red. The known-good here
# is a squash-merged branch whose tip is still the merged commit — the branch
# that SHOULD be reaped, and the only shape rule 1 accepts.
#
# Every KEEP slug the script can emit has a case below. That is the point of the
# suite: a refusal that quietly stops matching does not crash, it deletes a
# branch whose only copy was local. The two REAP cases are pinned for the
# opposite reason — a gate that reaps nothing gets switched off, and then the
# tree goes back to 116 worktrees.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SUT="$SCRIPT_DIR/should-reap-worktree.sh"

pass=0
fail=0

# A merged branch, untouched since it merged, no worktree changes. REAP.
GOOD='{
  "branch": "feat-composer-craft",
  "branchSha": "e3c1854043e731d1d91f4ffaa15da2f3b6842799",
  "prState": "MERGED",
  "prHeadSha": "e3c1854043e731d1d91f4ffaa15da2f3b6842799",
  "localOnlyCommits": 4,
  "dirtyFiles": 0,
  "isCurrent": false,
  "isProtected": false,
  "isDetached": false,
  "existsOnOrigin": false
}'

# check <name> <expected-verdict> <jq-mutation-applied-to-GOOD>
check() {
  local name=$1 expected=$2 mutation=$3
  local payload actual
  payload=$(jq -c "$mutation" <<<"$GOOD")
  actual=$("$SUT" - <<<"$payload" 2>/dev/null)
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $name"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    echo "  payload:  $payload"
  fi
}

# --- the two ways a reap is provably lossless -------------------------------

check "merged branch still at its merged tip" \
  "REAP" '.'

# The review-scratch case: no PR ever, but every commit is already on origin.
# This is 87 of the 116 worktrees the 2026-08-01 sweep found.
check "no PR but nothing local-only (review scratch)" \
  "REAP" '.prState = "NONE" | .prHeadSha = "" | .localOnlyCommits = 0'

check "detached review checkout fully on origin" \
  "REAP" '.prState = "NONE" | .prHeadSha = "" | .localOnlyCommits = 0 | .isDetached = true | .branch = ""'

# --- states a human is standing in ------------------------------------------

check "main is never reaped" \
  "KEEP protected-branch" '.isProtected = true'

check "the worktree we are running in is never reaped" \
  "KEEP current-worktree" '.isCurrent = true'

# Both dirty worktrees found on 2026-08-01 had a PR that was merged or closed;
# the uncommitted files were the only copy of that work.
check "uncommitted changes outrank a merged PR" \
  "KEEP uncommitted-changes" '.dirtyFiles = 6'

check "untracked-only changes still count as dirty" \
  "KEEP uncommitted-changes" '.dirtyFiles = 1'

# --- decisions that belong to a human ---------------------------------------

check "open PR" \
  "KEEP pr-open" '.prState = "OPEN"'

check "closed but never merged is stopped work, not safe work" \
  "KEEP pr-closed-unmerged" '.prState = "CLOSED"'

# --- the trap rule 1 exists to catch ----------------------------------------

check "commits pushed after the merge are not in main" \
  "KEEP commits-after-merge" '.branchSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'

check "merged PR with no branch sha is unreadable, not reapable" \
  "KEEP unreadable-payload" '.branchSha = ""'

# --- work that exists nowhere else ------------------------------------------

# investigate-site-dev-cpu survived the sweep on exactly this shape.
check "no PR and a commit of its own" \
  "KEEP unpushed-commits" '.prState = "NONE" | .prHeadSha = "" | .localOnlyCommits = 1'

# ci-browser-suite-gate (DOR-656): pushed, no PR, everything already on origin.
# Lossless to delete and still wrong — this is work in flight. The first version
# of the gate reaped it, which is why the case is pinned.
check "pushed branch with no PR yet is live work" \
  "KEEP pushed-no-pr" '.prState = "NONE" | .prHeadSha = "" | .localOnlyCommits = 0 | .existsOnOrigin = true'

# A caller that could not reach origin passes true, so it lands on the KEEP above
# rather than the REAP below it.
check "unknown origin state falls to the conservative side" \
  "KEEP pushed-no-pr" '.prState = "NONE" | .prHeadSha = "" | .localOnlyCommits = 0 | .existsOnOrigin = true | .isDetached = true'

# --- anything we could not establish ----------------------------------------

check "unknown PR state is not NONE" \
  "KEEP pr-state-unknown" '.prState = "UNKNOWN"'

check "missing PR state" \
  "KEEP pr-state-unknown" 'del(.prState)'

check "non-numeric localOnlyCommits" \
  "KEEP unreadable-payload" '.localOnlyCommits = "many"'

check "non-numeric dirtyFiles" \
  "KEEP unreadable-payload" '.dirtyFiles = "some"'

# --- malformed input --------------------------------------------------------

actual=$("$SUT" - <<<'not json at all' 2>/dev/null)
if [[ "$actual" == "KEEP unreadable-payload" ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: non-JSON payload"
  echo "  expected: KEEP unreadable-payload"
  echo "  actual:   $actual"
fi

# A malformed payload must exit 2, so a caller can tell "refused" from "crashed".
"$SUT" - <<<'not json at all' >/dev/null 2>&1
if [[ $? -eq 2 ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: non-JSON payload should exit 2"
fi

# A readable verdict must exit 0 even when it refuses, or the janitor cannot
# distinguish a KEEP from a broken gate.
"$SUT" - <<<"$(jq -c '.prState = "OPEN"' <<<"$GOOD")" >/dev/null 2>&1
if [[ $? -eq 0 ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: a readable KEEP should exit 0"
fi

# Missing argument is a usage error, not a verdict.
"$SUT" >/dev/null 2>&1
if [[ $? -eq 2 ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: missing argument should exit 2"
fi

echo
echo "should-reap-worktree: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
