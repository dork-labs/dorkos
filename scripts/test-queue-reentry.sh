#!/usr/bin/env bash
# Fixture suite for scripts/queue-reentry.sh, which puts a pull request back
# into the merge queue after the queue took it out
# (.github/workflows/queue-reentry.yml).
#
# Both ways it can be wrong are pinned. Turning auto-merge on when it should
# not undoes a person's dequeue or hold, or re-queues a head the queue keeps
# rejecting. Leaving it off when it should not is the idle pull request this
# exists to end. The sweep half runs against a stubbed `gh` (GH=...) that
# answers from files and logs every call, so nothing reaches GitHub.
#
#   bash scripts/test-queue-reentry.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/queue-reentry.sh

if ! command -v jq >/dev/null 2>&1; then
  echo "queue-reentry fixtures: needs jq on PATH" >&2
  exit 2
fi

tmp=$(mktemp -d -t queue-reentry-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0
out=""
rc=0

check() { # name, expected, actual
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n        output:   %s\n' \
      "$1" "$2" "$3" "$out" >&2
  fi
}
has() { grep -qF -- "$2" <<<"$1" && echo yes || echo no; }

# The required checks, from the real file so a renamed check is caught here.
REQ=$(jq -c '[.contexts[]]' "$repo_root/ci/required-checks.json")
HEAD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

# A pull request the queue took out at 12:00 for a failed check, whose head
# (pushed 10:00) is green on every required check and merges cleanly.
base() {
  jq -n --argjson req "$REQ" --arg head "$HEAD" '{
    id: "PR_node", number: 7, state: "OPEN", isDraft: false, baseRefName: "main",
    mergeable: "MERGEABLE", headRefOid: $head,
    autoMergeRequest: null, mergeQueueEntry: null,
    labels: {nodes: [{name: "review:deep"}]},
    labelEvents: {nodes: []},
    events: {nodes: [
      {__typename: "AutoMergeEnabledEvent", createdAt: "2026-11-24T09:00:00Z", actor: {login: "doriancollier"}},
      {__typename: "AddedToMergeQueueEvent", createdAt: "2026-11-24T11:00:00Z", actor: {login: "doriancollier"}},
      {__typename: "RemovedFromMergeQueueEvent", createdAt: "2026-11-24T12:00:00Z", reason: "failed_checks", actor: {login: "github-merge-queue"}}]},
    removals: {nodes: [
      {createdAt: "2026-11-24T12:00:00Z", reason: "failed_checks",
       beforeCommit: {checkSuites: {nodes: [{checkRuns: {nodes: [{name: "browser-test"}]}}]}}}]},
    commits: {nodes: [{commit: {oid: $head,
      checkSuites: {nodes: [{createdAt: "2026-11-24T10:00:00Z"}, {createdAt: "2026-11-24T10:05:00Z"}]},
      statusCheckRollup: {contexts: {totalCount: ($req | length + 1), nodes: (
        [$req[] | {__typename: "CheckRun", name: ., status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-24T10:01:00Z"}]
        + [{__typename: "StatusContext", context: "security-review", state: "PENDING", createdAt: "2026-11-24T10:01:00Z"}])}}}}]}
  }'
}

verdict_of() { # jq filter applied to base(), then the verdict
  base | jq "$1" >"$tmp/pr.json"
  out=$(bash "$SCRIPT" verdict "$tmp/pr.json" 2>&1)
  rc=$?
}

# Events helpers for the filters below.
BOT='{login: "github-merge-queue"}'
APP='{login: "dorkos-merge-tail"}'
ME='{login: "doriancollier"}'

# --- verdict ------------------------------------------------------------------

verdict_of '.'
check 'ejected by the queue, green and mergeable: auto-merge back on' ENABLE "$out"
check '... exit 0' 0 "$rc"

verdict_of ".events.nodes[2].actor = {login: \"github-merge-queue[bot]\"}"
check 'the REST spelling of the queue bot counts too' ENABLE "$out"

verdict_of ".events.nodes[2].actor = $ME"
check 'a person took it out of the queue: left alone' 'SKIP removed-by-hand' "$out"

verdict_of ".events.nodes[2].actor = $APP"
check 'queue-repeat-guard took it out (as the app): left alone' 'SKIP removed-by-hand' "$out"

verdict_of '.labels.nodes += [{name: "hold"}]'
check 'held: left alone' 'SKIP held' "$out"

verdict_of '.labels.nodes += [{name: "Do-Not-Merge"}]'
check 'do-not-merge, any case: left alone' 'SKIP held' "$out"

verdict_of '.labels.nodes += [{name: "hold"}] | .mergeable = "CONFLICTING"'
check 'held and conflicting: no comment either' 'SKIP held' "$out"

verdict_of '.mergeable = "CONFLICTING"'
check 'conflicting with main: ask the author' COMMENT "$out"

verdict_of '.mergeable = "UNKNOWN"'
check 'mergeability not computed yet: wait' 'SKIP mergeability-unknown' "$out"

verdict_of '(.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[] | select(.name == "lint") | .conclusion) = "FAILURE"'
check 'a required check failing: left alone' 'SKIP failing-checks' "$out"

verdict_of '(.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[] | select(.name == "test")) |= (.status = "IN_PROGRESS" | .conclusion = null)'
check 'a required check still running: a later sweep' 'SKIP checks-pending' "$out"

verdict_of 'del(.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[] | select(.name == "pr-gates"))
            | .commits.nodes[0].commit.statusCheckRollup.contexts.totalCount -= 1'
check 'a required check that never reported: not green' 'SKIP checks-pending' "$out"

verdict_of '(.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[] | select(.name == "browser-test") | .conclusion) = "SKIPPED"
            | (.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[] | select(.name == "db-check") | .conclusion) = "NEUTRAL"'
check 'skipped and neutral count as green, as GitHub counts them' ENABLE "$out"

verdict_of '.commits.nodes[0].commit.statusCheckRollup.contexts.nodes += [
              {__typename: "CheckRun", name: "not-held", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-24T09:00:00Z"}]'
check 'an older failed run of a check that later passed: green' ENABLE "$out"

verdict_of '.commits.nodes[0].commit.statusCheckRollup.contexts.nodes += [
              {__typename: "CheckRun", name: "not-held", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-24T11:00:00Z"}]'
check 'a newer failed run of a check that passed before: failing' 'SKIP failing-checks' "$out"

verdict_of '.commits.nodes[0].commit.statusCheckRollup.contexts.totalCount = 500'
check 'more check rows than were read: unknown' 'SKIP checks-unreadable' "$out"

verdict_of '.removals.nodes = [
  {createdAt: "2026-11-24T11:00:00Z", reason: "failed_checks", beforeCommit: {checkSuites: {nodes: [{checkRuns: {nodes: [{name: "browser-test"}]}}]}}},
  {createdAt: "2026-11-24T12:00:00Z", reason: "failed_checks", beforeCommit: {checkSuites: {nodes: [{checkRuns: {nodes: [{name: "browser-test"}]}}]}}}]'
check 'the head failed the same required check in two queue builds: left alone' 'SKIP repeat-queue-failure' "$out"

verdict_of '.removals.nodes = [
  {createdAt: "2026-11-24T11:00:00Z", reason: "failed_checks", beforeCommit: {checkSuites: {nodes: [{checkRuns: {nodes: [{name: "browser-test"}]}}]}}},
  {createdAt: "2026-11-24T12:00:00Z", reason: "failed_checks", beforeCommit: {checkSuites: {nodes: [{checkRuns: {nodes: [{name: "browser-test"}]}}]}}}]
  | .labels.nodes += [{name: "requeue-ok"}]
  | .labelEvents.nodes = [{createdAt: "2026-11-24T12:30:00Z", label: {name: "requeue-ok"}}]'
check 'a repeat with requeue-ok added after it: back in, as the guard would let it' ENABLE "$out"

verdict_of '.removals.nodes = [
  {createdAt: "2026-11-24T08:00:00Z", reason: "failed_checks", beforeCommit: {checkSuites: {nodes: [{checkRuns: {nodes: [{name: "browser-test"}]}}]}}},
  {createdAt: "2026-11-24T12:00:00Z", reason: "failed_checks", beforeCommit: {checkSuites: {nodes: [{checkRuns: {nodes: [{name: "browser-test"}]}}]}}}]'
check 'one of the two failures was on the old head: back in' ENABLE "$out"

verdict_of '.removals.nodes = [
  {createdAt: "2026-11-24T11:00:00Z", reason: "failed_checks", beforeCommit: {checkSuites: {nodes: [{checkRuns: {nodes: [{name: "browser-test"}]}}]}}},
  {createdAt: "2026-11-24T12:00:00Z", reason: "failed_checks", beforeCommit: {checkSuites: {nodes: [{checkRuns: {nodes: [{name: "browser-test"}]}}]}}}]
  | .commits.nodes[0].commit.checkSuites.nodes = []'
check 'no head push time, so the repeat rule cannot be read: left alone' 'SKIP head-unknown' "$out"

verdict_of ".events.nodes = [
  {__typename: \"AutoMergeEnabledEvent\", createdAt: \"2026-11-24T10:10:00Z\", actor: $APP},
  {__typename: \"AddedToMergeQueueEvent\", createdAt: \"2026-11-24T10:11:00Z\", actor: $APP},
  {__typename: \"RemovedFromMergeQueueEvent\", createdAt: \"2026-11-24T10:30:00Z\", reason: \"merge_conflict\", actor: $BOT},
  {__typename: \"AutoMergeEnabledEvent\", createdAt: \"2026-11-24T10:40:00Z\", actor: {login: \"dorkos-merge-tail[bot]\"}},
  {__typename: \"AddedToMergeQueueEvent\", createdAt: \"2026-11-24T10:41:00Z\", actor: $APP},
  {__typename: \"RemovedFromMergeQueueEvent\", createdAt: \"2026-11-24T12:00:00Z\", reason: \"failed_checks\", actor: $BOT}]"
check 'this head already put back twice by the workflow: left alone' 'SKIP reentered-twice' "$out"

verdict_of ".events.nodes = [
  {__typename: \"AutoMergeEnabledEvent\", createdAt: \"2026-11-24T08:10:00Z\", actor: $APP},
  {__typename: \"RemovedFromMergeQueueEvent\", createdAt: \"2026-11-24T08:30:00Z\", reason: \"merge_conflict\", actor: $BOT},
  {__typename: \"AutoMergeEnabledEvent\", createdAt: \"2026-11-24T08:40:00Z\", actor: $APP},
  {__typename: \"AddedToMergeQueueEvent\", createdAt: \"2026-11-24T11:00:00Z\", actor: $ME},
  {__typename: \"RemovedFromMergeQueueEvent\", createdAt: \"2026-11-24T12:00:00Z\", reason: \"failed_checks\", actor: $BOT}]"
check 'two re-entries of the OLD head do not count against a new one' ENABLE "$out"

verdict_of ".events.nodes = [
  {__typename: \"AutoMergeEnabledEvent\", createdAt: \"2026-11-24T10:10:00Z\", actor: $APP},
  {__typename: \"AddedToMergeQueueEvent\", createdAt: \"2026-11-24T10:11:00Z\", actor: $APP},
  {__typename: \"RemovedFromMergeQueueEvent\", createdAt: \"2026-11-24T12:00:00Z\", reason: \"failed_checks\", actor: $BOT}]"
check 'put back once on this head: one more try' ENABLE "$out"

verdict_of '.autoMergeRequest = {enabledAt: "2026-11-24T12:05:00Z"}'
check 'auto-merge already on: nothing to do' 'SKIP auto-merge-on' "$out"

verdict_of '.mergeQueueEntry = {state: "AWAITING_CHECKS"}'
check 'already in the queue: nothing to do' 'SKIP queued' "$out"

verdict_of ".events.nodes += [{__typename: \"AutoMergeEnabledEvent\", createdAt: \"2026-11-24T12:10:00Z\", actor: $ME},
                              {__typename: \"AutoMergeDisabledEvent\", createdAt: \"2026-11-24T12:20:00Z\", actor: $ME}]"
check 'someone turned auto-merge on and off since: theirs' 'SKIP auto-merge-changed-since' "$out"

verdict_of '.commits.nodes[0].commit.checkSuites.nodes = [{createdAt: "2026-11-24T13:00:00Z"}]'
check 'the author merged main after the removal and the new head is green: back in' ENABLE "$out"

verdict_of '.isDraft = true'
check 'a draft: left alone' 'SKIP draft' "$out"

verdict_of '.baseRefName = "feature/x"'
check 'not into main: left alone' 'SKIP base-not-main' "$out"

verdict_of '.events.nodes[2].reason = "merged"'
check 'a removal that is the merge itself is not an ejection' 'SKIP not-removed' "$out"

verdict_of ".events.nodes = [{__typename: \"AutoMergeEnabledEvent\", createdAt: \"2026-11-24T09:00:00Z\", actor: $ME}]"
check 'never queued: not this workflow'"'"'s' 'SKIP never-queued' "$out"

verdict_of 'del(.autoMergeRequest)'
check 'auto-merge state missing is not "off"' 'SKIP auto-merge-unknown' "$out"

verdict_of '.events = null'
check 'history unreadable: left alone' 'SKIP history-unknown' "$out"

verdict_of '.headRefOid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
check 'the checks read are not for the current head: left alone' 'SKIP head-unknown' "$out"

base >"$tmp/pr.json"
out=$(REQUIRED_CHECKS=$tmp/nowhere.json bash "$SCRIPT" verdict "$tmp/pr.json" 2>&1)
check 'no required-check list: left alone' 'SKIP required-checks-unknown' "$out"

echo 'not json' >"$tmp/bad.json"
out=$(bash "$SCRIPT" verdict "$tmp/bad.json" 2>&1)
rc=$?
check 'unreadable payload: a skip' 'SKIP unreadable-payload' "$out"
check '... exit 2' 2 "$rc"

out=$(bash "$SCRIPT" comment "$HEAD")
check 'the note carries the per-head marker' yes "$(has "$out" "<!-- queue-reentry head=$HEAD -->")"
check 'the note asks for a merge of main' yes "$(has "$out" "merge \`main\` into the branch")"
check 'the note says auto-merge comes back by itself' yes "$(has "$out" 'Auto-merge comes back on by itself')"

# --- sweep against a stubbed gh -------------------------------------------------

fix=$tmp/fix
mkdir -p "$fix"
cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
# Answers queue-reentry.sh's reads from $FIX and logs every call.
args="$*"
number=
for a in "$@"; do case "$a" in number=*) number=${a#number=} ;; esac; done
case "$1 $2" in
  "api graphql")
    if [[ "$args" == *mutation* ]]; then
      for a in "$@"; do case "$a" in id=*) id=${a#id=} ;; head=*) head=${a#head=} ;; esac; done
      echo "ENABLE $id $head" >>"$GH_LOG"
      [[ "${FAKE_FAIL:-}" == enable ]] && { echo "enable refused" >&2; exit 1; }
      echo '{"data":{}}'
    elif [[ -n "$number" ]]; then
      echo "DETAIL $number" >>"$GH_LOG"
      jq '{data: {repository: {pullRequest: .}}}' "$FIX/pr-$number.json"
    else
      echo "LIST" >>"$GH_LOG"
      [[ "${FAKE_FAIL:-}" == list ]] && { echo "HTTP 502" >&2; exit 1; }
      cat "$FIX/list.json"
    fi
    ;;
  "api --paginate")
    n=$(sed -E 's#.*/issues/([0-9]+)/comments.*#\1#' <<<"$3")
    echo "COMMENTS $n" >>"$GH_LOG"
    [[ "${FAKE_FAIL:-}" == comments ]] && exit 1
    cat "$FIX/comments-$n.txt" 2>/dev/null || :
    ;;
  "pr comment")
    n=$3
    echo "POST $n" >>"$GH_LOG"
    while [[ $# -gt 0 ]]; do [[ "$1" == --body-file ]] && cat "$2" >>"$FIX/comments-$n.txt"; shift; done
    ;;
  *) echo "stub gh: unexpected $args" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/gh"
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" FIX="$fix" REPO=made-up/repo REENTRY_RETRY_DELAY=0

# Three open pull requests: #1 green and ejected, #2 ejected and conflicting,
# #3 already has auto-merge on (the list read alone rules it out).
base | jq '.number = 1 | .id = "PR_1"' >"$fix/pr-1.json"
base | jq '.number = 2 | .id = "PR_2" | .mergeable = "CONFLICTING" | .headRefOid = "cccccccccccccccccccccccccccccccccccccccc"' >"$fix/pr-2.json"
base | jq '.number = 3 | .id = "PR_3" | .autoMergeRequest = {enabledAt: "x"}' >"$fix/pr-3.json"
jq -s '{data: {repository: {pullRequests: {pageInfo: {hasNextPage: false}, nodes: .}}}}' \
  "$fix/pr-1.json" "$fix/pr-2.json" "$fix/pr-3.json" >"$fix/list.json"

sweep() {
  : >"$GH_LOG"
  out=$(bash "$SCRIPT" sweep "$@" 2>&1)
  rc=$?
  log=$(cat "$GH_LOG")
}

sweep --dry-run
check 'dry run: exit 0' 0 "$rc"
check 'dry run: #1 would come back' yes "$(has "$out" 'PR #1 -> ENABLE (dry run')"
check 'dry run: #2 would be asked' yes "$(has "$out" 'PR #2 -> COMMENT (dry run')"
check 'dry run: nothing enabled' no "$(has "$log" ENABLE)"
check 'dry run: nothing posted' no "$(has "$log" POST)"

sweep
check 'sweep: exit 0' 0 "$rc"
check 'sweep: #1 auto-merge on, pinned to the head it judged' yes "$(has "$log" "ENABLE PR_1 $HEAD")"
check 'sweep: #2 asked once' 1 "$(grep -c '^POST 2$' <<<"$log")"
check 'sweep: the note carries #2'"'"'s head' yes "$(has "$(cat "$fix/comments-2.txt")" 'head=cccccccccccccccccccccccccccccccccccccccc')"
check 'sweep: #3 not read in detail' no "$(has "$log" 'DETAIL 3')"
check 'sweep: #2 never enabled' no "$(has "$log" 'ENABLE PR_2')"

sweep
check 'second sweep: no second note on the same head' no "$(has "$log" 'POST 2')"
check 'second sweep: says why' yes "$(has "$out" 'PR #2 -> SKIP conflict-already-told')"

jq '.headRefOid = "dddddddddddddddddddddddddddddddddddddddd"' "$fix/pr-2.json" >"$fix/x" && mv "$fix/x" "$fix/pr-2.json"
sweep
check 'a new head that still conflicts: asked again, once' 1 "$(grep -c '^POST 2$' <<<"$log")"

FAKE_FAIL=comments sweep
check 'comments unreadable: no note' no "$(has "$log" POST)"
check '... a warning' yes "$(has "$out" '::warning::queue-reentry: PR #2')"
check '... still exit 0' 0 "$rc"

FAKE_FAIL=enable sweep
check 'enable refused: a warning, not a red run' yes "$(has "$out" '::warning::queue-reentry: PR #1: could not turn auto-merge back on')"
check '... exit 0' 0 "$rc"

FAKE_FAIL=list sweep
check 'list unreadable: a warning' yes "$(has "$out" '::warning::queue-reentry: could not list open pull requests')"
check '... no detail reads' no "$(has "$log" DETAIL)"
check '... exit 0' 0 "$rc"

rm "$fix/pr-1.json"
sweep
check 'a pull request that cannot be read: a warning' yes "$(has "$out" '::warning::queue-reentry: PR #1: could not read the pull request')"
check '... exit 0' 0 "$rc"

base | jq '.number = 1 | .id = "PR_1" | .mergeable = "UNKNOWN"' >"$fix/pr-1.json"
sweep
check 'mergeability still unknown: asked three times, then left' 3 "$(grep -c '^DETAIL 1$' <<<"$log")"
check '... and not enabled' no "$(has "$log" 'ENABLE PR_1')"

out=$(REQUIRED_CHECKS=$tmp/nowhere.json bash "$SCRIPT" sweep 2>&1)
check 'no required-check list: a warning, nothing swept' yes "$(has "$out" '::warning::queue-reentry: could not read the required checks')"

out=$(REPO='' bash "$SCRIPT" sweep 2>&1)
rc=$?
check 'no REPO: a warning, exit 0' "yes 0" "$(has "$out" '::warning::') $rc"

echo
echo "queue-reentry fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
