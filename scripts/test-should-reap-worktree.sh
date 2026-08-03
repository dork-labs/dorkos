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
# tree goes back to 116 worktrees (research/20260801_worktree-and-branch-sweep.md).

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
  "recentlyActive": false,
  "isProtected": false,
  "ignoredFiles": 0,
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
# This is 47 of the 107 worktrees the 2026-08-01 sweep removed.
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

# The janitor emits this literal when it could not reach GitHub, or when the PR
# listing may have been truncated. It must never be confused with "NONE".
check "unknown PR state is not NONE" \
  "KEEP pr-state-unknown" '.prState = "UNKNOWN"'

check "an unrecognised PR state is not NONE either" \
  "KEEP pr-state-unknown" '.prState = "DRAFT"'

# (A *missing* prState is `unreadable-payload`, not `pr-state-unknown` — covered
# by the del(.prState) case in the required-field loop below. Absent and
# unrecognised are different failures and get different slugs.)

check "non-numeric localOnlyCommits" \
  "KEEP unreadable-payload" '.localOnlyCommits = "many"'

check "non-numeric dirtyFiles" \
  "KEEP unreadable-payload" '.dirtyFiles = "some"'

# --- a missing field is never a default -------------------------------------

# The hole this family closes: `//` treats null and false as empty, so the first
# version read a missing key, an explicit null, AND boolean false as "0", and
# supplied `existsOnOrigin: false` — the permissive half of rule 2 — on the
# caller's behalf. `{"prState":"NONE"}` answered REAP. Every required field gets
# a case here, or that regression comes back one key at a time.
for field in localOnlyCommits dirtyFiles ignoredFiles existsOnOrigin isCurrent recentlyActive isProtected prState branchSha; do
  check "missing $field is unreadable, not a default" \
    "KEEP unreadable-payload" "del(.$field)"
  check "null $field is unreadable, not a default" \
    "KEEP unreadable-payload" ".$field = null"
done

# jq reads `false // 0` as 0, so a boolean in a numeric slot used to mean "clean".
for field in localOnlyCommits dirtyFiles ignoredFiles; do
  check "boolean false in $field is unreadable" \
    "KEEP unreadable-payload" ".$field = false"
done

# The payload that asserted nothing at all and got REAP.
actual=$("$SUT" - <<<'{"prState":"NONE"}' 2>/dev/null)
if [[ "$actual" == "KEEP unreadable-payload" ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: a payload asserting nothing must not REAP"
  echo "  expected: KEEP unreadable-payload"
  echo "  actual:   $actual"
fi

# --- a co-tenant agent may be standing in it ---------------------------------

# Caught live on 2026-08-03: a peer session created a worktree mid-run and the
# plan listed it for deletion 46 seconds later. A brand-new worktree is the most
# reapable-LOOKING thing there is — no commits of its own, no PR, no branch on
# origin — which is rule 2 exactly. isCurrent only guards the janitor's OWN
# worktree and is no help against a co-tenant.
check "a worktree touched recently may have somebody in it" \
  "KEEP recently-active" '.recentlyActive = true'

# It has to outrank the reap rules, not just sit beside them.
check "recent activity outranks a merged PR at a matching tip" \
  "KEEP recently-active" '.recentlyActive = true'

check "recent activity outranks the review-scratch rule" \
  "KEEP recently-active" '.prState = "NONE" | .prHeadSha = "" | .localOnlyCommits = 0 | .recentlyActive = true'

# --- the worktree is a directory, not just a ref -----------------------------

# git status --porcelain never lists ignored files and `git worktree remove
# --force` deletes them: apps/server/.temp/.dork/ (dev SQLite) and a session
# handoff under .temp/ are both invisible to dirtyFiles.
check "non-regenerable ignored content outranks a merged PR" \
  "KEEP ignored-content" '.ignoredFiles = 1'

check "unmeasurable ignored content is unreadable" \
  "KEEP unreadable-payload" '.ignoredFiles = -1'

# --- the -1 sentinel the driver emits when git fails -------------------------

check "unmeasurable local-only count refuses" \
  "KEEP unreadable-payload" '.localOnlyCommits = -1'

check "unmeasurable dirty count refuses" \
  "KEEP unreadable-payload" '.dirtyFiles = -1'

# --- rule 1 sha guards (this pair caught a surviving mutant) ------------------

# Removing the `$sha != ""` guard from rule 1 left the suite green, because the
# existing case blanked only branchSha. Both blank collide as ""=="" and would
# REAP a payload that established nothing.
check "both shas blank must not collide into a match" \
  "KEEP unreadable-payload" '.branchSha = "" | .prHeadSha = ""'

check "merged with a blank prHeadSha only" \
  "KEEP commits-after-merge" '.prHeadSha = ""'

# --- the fallback that fires when the jq program itself dies -----------------

# Valid JSON that is not an object aborts the program (indexing an array with a
# string is a jq error, not a null), so the `-z "$verdict"` fallback at the
# bottom of the script is live code, not decoration. It was completely unpinned:
# changing it to `echo "REAP"` left the suite green while the mutant answered
# REAP to every one of these.
for doc in '[1,2]' '"a string"' '5' 'null' 'true'; do
  actual=$("$SUT" - <<<"$doc" 2>/dev/null)
  if [[ "$actual" == "KEEP unreadable-payload" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: JSON non-object payload $doc"
    echo "  expected: KEEP unreadable-payload"
    echo "  actual:   $actual"
  fi
done

# Two objects concatenated would otherwise print two verdicts, and a caller
# written as `grep -q REAP` would act on the wrong one.
actual=$(printf '{"prState":"OPEN"}\n{"prState":"NONE"}\n' | "$SUT" - 2>/dev/null)
if [[ "$actual" == "KEEP unreadable-payload" ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: a multi-document stream must not yield a usable verdict"
  echo "  actual: $actual"
fi

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
