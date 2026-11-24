#!/usr/bin/env bash
# timed-slot.sh — is today's slot of a once-a-day workflow due, and not yet done?
#
#   scripts/timed-slot.sh due <workflow-file> <HH:MM>
#
# WHY. GitHub runs a scheduled workflow late, or not at all, when its cron is
# busy: daily-release.yml's '0 15 * * *' did not fire on its first day (Nov 24),
# and the */10 and */15 crons here fired a handful of times in three days
# (ledger 261124-161126). So a daily workflow that the release or the
# merge flow needs runs on two triggers: its cron, and a backstop on
# `workflow_run` of a workflow that completes after every push to main. Both
# call this first, inside the workflow's concurrency group, so at most one of
# them does the day's slot.
#
# `due` prints exactly one line:
#   DUE <marker>     do the slot now. When the slot's work finishes, the run
#                    uploads an artifact named <marker>
#                    (timed-slot-<workflow>-<YYYY-MM-DD>); that is "done".
#   NOT_DUE <why>    before today's <HH:MM> UTC; or a run of this workflow on
#                    main (the cron or the backstop, never a pull request)
#                    already uploaded today's marker; or MAX_FAILED (3) runs of
#                    it failed since today's slot, so the next try is tomorrow's
#                    slot (a dispatch still runs at once).
#
# A run proves "done" only through its own artifact, checked back to the run
# that uploaded it: on main, from this repository, from this workflow file, by
# the cron or the backstop. An artifact from a pull request's run never counts.
#
# Reads only (GitHub's Actions API, through `gh api`; GH overrides the binary).
# REPO defaults to $GITHUB_REPOSITORY, then dork-labs/dorkos. NOW (ISO 8601 UTC)
# overrides the clock. Exit codes: 0 an answer was printed; 2 usage, or GitHub
# could not be read (the run fails, and a failed run counts toward MAX_FAILED).
#
# Fixtures: scripts/test-timed-slot.sh.
set -uo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
MAX_FAILED=${MAX_FAILED:-3}

usage() {
  sed -n '4p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
err() {
  echo "timed-slot: $*" >&2
  exit 2
}

due() {
  local wf=$1 slot=$2 now today slot_at name ids id run failed
  [[ "$wf" =~ ^[A-Za-z0-9._-]+\.ya?ml$ ]] || usage
  [[ "$slot" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || usage
  now=${NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
  [[ "$now" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2})T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || err "NOW is not ISO 8601 UTC: $now"
  today=${BASH_REMATCH[1]}
  slot_at="${today}T${slot}:00Z"
  # ISO 8601 UTC strings of one shape compare in time order.
  if [[ "$now" < "$slot_at" ]]; then
    echo "NOT_DUE before today's $slot UTC slot"
    return 0
  fi

  name="timed-slot-${wf%.*}-$today"
  ids=$("$GH" api "repos/$REPO/actions/artifacts?name=$name&per_page=100" \
    --jq '[.artifacts[].workflow_run | select(.head_branch == "main" and .head_repository_id == .repository_id) | .id] | unique | .[]') ||
    err "could not list artifacts named $name"
  for id in $ids; do
    [[ "$id" =~ ^[0-9]+$ ]] || err "unexpected run id: $id"
    run=$("$GH" api "repos/$REPO/actions/runs/$id" \
      --jq '"\(.path // "" | split("@")[0]) \(.event) \(.head_branch)"') || err "could not read run $id"
    if [ "$run" = ".github/workflows/$wf schedule main" ] || [ "$run" = ".github/workflows/$wf workflow_run main" ]; then
      echo "NOT_DUE run $id already did today's $slot UTC slot"
      return 0
    fi
  done

  failed=$("$GH" api "repos/$REPO/actions/workflows/$wf/runs?created=%3E%3D$slot_at&status=failure&per_page=1" \
    --jq '.total_count') || err "could not count failed runs of $wf"
  [[ "$failed" =~ ^[0-9]+$ ]] || err "unexpected failed-run count: $failed"
  if [ "$failed" -ge "$MAX_FAILED" ]; then
    echo "NOT_DUE $failed runs failed since today's $slot UTC slot; the next try is tomorrow's"
    return 0
  fi

  echo "DUE $name"
}

case "${1:-}" in
  due)
    [ $# -eq 3 ] || usage
    due "$2" "$3"
    ;;
  *) usage ;;
esac
