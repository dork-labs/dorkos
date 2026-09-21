#!/usr/bin/env bash
# Reclaim the Docker containers, volumes and networks that killed runs leave behind.
#
# Why this exists: a `trap ... EXIT` cleanup does not run when the shell is
# SIGKILLed, and on a busy multi-agent machine kills are ordinary — memory
# pressure, a watchdog, a reaped agent. A detached container outlives whatever
# started it, so every killed run left a live container plus a full Postgres data
# directory behind. That ratchet reached 1,025 volumes / 110.6 GB before anyone
# noticed. Cleanup that depends on this process exiting is not cleanup here; the
# only thing that survives a kill is a LATER run sweeping up after its dead
# predecessors.
#
# The sweep is ownership-first, not age-first. Every object we create carries the
# pid that created it AND that pid's start time, so:
#
#   owner process gone      -> orphan, removed immediately, however young
#   owner process alive     -> in use, left alone, however old
#   owner unknown           -> removed once older than MAX_AGE_SECONDS
#
# Age alone would wait out MAX_AGE before reclaiming a plainly dead run, and
# would eventually shoot a slow live one. "Is the owner still there" answers both
# correctly. The start time is what makes the pid trustworthy: pids are recycled,
# so a live process wearing a dead run's number must not inherit its containers.
# We compare the start-time STRING produced by the same `ps` invocation at label
# time and at check time, which sidesteps every date-parsing difference between
# BSD and GNU userland.
#
# This can only reason about owners on THIS machine. A container started from a
# different Docker context has no matching local process, so it is unknowable and
# falls through to the age rule — correct, and the reason the age rule stays.
#
# Usage:
#   sweep-ephemeral-docker.sh                 sweep, print one summary line
#   sweep-ephemeral-docker.sh --print-labels $$   emit the --label args a creator uses
#
# Tested by scripts/test-sweep-ephemeral-docker.sh (stubbed docker, no daemon).
set -euo pipefail

LABEL="${DORKOS_EPHEMERAL_LABEL:-dorkos.ephemeral}"
MAX_AGE_SECONDS="${DORKOS_EPHEMERAL_MAX_AGE_SECONDS:-7200}"

# The start time of a pid, whitespace squeezed so the whole thing is one label
# value with no quoting anywhere.
#
# Three outcomes, and the difference between the last two is the difference
# between reclaiming disk and deleting a running test's database:
#   0 + the start time  the process is alive
#   1                   `ps` answered, and there is no such process
#   2                   `ps` could not answer at all
#
# `ps` exits 1 with no output for a missing pid on both BSD and GNU userland;
# anything else (no binary on PATH, a hardened hidepid, a pid in another
# namespace) is unknowable, and the caller must KEEP on unknowable.
#
# LC_ALL and TZ are pinned because `lstart` renders in the caller's locale and
# zone: the same live process reads as "Mon Sep 21 04:35:51 2026" here and
# "lun. 21 sept. 04:35:51 2026" or "Mon Sep 21 09:35:51 2026" under another
# environment. Agents are launched from different environments on one machine,
# so without this a stamp and its check disagree and a live run gets swept.
owner_started_at() {
  local pid="$1" started rc=0
  started="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" 2>/dev/null)" || rc=$?
  if ((rc != 0)); then
    ((rc == 1)) && return 1
    return 2
  fi
  # shellcheck disable=SC2001 # tr would collapse the trailing newline too.
  started="$(echo "$started" | sed 's/[[:space:]][[:space:]]*/-/g; s/^-//; s/-$//')"
  # Exit 0 and nothing to show is not an answer either.
  [[ -n "$started" ]] || return 2
  echo "$started"
}

# The owner pid is the CALLER's, passed in explicitly. Using this script's own
# `$$` would stamp objects with a process that exits the same instant, and the
# next sweep would read every live run as an orphan. `$$` is invariant inside a
# command substitution, so the caller writes `--print-labels "$$"`.
print_labels() {
  local pid="${1:-}" started
  [[ "$pid" =~ ^[0-9]+$ ]] || { echo "usage: $0 --print-labels <owner-pid>" >&2; return 2; }
  started="$(owner_started_at "$pid")" || { echo "$0: cannot read the start time of pid $pid" >&2; return 2; }
  echo "--label $LABEL=1 --label $LABEL.owner=$pid --label $LABEL.owner-started=$started --label $LABEL.created=$(date +%s)"
}

# Read this object's three stamps in ONE inspect call, as `owner|started|created`.
# A missing KEY yields the empty string, but a missing map is a template error, so
# a non-zero exit here means we cannot reason about this object at all.
#
# Containers keep their labels under .Config.Labels; volumes and networks keep
# theirs at the top level. Getting that wrong reads every label as absent, which
# an age-only fallback then turns into "delete everything" — so the caller treats
# a failed inspect as a reason to KEEP. Deletion is the irreversible direction.
inspect_stamps() {
  local kind="$1" id="$2" path='.Labels'
  [[ "$kind" == container ]] && path='.Config.Labels'
  docker "$kind" inspect -f \
    "{{index $path \"$LABEL\"}}|{{index $path \"$LABEL.owner\"}}|{{index $path \"$LABEL.owner-started\"}}|{{index $path \"$LABEL.created\"}}" \
    "$id" 2>/dev/null
}

# true when this object belongs to a run that is no longer with us.
is_orphan() {
  local kind="$1" id="$2" stamps marker owner started created live rc=0 now age
  stamps="$(inspect_stamps "$kind" "$id")" || return 1
  IFS='|' read -r marker owner started created <<<"$stamps"

  # Re-check the marker on the object itself rather than trusting the listing
  # that produced it. `--filter label=` is one token, and if it is ever dropped
  # or misspelled this function would otherwise read every container on the
  # machine as unstamped, which the age fallback below turns into a force-remove.
  [[ "$marker" == 1 ]] || return 1

  if [[ -n "$owner" && -n "$started" ]]; then
    live="$(owner_started_at "$owner")" || rc=$?
    # Unknowable owner: keep. This is the same call the header promises falls
    # through to the age rule, and it must not fall through to deletion.
    ((rc == 2)) && return 1
    ((rc == 1)) && return 0
    # A live owner keeps its objects no matter how long the run has taken. A
    # recycled pid reports a different start time, so it does not shield them.
    [[ "$live" != "$started" ]]
    return
  fi

  # No usable owner: fall back to age. Unstamped objects can only come from an
  # older version of this script, so treat a missing timestamp as ancient.
  [[ "$created" =~ ^[0-9]+$ ]] || return 0
  now="$(date +%s)"
  age=$((now - created))
  ((age > MAX_AGE_SECONDS))
}

sweep_kind() {
  local kind="$1" id swept=0
  local -a list=(docker "$kind" ls --quiet --filter "label=$LABEL")
  # Only `container ls` hides stopped objects by default, and only it accepts
  # --all; volumes and networks have no such state to hide.
  [[ "$kind" == container ]] && list+=(--all)

  # --filter label=<key> matches on the key alone, so one listing covers every
  # object this script ever created, whatever its values. `is_orphan` re-checks
  # the marker anyway: this filter is an optimisation, not the safety boundary.
  for id in $("${list[@]}" 2>/dev/null || true); do
    if is_orphan "$kind" "$id"; then
      case "$kind" in
        # --volumes takes the container's anonymous volumes with it, which is
        # what leaked before we started naming and labelling ours.
        container) docker rm --force --volumes "$id" >/dev/null 2>&1 || continue ;;
        *) docker "$kind" rm "$id" >/dev/null 2>&1 || continue ;;
      esac
      swept=$((swept + 1))
    fi
  done
  echo "$swept"
}

main() {
  if [[ "${1:-}" == --print-labels ]]; then
    print_labels "${2:-}"
    return
  fi

  # A sweep is a courtesy, never the thing that fails a run: whoever called us
  # is about to need Docker and will report its absence far better than we can.
  docker info >/dev/null 2>&1 || return 0

  local containers volumes networks
  # Containers first: a container holds its volume and its network, and neither
  # can be removed while it exists.
  containers="$(sweep_kind container)"
  volumes="$(sweep_kind volume)"
  networks="$(sweep_kind network)"

  if ((containers + volumes + networks > 0)); then
    echo "Swept $containers container(s), $volumes volume(s), $networks network(s) from dead runs."
  fi
}

main "$@"
