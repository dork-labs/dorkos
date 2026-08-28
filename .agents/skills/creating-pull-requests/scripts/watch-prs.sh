#!/usr/bin/env bash
# watch-prs.sh — watch pull requests to merge completion, reporting state
# TRANSITIONS (never once-per-PR "seen" dedup: a PR that fails, recovers,
# and fails again reports every turn).
#
# Usage:
#   watch-prs.sh [--interval SECONDS] [--max-cycles N] [--once] PR [PR...]
#   watch-prs.sh --classify   # test seam: JSON snapshot on stdin -> event token
#
# One line per state TRANSITION on stdout (pipe into the Monitor tool or a
# notification hook). Silence means "same state as last cycle", so pair it
# with --max-cycles / a timeout that ANNOUNCES expiry — silence is never
# success. Exits 0 when every watched PR is MERGED or CLOSED.
#
# Event vocabulary (stable; the fixture test pins it):
#   MERGED                     terminal, the good end
#   CLOSED                     terminal, closed without merging
#   CONFLICTING                needs a rebase; a conflicting PR gets NO CI and
#                              NO automated review, so after the rebase re-arm
#                              auto-merge AND add the re-review label
#   FAILING(name,...)          required-check failures (standing Vercel reds
#                              excluded); a rerun of a pull_request job reuses
#                              the ORIGINAL merge snapshot, so if main has
#                              moved since, push an empty commit instead of
#                              rerunning; a check red on main's last commits
#                              too is a standing condition, not yours
#   EJECTED(reason)            the merge queue silently dropped the PR; nothing
#                              else reports this (no webhook, no check goes red)
#   STUCK_UNMERGEABLE          in the queue with entry state UNMERGEABLE — a
#                              dead entry that will never merge; clear it with
#                              the dequeuePullRequest mutation, then re-arm
#                              auto-merge (remediation in SKILL.md)
#   STALLED_IN_QUEUE           queued but zero checks reported for a while —
#                              the classic missing `on: merge_group` trigger
#   UNRESOLVED_THREADS(n)      open review threads (not outdated) — these block
#                              merge-tail from arming while everything is green
#   UNARMED_CLEAN              green and mergeable but nothing will merge it:
#                              arming auto-merge 422s on an already-clean PR
#                              ("Pull request is in clean status") — merge it
#                              directly: gh pr merge <n>
#   QUEUED(pos)                entered the merge queue (informational)
#   PENDING                    checks running / mergeability being computed;
#                              UNKNOWN mergeStateStatus is retry-not-terminal
#   RECOVERED                  was FAILING/CONFLICTING last cycle, healthy now
set -euo pipefail

INTERVAL=60
MAX_CYCLES=0 # 0 = unbounded (caller supplies the timeout)
ONCE=0
CLASSIFY=0
PRS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) INTERVAL="$2"; shift 2 ;;
    --max-cycles) MAX_CYCLES="$2"; shift 2 ;;
    --once) ONCE=1; shift ;;
    --classify) CLASSIFY=1; shift ;;
    *) PRS+=("$1"); shift ;;
  esac
done

# classify: pure state machine over one JSON snapshot. The network layer
# below builds the same shape, so fixtures exercise the real decision path.
# Shape: {state, mergeState, failing: [names], unresolvedThreads: n,
#         queued: bool, queuePos: n|null, queueState: str|null, autoMerge: bool,
#         ejectionReason: str|null, checksReported: n, cyclesQueued: n}
classify() {
  jq -r '
    if .state == "MERGED" then "MERGED"
    elif .state == "CLOSED" then "CLOSED"
    elif .ejectionReason != null then "EJECTED(\(.ejectionReason))"
    elif .mergeState == "DIRTY" then "CONFLICTING"
    elif (.failing | length) > 0 then "FAILING(\(.failing | join(",")))"
    # A queued entry GitHub has marked UNMERGEABLE is stuck: it will never
    # merge and nothing else reports it — the entry still carries a position,
    # so without this branch it reads as a healthy QUEUED (a false green).
    # Precedence EJECTED > CONFLICTING > FAILING > STUCK_UNMERGEABLE:
    # EJECTED/CONFLICTING/FAILING each name a MORE specific cause of the same
    # stuck-ness (already dropped from the queue / a dirty tree / a named red
    # check), so when one of those is also true it is the better report. Above
    # STALLED_IN_QUEUE and QUEUED because UNMERGEABLE is a definite dead entry,
    # not "queued but quiet" — it must outrank both or it is masked. Fires ONLY
    # on the explicit "UNMERGEABLE" string; any other state (or a null/absent
    # queueState) falls through to the branches below unchanged.
    elif .queued and (.queueState == "UNMERGEABLE") then "STUCK_UNMERGEABLE"
    elif .queued and .checksReported == 0 and .cyclesQueued >= 5 then "STALLED_IN_QUEUE"
    elif (.unresolvedThreads // 0) > 0 then "UNRESOLVED_THREADS(\(.unresolvedThreads))"
    elif .mergeState == "CLEAN" and (.autoMerge | not) and (.queued | not) then "UNARMED_CLEAN"
    elif .queued then "QUEUED(\(.queuePos // "?"))"
    else "PENDING"
    end'
}

if [ "$CLASSIFY" = 1 ]; then
  classify
  exit 0
fi

[ ${#PRS[@]} -gt 0 ] || { echo "usage: watch-prs.sh [--interval s] [--max-cycles n] [--once] PR..." >&2; exit 2; }

REPO_JSON=$(gh repo view --json owner,name)
OWNER=$(jq -r .owner.login <<<"$REPO_JSON")
REPO=$(jq -r .name <<<"$REPO_JSON")

snapshot() { # $1 = PR number; prints the classify() input JSON
  local pr=$1
  local gql
  gql=$(gh api graphql -f query='
    query($o:String!,$r:String!,$n:Int!){
      repository(owner:$o,name:$r){ pullRequest(number:$n){
        state mergeStateStatus
        autoMergeRequest { enabledAt }
        mergeQueueEntry { position state }
        reviewThreads(first:100){ nodes { isResolved isOutdated } }
        timelineItems(last:5, itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]){
          nodes { ... on RemovedFromMergeQueueEvent { createdAt reason } } }
      } }
    }' -f o="$OWNER" -f r="$REPO" -F n="$pr" 2>/dev/null) || { echo '{"state":"ERR"}'; return; }
  # Standing Vercel reds are excluded: frequently red on main itself and not
  # in the queue's required set. Everything else red is reported.
  local failing
  failing=$(gh pr checks "$pr" 2>/dev/null | awk -F'\t' '$2=="fail"{print $1}' | grep -vi '^Vercel' | jq -R . | jq -cs .) || failing='[]'
  local checks_reported
  checks_reported=$(gh pr checks "$pr" 2>/dev/null | wc -l | tr -d ' ') || checks_reported=0
  jq -c --argjson failing "$failing" --argjson reported "${checks_reported:-0}" '
    .data.repository.pullRequest as $p | {
      state: $p.state,
      mergeState: $p.mergeStateStatus,
      failing: $failing,
      unresolvedThreads: ([$p.reviewThreads.nodes[] | select((.isResolved|not) and (.isOutdated|not))] | length),
      queued: ($p.mergeQueueEntry != null),
      queuePos: ($p.mergeQueueEntry.position // null),
      queueState: ($p.mergeQueueEntry.state // null),
      autoMerge: ($p.autoMergeRequest != null),
      # only report an ejection observed while we were watching (see loop)
      lastEjectionAt: ($p.timelineItems.nodes | map(.createdAt) | max // null),
      lastEjectionReason: ($p.timelineItems.nodes | sort_by(.createdAt) | last.reason // null),
      checksReported: $reported
    }' <<<"$gql"
}

# Per-PR state in indexed arrays (macOS ships bash 3.2: no `declare -A`).
LAST=(); STATE_CYCLES=(); BASELINE_EJECTION=()
i=0
for pr in "${PRS[@]}"; do LAST[i]=""; STATE_CYCLES[i]=0; BASELINE_EJECTION[i]=""; i=$((i + 1)); done
cycle=0
while true; do
  cycle=$((cycle + 1))
  open=0
  i=-1
  for pr in "${PRS[@]}"; do
    i=$((i + 1))
    snap=$(snapshot "$pr")
    [ "$(jq -r .state <<<"$snap")" = "ERR" ] && { open=1; continue; } # transient API failure: keep watching
    # Ejection detection: report only ejections newer than our first sight.
    ej_at=$(jq -r '.lastEjectionAt // ""' <<<"$snap")
    if [ -z "${BASELINE_EJECTION[i]}" ]; then BASELINE_EJECTION[i]="${ej_at:-none}"; fi
    ej_reason=null
    if [ -n "$ej_at" ] && [ "${BASELINE_EJECTION[i]}" != "$ej_at" ]; then
      ej_reason=$(jq '.lastEjectionReason' <<<"$snap")
      BASELINE_EJECTION[i]="$ej_at"
    fi
    # UNKNOWN mergeability is computed async — retry, never classify on it.
    ms=$(jq -r .mergeState <<<"$snap")
    if [ "$ms" = "UNKNOWN" ] && [ "$(jq -r .state <<<"$snap")" = "OPEN" ]; then
      open=1; continue
    fi
    queued_now=$(jq -r .queued <<<"$snap")
    if [ "$queued_now" = "true" ]; then STATE_CYCLES[i]=$((STATE_CYCLES[i] + 1)); else STATE_CYCLES[i]=0; fi
    cur=$(jq -c --argjson ej "$ej_reason" --argjson cq "${STATE_CYCLES[i]}" \
      '. + {ejectionReason: $ej, cyclesQueued: $cq}' <<<"$snap" | classify)
    prev="${LAST[i]}"
    if [ "$cur" != "$prev" ]; then
      case "$cur" in
        PENDING|QUEUED*)
          case "$prev" in
            FAILING*|CONFLICTING|STALLED_IN_QUEUE|STUCK_UNMERGEABLE) echo "PR #$pr RECOVERED -> $cur" ;;
            "") : ;; # first sight of a healthy PR: stay quiet
            *) echo "PR #$pr -> $cur" ;;
          esac ;;
        *) echo "PR #$pr -> $cur" ;;
      esac
      LAST[i]=$cur
    fi
    case "$cur" in MERGED|CLOSED) : ;; *) open=1 ;; esac
  done
  [ "$open" = 0 ] && { echo "ALL WATCHED PRS SETTLED"; exit 0; }
  [ "$ONCE" = 1 ] && exit 0
  if [ "$MAX_CYCLES" -gt 0 ] && [ "$cycle" -ge "$MAX_CYCLES" ]; then
    echo "WATCHER EXPIRED after $cycle cycles — PRs still open; check them directly"
    exit 3
  fi
  # jitter so several watchers on one machine don't fire in lockstep
  sleep $((INTERVAL + RANDOM % 15))
done
