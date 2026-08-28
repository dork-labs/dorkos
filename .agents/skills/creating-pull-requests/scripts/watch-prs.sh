#!/usr/bin/env bash
# watch-prs.sh — watch pull requests to merge completion, reporting state
# TRANSITIONS (never once-per-PR "seen" dedup: a PR that fails, recovers,
# and fails again reports every turn).
#
# Usage:
#   watch-prs.sh [--interval SECONDS] [--max-cycles N] [--once] PR [PR...]
#   watch-prs.sh --classify        # test seam: JSON snapshot on stdin -> event token
#   watch-prs.sh --probe PR        # test seam: run the real collection path for
#                                  # one PR (gh pr checks + the GraphQL query) and
#                                  # print its classify() input JSON. Read-only —
#                                  # same network calls the watch loop makes, no
#                                  # state kept, nothing mutated. Takes EXACTLY
#                                  # one PR; a missing or extra argument is a
#                                  # usage error, not a silent first-wins pick.
#                                  # Exits non-zero when the snapshot is ERR.
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
PROBE=""
PRS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) INTERVAL="$2"; shift 2 ;;
    --max-cycles) MAX_CYCLES="$2"; shift 2 ;;
    --once) ONCE=1; shift ;;
    --classify) CLASSIFY=1; shift ;;
    --probe)
      PROBE="${2:-}"
      [ -n "$PROBE" ] || { echo "usage: watch-prs.sh --probe PR" >&2; exit 2; }
      shift 2 ;;
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

USAGE="usage: watch-prs.sh [--interval s] [--max-cycles n] [--once] PR... | --classify | --probe PR"
[ ${#PRS[@]} -gt 0 ] || [ -n "$PROBE" ] || { echo "$USAGE" >&2; exit 2; }
# --probe takes exactly one PR: a stray extra argument (e.g. `--probe 42 43`)
# must be a usage error, not a silent "PROBE wins, the rest is ignored".
if [ -n "$PROBE" ] && [ ${#PRS[@]} -gt 0 ]; then
  echo "$USAGE" >&2
  echo "  --probe takes exactly one PR; got extra argument(s): ${PRS[*]}" >&2
  exit 2
fi

# SKILL.md's own rule for this script: "a watcher that dies must say so."
# `gh repo view` is the one call with no retry path below it — every other
# `gh`/API failure in this script degrades to a snapshot the loop already
# knows how to treat as transient (the {"state":"ERR"} sentinel). This one
# runs once, before any PR is ever watched, so a silent failure here would
# exit the script with no output at all rather than an announced death.
REPO_JSON=$(gh repo view --json owner,name) || { echo "WATCHER DIED: gh repo view failed — check auth/network" >&2; exit 4; }
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
  #
  # `gh pr checks` exits 1 when ANY check failed and 8 when checks are still
  # pending — BY DESIGN, and BOTH exits still carry the full stdout we need.
  # Piping that command straight into awk/grep/jq (as this used to) drags its
  # exit code through `set -o pipefail`: bash reports a pipeline's status as
  # the rightmost non-zero exit among its stages, so `gh`'s 1-on-fail outranks
  # every downstream command succeeding, which tripped the `|| failing='[]'`
  # fallback and wiped the collected names EXACTLY when checks failed —
  # FAILING could never be reported (DOR-1630). Fix: collect stdout first, in
  # its own command substitution, decide from that — never from `gh`'s exit
  # code alone.
  #
  # Empty stdout is NOT automatically a dead call: a PR with zero checks
  # configured also prints nothing, and `gh` still exits 0, 1, or 8 for that
  # case — its exit code tracks the checks bucket, not whether any checks
  # exist. Only empty stdout paired with an exit code OUTSIDE {0,1,8} means
  # the call itself never reached GitHub (auth failure, network error, rate
  # limit). Reporting that as a healthy zero-check PR would read as PENDING
  # forever, same shape of bug as the one above — so it returns the same
  # {"state":"ERR"} sentinel the GraphQL call above uses, which the watch
  # loop already retries as transient rather than classifying.
  local checks_raw rc
  rc=0
  checks_raw=$(gh pr checks "$pr" 2>/dev/null) || rc=$?
  local failing checks_reported
  if [ -z "$checks_raw" ]; then
    case "$rc" in
      0 | 1 | 8) failing='[]'; checks_reported=0 ;; # a real zero-check PR
      *) echo '{"state":"ERR"}'; return ;;           # the call itself failed
    esac
  else
    # awk, not grep, excludes Vercel: grep -v exits 1 on no-match (e.g. zero
    # non-Vercel failures), which would re-trip the same pipefail trap this
    # fix removes upstream. awk always exits 0 regardless of match count.
    failing=$(printf '%s\n' "$checks_raw" | awk -F'\t' '$2=="fail" && tolower($1) !~ /^vercel/ {print $1}' | jq -R . | jq -cs .)
    checks_reported=$(printf '%s\n' "$checks_raw" | wc -l | tr -d ' ')
  fi
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

if [ -n "$PROBE" ]; then
  snap=$(snapshot "$PROBE")
  printf '%s\n' "$snap"
  # A probe that can only ever exit 0 hides the one outcome it exists to
  # surface: `gh` itself failing. Match the loop's own read of the sentinel.
  [ "$(jq -r .state <<<"$snap")" != "ERR" ] || exit 1
  exit 0
fi

# PROBE is empty here, so the usage guard above already proved PRS is
# non-empty — nothing further to check before starting the watch loop.

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
