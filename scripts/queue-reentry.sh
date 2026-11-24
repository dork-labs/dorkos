#!/usr/bin/env bash
# Puts a pull request back into the merge queue after the queue itself took it
# out, once it is green and merges cleanly again (DOR-5098).
#
# Why this exists: when the merge queue removes a pull request (a check failed
# in the group build, it conflicted with an entry ahead of it, or `main` was
# red), GitHub turns its auto-merge off and nothing turns it back on. Since PRs
# auto-merge from the moment they open (scripts/open-pr.sh) nobody re-arms
# them, so an ejected pull request sat idle: on 2026-11-24, 9 of the 14 queue
# ejections since arming retired waited more than an hour (the ledger entry
# has the numbers). This is the pipeline's job, not an agent's.
#
# .github/workflows/queue-reentry.yml runs `sweep` from main's copy. For each
# open pull request into main whose LAST merge-queue event is a removal by the
# merge queue itself (a person or another workflow taking it out is a
# deliberate act and is never undone), with auto-merge off and not turned on
# or off by anyone since that removal:
#   - held (hold, do-not-merge, wip, blocked)        -> nothing
#   - mergeable, every required check green          -> auto-merge back on,
#     which queues it again
#   - conflicting with main                          -> one comment per head
#     asking the author to merge main
#   - a required check failing, pending or missing   -> nothing; a later sweep
#     looks again
#   - its head re-entered by this workflow twice     -> nothing
#   - its head failed the same required check in two queue builds -> nothing:
#     scripts/queue-repeat-guard.sh would take it straight back out
# The rule is about the latest removal, not the head: a pull request the queue
# took out on an old head and whose author has since merged main qualifies as
# soon as the new head is green.
#
# Anything that cannot be read means "do nothing". `sweep` never fails: every
# problem is a `::warning::`, so nobody has a red run to chase.
#
# Usage:
#   scripts/queue-reentry.sh verdict <pr.json>
#       <pr.json> is the pullRequest object from DETAIL_QUERY below. Prints one
#       line: ENABLE | COMMENT | SKIP <reason>. Exit 2 when it is not JSON.
#   scripts/queue-reentry.sh comment <head-sha>
#       prints the note left on a conflicting pull request
#   scripts/queue-reentry.sh sweep [--dry-run]
#       reads every open pull request, decides and acts (prints, never writes,
#       with --dry-run)
#
# Environment: GH (default gh), REPO (owner/name, required for sweep),
# REQUIRED_CHECKS (default ci/required-checks.json beside this script),
# REPEAT_GUARD (default scripts/queue-repeat-guard.sh beside this script),
# REENTRY_ACTOR (the GitHub App login whose auto-merge turns count as
# re-entries; default dorkos-merge-tail), REENTRY_RETRY_DELAY (seconds between
# reads while GitHub is still computing mergeability; default 5).
#
# Fixtures: scripts/test-queue-reentry.sh.

# shellcheck disable=SC2016  # the single-quoted $s are jq and GraphQL variables
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GH=${GH:-gh}
required_file=${REQUIRED_CHECKS:-$here/../ci/required-checks.json}
repeat_guard=${REPEAT_GUARD:-$here/queue-repeat-guard.sh}
actor=${REENTRY_ACTOR:-dorkos-merge-tail}
actor=${actor%\[bot\]}

# How many times this workflow may put one head back. The repeat guard stops a
# head that keeps failing the SAME check; this stops one that keeps being
# ejected for different reasons.
MAX_REENTRIES=2
MARKER_PREFIX='<!-- queue-reentry head='

usage() {
  echo "usage: $0 verdict <pr.json> | comment <head-sha> | sweep [--dry-run]" >&2
  exit 2
}

# The events that say who last moved this pull request in or out of the queue.
EVENT_TYPES='ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT,AUTO_MERGE_ENABLED_EVENT,AUTO_MERGE_DISABLED_EVENT'
EVENT_FIELDS='nodes{ __typename
  ... on AddedToMergeQueueEvent{ createdAt actor{ login } }
  ... on RemovedFromMergeQueueEvent{ createdAt reason actor{ login } }
  ... on AutoMergeEnabledEvent{ createdAt actor{ login } }
  ... on AutoMergeDisabledEvent{ createdAt reason actor{ login } } }'

LIST_QUERY='query($owner:String!,$name:String!,$endCursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN, first:50, after:$endCursor){
      pageInfo{ hasNextPage endCursor }
      nodes{ number state isDraft baseRefName
        autoMergeRequest{ enabledAt } mergeQueueEntry{ state }
        events: timelineItems(last:30, itemTypes:['"$EVENT_TYPES"']){ '"$EVENT_FIELDS"' } } } } }'

# `removals` is the shape scripts/should-arm-automerge-input.sh reads, so the
# repeat rule sees the same failed checks queue-repeat-guard.yml sees.
DETAIL_QUERY='query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      id number state isDraft baseRefName mergeable headRefOid
      autoMergeRequest{ enabledAt } mergeQueueEntry{ state }
      labels(first:100){ nodes{ name } }
      labelEvents: timelineItems(last:50, itemTypes:[LABELED_EVENT]){ nodes{
        ... on LabeledEvent{ createdAt label{ name } } } }
      events: timelineItems(last:100, itemTypes:['"$EVENT_TYPES"']){ '"$EVENT_FIELDS"' }
      removals: timelineItems(last:50, itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]){ nodes{
        ... on RemovedFromMergeQueueEvent{ createdAt reason
          beforeCommit{ checkSuites(first:50){ nodes{
            checkRuns(first:50, filterBy:{conclusions:[FAILURE,TIMED_OUT,STARTUP_FAILURE]}){
              nodes{ name } } } } } } } }
      commits(last:1){ nodes{ commit{ oid
        checkSuites(first:50){ nodes{ createdAt } }
        statusCheckRollup{ contexts(first:100){ totalCount nodes{ __typename
          ... on CheckRun{ name status conclusion startedAt }
          ... on StatusContext{ context state createdAt } } } } } } } } } }'

# The part of the rule the cheap list read can already answer, shared with the
# verdict so the two cannot disagree: open, into main, not a draft, auto-merge
# off, not queued, and the latest merge-queue event a removal by the queue
# itself with no auto-merge change after it. Prints "eligible" or why not.
ELIGIBLE_DEF='
  def bare: sub("\\[bot\\]$"; "");
  def events: (.events.nodes // null);
  def last_queue_index:
    [events | to_entries[]
     | select(.value.__typename == "AddedToMergeQueueEvent"
              or .value.__typename == "RemovedFromMergeQueueEvent") | .key] | max;
  def precheck:
    if (.state // "") != "OPEN"                       then "not-open"
    elif (.isDraft | type) != "boolean"               then "draft-unknown"
    elif .isDraft                                     then "draft"
    elif (.baseRefName // "") != "main"               then "base-not-main"
    elif (has("autoMergeRequest") | not)              then "auto-merge-unknown"
    elif .autoMergeRequest != null                    then "auto-merge-on"
    elif (has("mergeQueueEntry") | not)               then "queue-entry-unknown"
    elif .mergeQueueEntry != null                     then "queued"
    elif (events | type) != "array"                   then "history-unknown"
    elif last_queue_index == null                     then "never-queued"
    else last_queue_index as $i | events[$i] as $e
      | if $e.__typename != "RemovedFromMergeQueueEvent" then "not-removed"
        elif ($e.reason // "" | ascii_downcase) == "merged" then "not-removed"
        # Only the queue ejecting it counts. A person, an agent or another
        # workflow (queue-repeat-guard dequeues as the merge-tail app) took it
        # out on purpose.
        elif (($e.actor.login // "") | bare) != "github-merge-queue"
                                                      then "removed-by-hand"
        # Someone turned auto-merge on or off since: theirs to decide.
        elif any(events[$i + 1:][]; .__typename == "AutoMergeEnabledEvent"
                                    or .__typename == "AutoMergeDisabledEvent")
                                                      then "auto-merge-changed-since"
        else "eligible" end
    end;
'

HOLD_LABELS='["hold","do-not-merge","do not merge","wip","blocked"]'

# verdict <pr.json>: prints ENABLE | COMMENT | SKIP <reason>.
verdict() {
  local src=$1 pre required guard_in guard_out

  if ! jq -e 'type == "object"' "$src" >/dev/null 2>&1; then
    echo "SKIP unreadable-payload"
    return 2
  fi
  pre=$(jq -r "$ELIGIBLE_DEF"' precheck' "$src" 2>/dev/null) || pre=
  if [[ "$pre" != eligible ]]; then
    echo "SKIP ${pre:-unreadable-payload}"
    return 0
  fi

  required=$(jq -c '[.contexts[]? | strings]' "$required_file" 2>/dev/null) || required=
  if [[ -z "$required" || "$required" == "[]" ]]; then
    echo "SKIP required-checks-unknown"
    return 0
  fi

  local v
  v=$(jq -r --argjson hold "$HOLD_LABELS" --argjson req "$required" \
         --arg actor "$actor" --argjson max "$MAX_REENTRIES" '
    def bare: sub("\\[bot\\]$"; "");
    def head: (.commits.nodes[0].commit? // null);
    def since: ([head.checkSuites.nodes[]?.createdAt | strings] | min);
    # Per required name, the newest run (a run not started yet is newest).
    def state_of($pr; $name):
      [$pr | head.statusCheckRollup.contexts.nodes[]?
       | select(type == "object")
       | if .__typename == "StatusContext" then
           select(.context == $name)
           | {at: (.createdAt // ""),
              s: ({"SUCCESS": "pass", "PENDING": "pending", "EXPECTED": "pending"}[.state // ""]
                  // "fail")}
         else
           select(.name == $name)
           | {at: (.startedAt // "9999"),
              s: (if (.status // "") != "COMPLETED" then "pending"
                  elif ((.conclusion // "") | IN("SUCCESS", "NEUTRAL", "SKIPPED")) then "pass"
                  else "fail" end)}
         end]
      | sort_by(.at) | last | (.s // "missing");

    if (.labels.nodes | type) != "array"                    then "SKIP labels-unreadable"
    elif ([.labels.nodes[] | (.name // "") | ascii_downcase] as $l
          | any($hold[]; . as $h | $l | index($h)))         then "SKIP held"
    elif .mergeable == "CONFLICTING"                        then "COMMENT"
    elif .mergeable != "MERGEABLE"                          then "SKIP mergeability-unknown"
    elif head == null or head.oid != .headRefOid            then "SKIP head-unknown"
    elif since == null                                      then "SKIP head-unknown"
    elif (since as $s
          | [.events.nodes[] | select(.__typename == "AutoMergeEnabledEvent")
             | select(((.actor.login // "") | bare) == $actor)
             | select((.createdAt // "") > $s)] | length) >= $max
                                                            then "SKIP reentered-twice"
    elif (head.statusCheckRollup.contexts | type) != "object"
         or ((head.statusCheckRollup.contexts.nodes | type) != "array")
         or (head.statusCheckRollup.contexts.totalCount
             > (head.statusCheckRollup.contexts.nodes | length))
                                                            then "SKIP checks-unreadable"
    elif (. as $pr | any($req[]; state_of($pr; .) == "fail"))
                                                            then "SKIP failing-checks"
    elif (. as $pr | any($req[]; state_of($pr; .) != "pass"))
                                                            then "SKIP checks-pending"
    else "CHECK-REPEATS" end' "$src" 2>/dev/null) || v=
  if [[ -z "$v" ]]; then
    echo "SKIP unreadable-payload"
    return 0
  fi
  if [[ "$v" != CHECK-REPEATS ]]; then
    echo "$v"
    return 0
  fi

  # Last, the repeat rule, asked of queue-repeat-guard.sh itself so the two
  # cannot disagree: a head it would take straight back out is not put back.
  guard_in=$(mktemp)
  jq '{number, headRefOid,
       labels: [.labels.nodes[]?],
       headSince: ([.commits.nodes[0].commit.checkSuites.nodes[]?.createdAt | strings] | min),
       queueRemovals: (if (.removals.nodes | type) == "array"
                       then [.removals.nodes[]
                             | {at: .createdAt, reason,
                                failedChecks: ([.beforeCommit.checkSuites.nodes[]?
                                                .checkRuns.nodes[]?.name] | unique)}]
                       else null end),
       requeueOkAt: ([.labelEvents.nodes[]?
                      | select((.label.name // "" | ascii_downcase) == "requeue-ok")
                      | .createdAt] | max)}' "$src" >"$guard_in" 2>/dev/null
  guard_out=$(REQUIRED_CHECKS="$required_file" bash "$repeat_guard" verdict "$guard_in" 2>/dev/null | head -n 1)
  rm -f "$guard_in"
  case "$guard_out" in
    DEQUEUE) echo "SKIP repeat-queue-failure" ;;
    "KEEP no-repeat" | "KEEP requeue-ok") echo "ENABLE" ;;
    *) echo "SKIP queue-history-unknown" ;;
  esac
}

comment() {
  local head=$1
  echo "**The merge queue took this pull request out, and it no longer merges cleanly with \`main\`.**"
  echo
  echo "Please merge \`main\` into the branch and push. Auto-merge comes back on by itself, and the pull request goes back into the queue, once the new head's required checks are green."
  echo
  echo "${MARKER_PREFIX}${head} -->"
}

sweep() {
  local dry=0 owner name delay
  [[ "${1:-}" == --dry-run ]] && dry=1
  warn() { echo "::warning::queue-reentry: $*"; }
  [[ "${REPO:-}" == */* ]] || { warn "REPO is not set; nothing swept"; return 0; }
  owner=${REPO%/*} name=${REPO#*/}
  delay=${REENTRY_RETRY_DELAY:-5}
  [[ "$delay" =~ ^[0-9]+$ ]] || delay=5
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT

  if ! jq -e '[.contexts[]? | strings] | length > 0' "$required_file" >/dev/null 2>&1; then
    warn "could not read the required checks from $required_file; nothing swept"
    return 0
  fi

  if ! "$GH" api graphql --paginate -F owner="$owner" -F name="$name" -f query="$LIST_QUERY" \
         >"$work/list.json" 2>"$work/err.txt"; then
    warn "could not list open pull requests: $(tr '\n' ' ' <"$work/err.txt" | cut -c1-200)"
    return 0
  fi
  if ! jq -s -e 'all(.[]; (.data.repository.pullRequests.nodes | type) == "array")' \
         "$work/list.json" >/dev/null 2>&1; then
    warn "the list of open pull requests was unreadable: $(tr '\n' ' ' <"$work/list.json" | cut -c1-200)"
    return 0
  fi
  jq -s -r "$ELIGIBLE_DEF"'
    [.[].data.repository.pullRequests.nodes[] | select(precheck == "eligible") | .number] | .[]' \
    "$work/list.json" >"$work/candidates.txt" 2>/dev/null || :
  local open candidates
  open=$(jq -s '[.[].data.repository.pullRequests.nodes[]] | length' "$work/list.json")
  candidates=$(grep -c . "$work/candidates.txt")
  echo "Open pull requests: $open; last taken out by the queue with auto-merge off: $candidates"

  local pr try v head enabled=0 commented=0
  while read -r pr; do
    [[ "$pr" =~ ^[0-9]+$ ]] || continue
    v=
    rm -f "$work/pr.json"
    # GitHub works out mergeability lazily and answers UNKNOWN meanwhile; ask
    # again a couple of times before leaving it to the next sweep.
    for try in 1 2 3; do
      if "$GH" api graphql -F owner="$owner" -F name="$name" -F number="$pr" \
           -f query="$DETAIL_QUERY" >"$work/detail.json" 2>"$work/err.txt" \
         && jq -e '.data.repository.pullRequest | type == "object"' "$work/detail.json" >/dev/null 2>&1; then
        jq '.data.repository.pullRequest' "$work/detail.json" >"$work/pr.json"
        v=$(verdict "$work/pr.json")
      else
        v="SKIP could-not-read-pr"
      fi
      [[ "$v" == "SKIP mergeability-unknown" && "$try" -lt 3 ]] || break
      sleep "$delay"
    done
    head=$(jq -r '.headRefOid // ""' "$work/pr.json" 2>/dev/null) || head=

    case "$v" in
      ENABLE)
        if [[ $dry == 1 ]]; then
          echo "PR #$pr -> ENABLE (dry run: auto-merge left off)"
          continue
        fi
        if "$GH" api graphql -f id="$(jq -r '.id' "$work/pr.json")" -f head="$head" \
             -f query='mutation($id:ID!,$head:GitObjectID!){
               enablePullRequestAutoMerge(input:{pullRequestId:$id, expectedHeadOid:$head}){
                 clientMutationId } }' >/dev/null 2>"$work/err.txt"; then
          enabled=$((enabled + 1))
          echo "PR #$pr -> ENABLE: auto-merge back on at ${head:0:10}; it goes back into the queue"
        else
          warn "PR #$pr: could not turn auto-merge back on: $(tr '\n' ' ' <"$work/err.txt" | cut -c1-200)"
        fi
        ;;
      COMMENT)
        if ! "$GH" api --paginate "repos/$REPO/issues/$pr/comments?per_page=100" --jq '.[].body' \
               >"$work/comments.txt" 2>/dev/null; then
          warn "PR #$pr: conflicts with main, but its comments could not be read; not commenting"
          continue
        fi
        if grep -qF -- "${MARKER_PREFIX}${head} -->" "$work/comments.txt"; then
          echo "PR #$pr -> SKIP conflict-already-told"
          continue
        fi
        if [[ $dry == 1 ]]; then
          echo "PR #$pr -> COMMENT (dry run: not posted)"
          continue
        fi
        comment "$head" >"$work/comment.md"
        if "$GH" pr comment "$pr" --repo "$REPO" --body-file "$work/comment.md" >/dev/null 2>"$work/err.txt"; then
          commented=$((commented + 1))
          echo "PR #$pr -> COMMENT: asked the author to merge main"
        else
          warn "PR #$pr: could not post the merge-main note: $(tr '\n' ' ' <"$work/err.txt" | cut -c1-200)"
        fi
        ;;
      "SKIP could-not-read-pr")
        warn "PR #$pr: could not read the pull request: $(cat "$work/err.txt" "$work/detail.json" 2>/dev/null | tr '\n' ' ' | cut -c1-200)"
        ;;
      *) echo "PR #$pr -> $v" ;;
    esac
  done <"$work/candidates.txt"
  echo "Auto-merge back on: $enabled; asked to merge main: $commented"
}

cmd=${1:-}
shift || :
case "$cmd" in
  verdict)
    [[ -n "${1:-}" ]] || usage
    verdict "$1"
    ;;
  comment)
    [[ -n "${1:-}" ]] || usage
    comment "$1"
    ;;
  sweep) sweep "${1:-}" ;;
  *) usage ;;
esac
