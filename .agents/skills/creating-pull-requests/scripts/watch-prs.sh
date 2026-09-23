#!/usr/bin/env bash
# watch-prs.sh — watch pull requests to merge completion, reporting state
# TRANSITIONS (never once-per-PR "seen" dedup: a PR that fails, recovers,
# and fails again reports every turn).
#
# Usage:
#   watch-prs.sh [--interval SECONDS] [--max-cycles N] [--once] PR [PR...]
#   watch-prs.sh --classify        # test seam: JSON snapshot on stdin -> event token
#   watch-prs.sh --remedy TOKEN [PR]
#                                  # test seam: print the remedy text the watch
#                                  # loop prints after TOKEN (empty for an
#                                  # informational token); PR fills in <n>
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
# notification hook): `PR #n -> TOKEN :: remedy` when the state asks
# something of you, `PR #n -> TOKEN` when it is informational. Silence means
# "same state as last cycle", so pair it with --max-cycles / a timeout that
# ANNOUNCES expiry: silence is never success. Exits 0 when every watched PR
# is MERGED or CLOSED.
#
# Every remedy is load-aware on purpose. One push to a PR starts 19 to 25
# Actions jobs against a 60-job pool shared by every agent, so no remedy here
# tells you to push an empty commit, update a branch, or merge around the
# queue. The remedy text lives in remedy() below; `--remedy TOKEN` prints it
# and the fixture test pins it.
#
# Event vocabulary (stable; the fixture test pins it), in precedence order:
#   MERGED                     terminal, the good end
#   CLOSED                     terminal, closed without merging
#   EJECTED(reason)            the merge queue dropped the PR; nothing else
#                              reports this (no webhook, no check goes red).
#                              For failed_checks the first response is to WAIT:
#                              85% re-pass unchanged and merge-tail re-queues
#   EJECTED_REPEAT(failed_checks,k)
#                              k >= 2 failed-checks ejections with no new
#                              commit in between: now check whether the same
#                              job failed each time, and treat that as real
#   CONFLICTING                needs a rebase; a conflicting PR gets NO CI and
#                              NO automated review
#   FAILING(name,...)          PR check failures (standing Vercel reds
#                              excluded); read the log before acting
#   CANCELLED(name,...)        a cancelled check; merge-tail never arms a PR
#                              carrying one, so re-run it
#   STUCK_UNMERGEABLE          in the queue with entry state UNMERGEABLE, a
#                              dead entry that keeps its position and would
#                              otherwise read as a healthy QUEUED
#   STALLED_IN_QUEUE(m)        queued for m >= 90 minutes (the queue's p90 is
#                              about 55); a queue or runner stall, not your PR
#   HELD_BY_LABEL(label[,armed])
#                              hold / do-not-merge / wip / blocked is on the PR:
#                              merge-tail will not arm it. ",armed" means it was
#                              armed anyway, and the queue does not read labels
#   UNRESOLVED_THREADS(n[,armed])
#                              unresolved review threads, outdated ones
#                              included (merge-tail counts them the same way).
#                              ",armed" means armed or queued: the queue does
#                              not wait for threads, so it merges with them open
#   UNARMED_CLEAN              green and unarmed; arm it yourself with
#                              gh pr merge --auto (merge-tail runs only every
#                              2-3 hours). Never merge it directly
#   QUEUED(pos)                entered the merge queue (informational)
#   PENDING                    checks running / mergeability being computed;
#                              UNKNOWN mergeStateStatus is retry-not-terminal
#   RECOVERED                  was failing, conflicting, cancelled, stuck,
#                              stalled or blind last cycle, healthy now
#   WATCHER BLIND(k cycles)    the gh calls failed k cycles running (auth,
#                              network, rate limit): the watcher cannot see
#                              and says so instead of going quiet
set -euo pipefail

USAGE="usage: watch-prs.sh [--interval s] [--max-cycles n] [--once] PR... | --classify | --remedy TOKEN [PR] | --probe PR"
usage() {
  printf '%s\n' "$USAGE"
}
usage_error() {
  [ $# -eq 0 ] || printf 'error: %s\n' "$*" >&2
  usage >&2
  exit 2
}
is_non_negative_integer() {
  local value="$1"
  case "$value" in
    '' | *[!0-9]* | 0[0-9]*) return 1 ;;
  esac
  [ ${#value} -lt 10 ] || { [ ${#value} -eq 10 ] && [[ "$value" < "2147483648" ]]; }
}

INTERVAL=60
MAX_CYCLES=0 # 0 = unbounded (caller supplies the timeout)
ONCE=0
CLASSIFY=0
REMEDY=""
PROBE=""
PRS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --interval)
      [ $# -ge 2 ] || usage_error "--interval requires a positive integer up to 2147483647"
      is_non_negative_integer "$2" && [ "$2" != 0 ] || usage_error "--interval requires a positive integer up to 2147483647"
      INTERVAL="$2"
      shift 2 ;;
    --max-cycles)
      [ $# -ge 2 ] || usage_error "--max-cycles requires a non-negative integer up to 2147483647"
      is_non_negative_integer "$2" || usage_error "--max-cycles requires a non-negative integer up to 2147483647"
      MAX_CYCLES="$2"
      shift 2 ;;
    --once) ONCE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    --classify) CLASSIFY=1; shift ;;
    --remedy)
      REMEDY="${2:-}"
      [ -n "$REMEDY" ] || usage_error "--remedy requires a token"
      shift 2 ;;
    --probe)
      PROBE="${2:-}"
      [ -n "$PROBE" ] || usage_error "--probe requires exactly one PR"
      case "$PROBE" in -*) usage_error "--probe requires exactly one PR" ;; esac
      shift 2 ;;
    -*) usage_error "unknown option: $1" ;;
    *) PRS+=("$1"); shift ;;
  esac
done

# Minutes in the queue past which a queued PR is reported stalled. The queue's
# p90 from entry to merge is about 55 minutes and its check timeout is 120, so
# 90 is well past normal and still before GitHub gives up on the entry.
STALL_MINUTES=90
# Labels that stop merge-tail arming a PR. Mirror of HOLD_LABELS in
# scripts/should-arm-automerge.sh; keep the two in step.
HOLD_LABELS='["hold","do-not-merge","do not merge","wip","blocked"]'

# classify: pure state machine over one JSON snapshot. The network layer
# below builds the same shape, so fixtures exercise the real decision path.
# Shape: {state, mergeState, failing: [names], cancelled: [names],
#         unresolvedThreads: n, labels: [names], queued: bool,
#         queuePos: n|null, queueState: str|null, queuedMinutes: n|null,
#         autoMerge: bool, ejectionReason: str|null,
#         failedEjectionsSinceChange: n}
# Fields added after the first release default when absent, so an older
# fixture still classifies the way it always did.
classify() {
  jq -r --argjson hold "$HOLD_LABELS" --argjson stall "$STALL_MINUTES" '
    ((.labels // []) | map(ascii_downcase)) as $labels
    | ([$hold[] | select(. as $h | $labels | index($h))] | first) as $heldBy
    | ((.autoMerge // false) or (.queued // false)) as $armed
    | if .state == "MERGED" then "MERGED"
    elif .state == "CLOSED" then "CLOSED"
    # An ejection outranks everything below it: it is the one event nothing
    # else reports. A failed-checks ejection is usually a flake (85% re-pass
    # unchanged), so a repeat with no new commit in between gets its own
    # token rather than the same one twice.
    elif .ejectionReason == "failed_checks" and (.failedEjectionsSinceChange // 1) >= 2
      then "EJECTED_REPEAT(failed_checks,\(.failedEjectionsSinceChange))"
    elif .ejectionReason != null then "EJECTED(\(.ejectionReason))"
    elif .mergeState == "DIRTY" then "CONFLICTING"
    elif (.failing | length) > 0 then "FAILING(\(.failing | join(",")))"
    # merge-tail refuses a PR with a cancelled check forever, so a cancelled
    # check is a stall the author has to see (should-arm: cancelled-checks).
    elif ((.cancelled // []) | length) > 0 then "CANCELLED(\(.cancelled | join(",")))"
    # A queued entry GitHub has marked UNMERGEABLE is stuck: it will never
    # merge and nothing else reports it — the entry still carries a position,
    # so without this branch it reads as a healthy QUEUED (a false green).
    # Precedence EJECTED > CONFLICTING > FAILING > STUCK_UNMERGEABLE:
    # EJECTED/CONFLICTING/FAILING each name a MORE specific cause of the same
    # stuck-ness (already dropped from the queue / a dirty tree / a named red
    # check), so when one of those is also true it is the better report. Above
    # STALLED_IN_QUEUE and QUEUED because UNMERGEABLE is a definite dead entry,
    # not "queued but slow". Fires ONLY on the explicit "UNMERGEABLE" string.
    elif .queued and (.queueState == "UNMERGEABLE") then "STUCK_UNMERGEABLE"
    # Measured by queue AGE, from enqueuedAt on the queue entry itself. The
    # old test (zero `gh pr checks` rows) could never fire: those rows are
    # the pull_request checks of the PR head, which every queued PR has by
    # definition, and merge-group runs never appear there.
    elif .queued and ((.queuedMinutes // 0) >= $stall) then "STALLED_IN_QUEUE(\(.queuedMinutes))"
    elif $heldBy != null and $armed then "HELD_BY_LABEL(\($heldBy),armed)"
    elif $heldBy != null then "HELD_BY_LABEL(\($heldBy))"
    elif (.unresolvedThreads // 0) > 0 and $armed then "UNRESOLVED_THREADS(\(.unresolvedThreads),armed)"
    elif (.unresolvedThreads // 0) > 0 then "UNRESOLVED_THREADS(\(.unresolvedThreads))"
    elif .mergeState == "CLEAN" and (.autoMerge | not) and (.queued | not) then "UNARMED_CLEAN"
    elif .queued then "QUEUED(\(.queuePos // "?"))"
    else "PENDING"
    end'
}

# remedy: the exact text printed after a token, or nothing for an
# informational one. $1 = token, $2 = PR number (fills <n>; optional).
remedy() {
  local token=$1 n=${2:-<n>} text=""
  case "$token" in
    'EJECTED(failed_checks)')
      text="Ejected by a failed check in the merge queue. Most of these (85% over 30 days) pass unchanged on re-entry. Do not push and do not rerun. Read the failing merge-group job first: if it covers a package you changed, run its tests locally and fix only if they fail. If the failure is not yours (the same job red on main or in other groups, or a flaky or infra error in its log), re-arm it once yourself: gh pr merge --auto $n. Green PR checks do not prove it is not yours: the browser tests run only in the queue. merge-tail would re-arm it too, but GitHub throttles its schedule to roughly every 2-3 hours." ;;
    EJECTED_REPEAT*)
      text="Ejected again for failed checks with no new commit in between. Find the failing job in each merge-group run: gh run list --event merge_group -L 100 --json headBranch,name,conclusion,databaseId, keeping rows whose headBranch contains pr-$n-. The same job each time: treat it as real and do not re-arm it; it is a regression only the queue can see. Read the log, reproduce it locally, fix and push (merge-tail will not re-arm it either until a new commit lands). Only if that job is red on main too, wait for the fix there, then re-arm. Different jobs: likely flaky, so re-arm it: gh pr merge --auto $n." ;;
    'EJECTED(merge_conflict)' | 'EJECTED(invalid_merge_commit)' | 'EJECTED(git_tree_invalid)')
      text="Rebase onto origin/main and push once, then arm it once its checks are green: gh pr merge --auto $n." ;;
    'EJECTED(manual)')
      text="Someone took this PR out of the queue on purpose. Read the timeline and comments before re-arming." ;;
    'EJECTED(checks_timed_out)')
      text="The queue timed out waiting for checks: a queue or runner stall, not your PR. Do not push and do not rerun. Re-arm it once the stall clears: gh pr merge --auto $n. If it repeats, check githubstatus.com." ;;
    EJECTED*)
      text="Read the PR timeline for the reason before acting. Do not push to re-roll the queue." ;;
    CONFLICTING)
      text="Rebase onto origin/main and push once. A conflicting PR runs no CI and no review, so if no review has ever run on this PR, add the re-review label after the push. Arm it once checks are green: gh pr merge --auto $n." ;;
    FAILING*)
      text="Read the failing log first. Caused by your change: fix it and push. Not yours (the same job is red on main or on other PRs, or the log shows an infra error such as a lost runner): gh run rerun <run-id> --failed, once. If main was broken when this ran and is fixed now, rebase onto origin/main and push once, because a rerun replays the old merge commit. Never push an empty commit." ;;
    CANCELLED*)
      text="A check was cancelled, and merge-tail never arms a PR with a cancelled check. Re-run that run once: gh run rerun <run-id>." ;;
    STUCK_UNMERGEABLE)
      text="A dead queue entry that will never merge. If it is still here after 10 minutes, clear it with the dequeue recipe in the creating-pull-requests skill, then gh pr merge --auto $n." ;;
    STALLED_IN_QUEUE*)
      text="Queued far longer than normal (the queue's p90 is about 55 minutes): a queue or runner stall, not your PR. Do not push, rerun or re-arm. Check githubstatus.com and the merge_group runs." ;;
    HELD_BY_LABEL*,armed\))
      text="Armed despite a hold label: the merge queue does not read labels, so this merges once green. If the hold is real, disarm it: gh pr merge --disable-auto $n." ;;
    HELD_BY_LABEL*)
      text="A hold label is on this PR, so merge-tail will not arm it and nothing will land it. Leave the label alone unless you added it and the reason is gone." ;;
    UNRESOLVED_THREADS*,armed\))
      text="Armed or queued: the queue does not wait for review threads, so this PR merges with them open. Address or resolve them now, or disarm while you work: gh pr merge --disable-auto $n." ;;
    UNRESOLVED_THREADS*)
      text="merge-tail will not arm this PR until every review thread is resolved, outdated ones included. Address or resolve them." ;;
    UNARMED_CLEAN)
      text="Green and unarmed. Arm it now: gh pr merge --auto $n. Arming is idempotent and safe; do not merge it directly. merge-tail would arm it too, but GitHub throttles its schedule to roughly every 2-3 hours." ;;
    WATCHER\ BLIND*)
      text="The watcher cannot read GitHub (auth, network or rate limit). Check gh auth status and gh api rate_limit, and look at the PR directly: gh pr checks $n." ;;
  esac
  printf '%s' "$text"
}

# One report line: `PR #n -> TOKEN`, plus ` :: remedy` when there is one.
report() { # $1 = PR, $2 = prefix after "PR #n" (" ->" or " RECOVERED ->"), $3 = token
  local text
  text=$(remedy "$3" "$1")
  if [ -n "$text" ]; then
    printf 'PR #%s%s %s :: %s\n' "$1" "$2" "$3" "$text"
  else
    printf 'PR #%s%s %s\n' "$1" "$2" "$3"
  fi
}

if [ "$CLASSIFY" = 1 ]; then
  classify
  exit 0
fi

if [ -n "$REMEDY" ]; then
  remedy "$REMEDY" "${PRS[0]:-}"
  printf '\n'
  exit 0
fi

[ ${#PRS[@]} -gt 0 ] || [ -n "$PROBE" ] || usage_error
# --probe takes exactly one PR: a stray extra argument (e.g. `--probe 42 43`)
# must be a usage error, not a silent "PROBE wins, the rest is ignored".
if [ -n "$PROBE" ] && [ ${#PRS[@]} -gt 0 ]; then
  usage_error "--probe takes exactly one PR; got extra argument(s): ${PRS[*]}"
fi

# SKILL.md's own rule for this script: "a watcher that dies must say so."
# `gh repo view` is the one call with no retry path below it — every other
# `gh`/API failure in this script degrades to a snapshot the loop already
# knows how to treat as transient (the {"state":"ERR"} sentinel, reported as
# WATCHER BLIND when it persists). This one runs once, before any PR is ever
# watched, so a silent failure here would exit the script with no output at
# all rather than an announced death.
REPO_JSON=$(gh repo view --json owner,name) || { echo "WATCHER DIED: gh repo view failed — check auth/network" >&2; exit 4; }
OWNER=$(jq -r .owner.login <<<"$REPO_JSON")
REPO=$(jq -r .name <<<"$REPO_JSON")

snapshot() { # $1 = PR number; prints the classify() input JSON
  local pr=$1
  local gql
  gql=$(gh api graphql -f query='
    query($o:String!,$r:String!,$n:Int!){
      repository(owner:$o,name:$r){ pullRequest(number:$n){
        state mergeStateStatus isDraft
        labels(first:30){ nodes { name } }
        autoMergeRequest { enabledAt }
        mergeQueueEntry { position state enqueuedAt }
        reviewThreads(first:100){ nodes { isResolved } }
        timelineItems(last:30, itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT]){
          nodes {
            __typename
            ... on RemovedFromMergeQueueEvent { createdAt reason }
          } }
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
  # {"state":"ERR"} sentinel the GraphQL call above uses.
  local checks_raw rc
  rc=0
  checks_raw=$(gh pr checks "$pr" 2>/dev/null) || rc=$?
  local failing cancelled checks_reported
  if [ -z "$checks_raw" ]; then
    case "$rc" in
      0 | 1 | 8) failing='[]'; cancelled='[]'; checks_reported=0 ;; # a real zero-check PR
      *) echo '{"state":"ERR"}'; return ;;                          # the call itself failed
    esac
  else
    # awk, not grep, excludes Vercel: grep -v exits 1 on no-match (e.g. zero
    # non-Vercel failures), which would re-trip the same pipefail trap this
    # fix removes upstream. awk always exits 0 regardless of match count.
    failing=$(printf '%s\n' "$checks_raw" | awk -F'\t' '$2=="fail" && tolower($1) !~ /^vercel/ {print $1}' | jq -R . | jq -cs .)
    cancelled=$(printf '%s\n' "$checks_raw" | awk -F'\t' '$2=="cancel" && tolower($1) !~ /^vercel/ {print $1}' | jq -R . | jq -cs .)
    checks_reported=$(printf '%s\n' "$checks_raw" | wc -l | tr -d ' ')
  fi
  jq -c --argjson failing "$failing" --argjson cancelled "$cancelled" --argjson reported "${checks_reported:-0}" '
    .data.repository.pullRequest as $p
    | ($p.timelineItems.nodes // []) as $items
    | ([$items[] | select(.__typename == "RemovedFromMergeQueueEvent")]) as $removals
    # The last commit or force-push in the timeline is the last CHANGE; the
    # failed-checks ejections after it are the ones that re-ran the same code.
    | ([$items | to_entries[] | select(.value.__typename != "RemovedFromMergeQueueEvent") | .key] | max // -1) as $lastChange
    | {
      state: $p.state,
      mergeState: $p.mergeStateStatus,
      isDraft: ($p.isDraft // false),
      labels: [($p.labels.nodes // [])[] | .name],
      failing: $failing,
      cancelled: $cancelled,
      # Every unresolved thread, outdated ones included: the same count
      # merge-tail uses (merge-tail.yml, isResolved == false), so the watcher
      # and the bot agree on whether threads block arming.
      unresolvedThreads: ([($p.reviewThreads.nodes // [])[] | select(.isResolved | not)] | length),
      queued: ($p.mergeQueueEntry != null),
      queuePos: ($p.mergeQueueEntry.position // null),
      queueState: ($p.mergeQueueEntry.state // null),
      queuedMinutes: (try ((now - ($p.mergeQueueEntry.enqueuedAt | fromdateiso8601)) / 60 | floor)
                      catch null),
      autoMerge: ($p.autoMergeRequest != null),
      # only report an ejection observed while we were watching (see loop)
      lastEjectionAt: ($removals | map(.createdAt) | max // null),
      lastEjectionReason: ($removals | sort_by(.createdAt) | last.reason // null),
      failedEjectionsSinceChange: ([$items | to_entries[]
        | select(.key > $lastChange and .value.__typename == "RemovedFromMergeQueueEvent" and .value.reason == "failed_checks")]
        | length),
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

# A failing `gh` used to be retried in silence forever, so a logged-out or
# rate-limited watcher looked exactly like a quiet healthy one. After this
# many ERR cycles in a row it says WATCHER BLIND, once, and keeps trying. A
# watcher that will not live that long reports on its last cycle instead.
BLIND_AFTER=3
if [ "$ONCE" = 1 ]; then BLIND_AFTER=1; fi
if [ "$MAX_CYCLES" -gt 0 ] && [ "$MAX_CYCLES" -lt "$BLIND_AFTER" ]; then BLIND_AFTER=$MAX_CYCLES; fi

# Per-PR state in indexed arrays (macOS ships bash 3.2: no `declare -A`).
LAST=(); ERR_CYCLES=(); BASELINE_EJECTION=()
i=0
for pr in "${PRS[@]}"; do LAST[i]=""; ERR_CYCLES[i]=0; BASELINE_EJECTION[i]=""; i=$((i + 1)); done
cycle=0
while true; do
  cycle=$((cycle + 1))
  open=0
  i=-1
  for pr in "${PRS[@]}"; do
    i=$((i + 1))
    snap=$(snapshot "$pr")
    if [ "$(jq -r .state <<<"$snap")" = "ERR" ]; then
      open=1
      ERR_CYCLES[i]=$((ERR_CYCLES[i] + 1))
      if [ "${ERR_CYCLES[i]}" -eq "$BLIND_AFTER" ]; then
        report "$pr" " ->" "WATCHER BLIND(${ERR_CYCLES[i]} cycles)"
        LAST[i]="WATCHER BLIND"
      fi
      continue
    fi
    ERR_CYCLES[i]=0
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
    cur=$(jq -c --argjson ej "$ej_reason" '. + {ejectionReason: $ej}' <<<"$snap" | classify)
    prev="${LAST[i]}"
    if [ "$cur" != "$prev" ]; then
      case "$cur" in
        PENDING|QUEUED*)
          case "$prev" in
            FAILING*|CANCELLED*|CONFLICTING|STALLED_IN_QUEUE*|STUCK_UNMERGEABLE|"WATCHER BLIND") report "$pr" " RECOVERED ->" "$cur" ;;
            "") : ;; # first sight of a healthy PR: stay quiet
            *) report "$pr" " ->" "$cur" ;;
          esac ;;
        *) report "$pr" " ->" "$cur" ;;
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
