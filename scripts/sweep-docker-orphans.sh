#!/usr/bin/env bash
# Reclaim the Docker disk that nobody owns any more: old anonymous volumes no
# container references, old build cache, and dangling images.
#
# Why this exists: on 2026-09-28 this Mac's disk filled to 3.8 GB free and Docker
# froze. The cause was 1,223 anonymous volumes (147 GB) plus about 21 GB of build
# cache. Agents start throwaway test databases, and the postgres and minio images
# declare a VOLUME, so every `docker run` without `--rm`, and every container
# killed or removed without `-v`, leaves an anonymous volume behind that nothing
# will ever mount again. scripts/sweep-ephemeral-docker.sh cannot see these: it
# only reclaims objects carrying its own `dorkos.ephemeral` label, and an
# anonymous volume made by someone else's container carries none. This is the
# machine-wide backstop for everything that label never reached.
#
# What it removes, and the conditions that ALL have to hold:
#
#   anonymous volume   the name is 64 hex characters (named volumes are never
#                      touched), Docker lists it as dangling, no container on
#                      the machine mounts it (running OR stopped, checked twice:
#                      once for the whole machine up front and once per volume
#                      right before removal), and its CreatedAt is older than
#                      the age floor (default 24 h). A date we cannot parse
#                      keeps the volume.
#   build cache        `docker builder prune --filter until=168h`: cache not
#                      used for 7 days.
#   dangling images    `docker image prune`: untagged layers only. Tagged
#                      images are never touched.
#
# It never removes a container. Exited containers older than 7 days are listed
# by name as a hint, because a stopped container may be someone's paused work
# and only its owner knows.
#
# Concurrency: another agent may start a container between our listing and our
# removal. The per-volume re-check narrows that window, and `docker volume rm`
# (never forced) closes it: Docker refuses to remove a volume any container
# references, and this script reads that refusal as "keep", not as an error.
#
# Exit status: 0 when the sweep ran, and also when Docker is not running (a
# notice is printed), so a nightly job never alerts because the laptop's Docker
# was asleep. 1 when something really failed: Docker is there but will not
# answer (frozen, permission denied), or a listing, a prune, or a removal failed
# for a reason other than "in use". 2 on bad usage or when not run by bash.
#
# Usage:
#   sweep-docker-orphans.sh [--dry-run] [--min-age-hours N]
#
#   --dry-run          print what would be removed; remove nothing
#   --min-age-hours N  age floor for anonymous volumes (default 24, or
#                      $DORKOS_DOCKER_ORPHAN_MIN_AGE_HOURS)
#
#   $DORKOS_DOCKER_ORPHAN_PROBE_SECONDS  how long to wait for `docker info`
#                      before calling Docker frozen (default 60)
#
# Running it nightly on macOS: a LaunchAgent template sits beside this script at
# scripts/launchd/ai.dorkos.docker-orphan-sweep.plist.example. It runs this
# script with /bin/bash at 03:17 local time and appends to
# ~/Library/Logs/dorkos-docker-sweep.log. Nothing installs it; to opt in, run
# this from the root of a checkout that stays put (not a worktree):
#
#   sed -e "s|__REPO__|$PWD|g" -e "s|__HOME__|$HOME|g" \
#     scripts/launchd/ai.dorkos.docker-orphan-sweep.plist.example \
#     > ~/Library/LaunchAgents/ai.dorkos.docker-orphan-sweep.plist
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.dorkos.docker-orphan-sweep.plist
#
# Try `--dry-run` by hand first. If the Mac is asleep at 03:17, launchd runs the
# job once on wake. The plist's own comment has the kickstart, reinstall and
# bootout lines.
#
# Written for the bash 3.2 that ships as /bin/bash on macOS (no associative
# arrays, no mapfile), because that is the shell launchd runs it with.
#
# Tested by scripts/test-sweep-docker-orphans.sh (stubbed docker, no daemon).

# Bash only. Under zsh, `BASH_REMATCH` is never set, the date parser returns an
# empty age that reads as "ancient", and a young volume would go. POSIX sh
# would fail later and less clearly. Refuse both before anything runs.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "sweep-docker-orphans.sh: run it with bash (e.g. /bin/bash $0)" >&2
  exit 2
fi
set -euo pipefail

# Docker's human sizes and the dates we compare are locale- and zone-free this
# way; a sweep started from a shell in another locale must reach the same answer.
export LC_ALL=C TZ=UTC

DRY_RUN=0
MIN_AGE_HOURS="${DORKOS_DOCKER_ORPHAN_MIN_AGE_HOURS:-24}"
BUILD_CACHE_UNTIL=168h
STALE_CONTAINER_DAYS=7

usage() {
  echo "usage: $0 [--dry-run] [--min-age-hours N]" >&2
}

# Seconds since the epoch for an RFC 3339 timestamp, as Docker writes them:
# `2026-09-28T05:27:24Z`, `2026-09-28T05:27:24.123456789Z`, or with an offset
# such as `2026-09-28T07:27:24+02:00` (older Linux engines write local time).
#
# Pure arithmetic on purpose. `date -d` is GNU, `date -j -f` is BSD, and both
# read the caller's zone; a parser that answered differently on another machine
# or another shell would misjudge a volume's age in the deleting direction.
# Anything that does not match exactly returns 1, and the caller keeps.
rfc3339_to_epoch() {
  local ts="$1"
  local re='^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
  [[ "$ts" =~ $re ]] || return 1
  local y=$((10#${BASH_REMATCH[1]})) m=$((10#${BASH_REMATCH[2]})) d=$((10#${BASH_REMATCH[3]}))
  local hh=$((10#${BASH_REMATCH[4]})) mi=$((10#${BASH_REMATCH[5]})) ss=$((10#${BASH_REMATCH[6]}))
  local zone="${BASH_REMATCH[8]}"
  ((m >= 1 && m <= 12 && d >= 1 && d <= 31 && hh <= 23 && mi <= 59 && ss <= 60)) || return 1
  # Days from 1970-01-01 to y-m-d (proleptic Gregorian), Hinnant's days_from_civil.
  local yy=$((m <= 2 ? y - 1 : y))
  local era=$((yy / 400))
  local yoe=$((yy - era * 400))
  local doy=$(((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1))
  local doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  local days=$((era * 146097 + doe - 719468))
  local epoch=$((days * 86400 + hh * 3600 + mi * 60 + ss))
  if [[ "$zone" != Z ]]; then
    local sign="${zone:0:1}" oh=$((10#${zone:1:2})) om=$((10#${zone:4:2}))
    local offset=$((oh * 3600 + om * 60))
    # Local time is AHEAD of UTC by a positive offset, so UTC is local minus it.
    if [[ "$sign" == + ]]; then epoch=$((epoch - offset)); else epoch=$((epoch + offset)); fi
  fi
  echo "$epoch"
}

# Docker's human sizes (`51.17MB`, `15.76kB`, `0B`) to bytes. Docker's units
# are decimal (go-units HumanSize). Unknown input prints nothing.
size_to_bytes() {
  awk -v s="$1" 'BEGIN {
    if (match(s, /^[0-9.]+/) == 0) exit
    n = substr(s, 1, RLENGTH); u = substr(s, RLENGTH + 1)
    m["B"] = 1; m["kB"] = 1e3; m["KB"] = 1e3; m["MB"] = 1e6; m["GB"] = 1e9; m["TB"] = 1e12
    if (!(u in m)) exit
    printf "%.0f\n", n * m[u]
  }'
}

human_bytes() {
  awk -v b="$1" 'BEGIN {
    split("B kB MB GB TB", u, " "); i = 1
    while (b >= 1000 && i < 5) { b /= 1000; i++ }
    if (i == 1) printf "%dB\n", b; else printf "%.2f%s\n", b, u[i]
  }'
}

# Every volume any container on the machine mounts, running or stopped, one name
# per line. A failure here returns 1 and the caller removes no volumes at all:
# without this list we cannot tell a dangling volume from a stopped one's data.
# Only builtins touch the result after Docker answers: bash 3.2 backs a
# here-string with a temp file, and on the full disk this sweep exists for, a
# failed write must not come back as an empty list that "succeeded".
#
# A container removed between the listing and the inspect makes the inspect
# fail for the whole batch, and agents churn containers all day, so a few
# attempts are made before giving up.
referenced_volumes() {
  local ids out attempt
  for attempt in 1 2 3; do
    ids="$(docker ps --all --quiet --no-trunc)" || return 1
    if [[ -z "$ids" ]]; then
      return 0
    fi
    # shellcheck disable=SC2086 # one id per word, on purpose
    if out="$(docker container inspect \
      --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{println}}{{end}}{{end}}' \
      $ids 2>/dev/null)"; then
      printf '%s\n' "$out"
      return 0
    fi
    if ((attempt < 3)); then sleep "$attempt"; fi
  done
  return 1
}

# true when $1 is one whole line of $2. Pure bash on purpose: a `grep` here
# would read "grep itself failed" the same as "no match", which is the
# direction that deletes.
is_listed() {
  case $'\n'"$2"$'\n' in
    *$'\n'"$1"$'\n'*) return 0 ;;
  esac
  return 1
}

# Name|Size for every volume, from `docker system df -v`. Sizes are only for the
# report, so a failure yields nothing and the summary says the size is unknown.
#
# Line breaks in every template here are `{{println}}`, never `{{"\n"}}`: the
# `system df` formatter rewrites a literal backslash-n into a real newline before
# parsing, which leaves the quoted string unterminated and fails the template.
volume_sizes() {
  docker system df -v --format '{{range .Volumes}}{{.Name}}|{{.Size}}{{println}}{{end}}' 2>/dev/null | sed '/^$/d' || true
}

errors=0
note_error() {
  echo "error: $*" >&2
  errors=$((errors + 1))
}

sweep_volumes() {
  local now="$1" floor=$((MIN_AGE_HOURS * 3600))
  local listed referenced sizes name created epoch age users out size bytes
  local removed=0 kept_in_use=0 kept_young=0 kept_unknown=0 total_bytes=0 unsized=0

  if ! listed="$(docker volume ls --quiet --filter dangling=true)"; then
    note_error "could not list dangling volumes; removed none"
    return
  fi
  if ! referenced="$(referenced_volumes)"; then
    note_error "could not list the volumes containers mount; removed none"
    return
  fi
  sizes="$(volume_sizes)"

  for name in $listed; do
    # Named volumes are someone's on purpose. Only Docker's own 64-hex names are
    # anonymous, and that is the only shape this sweep will consider.
    [[ "$name" =~ ^[0-9a-f]{64}$ ]] || continue
    # The dangling filter is Docker's word; the machine-wide mount list is ours.
    # Both must agree, so a filter that ever misbehaves cannot cost a stopped
    # container its data.
    if is_listed "$name" "$referenced"; then
      kept_in_use=$((kept_in_use + 1))
      continue
    fi

    if ! created="$(docker volume inspect --format '{{.CreatedAt}}' "$name" 2>/dev/null)"; then
      kept_unknown=$((kept_unknown + 1))
      continue
    fi
    if ! epoch="$(rfc3339_to_epoch "$created")"; then
      kept_unknown=$((kept_unknown + 1))
      continue
    fi
    age=$((now - epoch))
    if ((age <= floor)); then
      kept_young=$((kept_young + 1))
      continue
    fi

    # Right before removing, ask again whether any container mounts it now. A
    # container started since the listing above wins.
    if ! users="$(docker ps --all --quiet --filter "volume=$name")"; then
      kept_unknown=$((kept_unknown + 1))
      continue
    fi
    if [[ -n "$users" ]]; then
      kept_in_use=$((kept_in_use + 1))
      continue
    fi

    size="$(awk -F'|' -v n="$name" '$1 == n { print $2; exit }' <<<"$sizes")"
    bytes="$(size_to_bytes "$size")"

    if ((DRY_RUN)); then
      echo "would remove volume $name (${size:-size unknown}, $((age / 3600))h old)"
    else
      # Never --force: Docker's refusal on a volume in use is the last guard
      # against a container that started a moment ago.
      if ! out="$(docker volume rm "$name" 2>&1)"; then
        case "$out" in
          # "volume is in use" from the daemon, "volume has active mounts"
          # from the local driver: both mean a container got there first.
          *"in use"* | *"active mounts"*) kept_in_use=$((kept_in_use + 1)) ;;
          *"no such volume"* | *"No such volume"*) ;;
          *) note_error "could not remove volume $name: $out" ;;
        esac
        continue
      fi
      echo "removed volume $name (${size:-size unknown})"
    fi
    removed=$((removed + 1))
    if [[ -n "$bytes" ]]; then total_bytes=$((total_bytes + bytes)); else unsized=$((unsized + 1)); fi
  done

  local verb=removed size_note
  if ((DRY_RUN)); then verb="would remove"; fi
  size_note="$(human_bytes "$total_bytes")"
  if ((unsized > 0)); then size_note="$size_note, plus $unsized of unknown size"; fi
  echo "volumes: $verb $removed anonymous volume(s) ($size_note); kept $kept_in_use in use, $kept_young younger than ${MIN_AGE_HOURS}h, $kept_unknown unreadable"
}

# The size a prune reports reclaiming, or 0B when it reports none. `docker image
# prune` (and the legacy builder) end with `Total reclaimed space: X`; the buildx
# builder that Docker Desktop ships ends its table with `Total:<tab>X`.
reclaimed_from() {
  local got
  got="$(sed -n -E 's/^Total( reclaimed space)?:[[:space:]]*//p' <<<"$1" | tail -1)"
  echo "${got:-0B}"
}

sweep_build_cache() {
  local out
  if ((DRY_RUN)); then
    # `docker builder prune` has no dry run, and `docker buildx du --filter`
    # does not narrow its listing, so the honest preview is the total.
    local total
    total="$(docker system df --format '{{.Type}}|{{.Size}}' 2>/dev/null || true)"
    total="$(awk -F'|' '$1 == "Build Cache" { print $2; exit }' <<<"$total")"
    echo "build cache: would prune entries unused for $BUILD_CACHE_UNTIL (${total:-unknown} of build cache in total now; Docker cannot preview the aged share)"
    return
  fi
  if ! out="$(docker builder prune --force --filter "until=$BUILD_CACHE_UNTIL" 2>&1)"; then
    note_error "build cache prune failed: $out"
    return
  fi
  echo "build cache: reclaimed $(reclaimed_from "$out") (entries unused for $BUILD_CACHE_UNTIL)"
}

sweep_images() {
  local out ids count
  if ((DRY_RUN)); then
    if ! ids="$(docker image ls --quiet --filter dangling=true)"; then
      note_error "could not list dangling images"
      return
    fi
    count="$(sed '/^$/d' <<<"$ids" | sort -u | wc -l | tr -d ' ')"
    echo "dangling images: would remove $count"
    return
  fi
  if ! out="$(docker image prune --force 2>&1)"; then
    note_error "dangling image prune failed: $out"
    return
  fi
  echo "dangling images: reclaimed $(reclaimed_from "$out")"
}

# Report only. A stopped container is the one thing here that may still be
# somebody's work in progress, so it gets a name in the log and nothing else.
report_stale_containers() {
  local now="$1" ids name finished epoch stale=""
  local floor=$((STALE_CONTAINER_DAYS * 86400))
  ids="$(docker ps --all --quiet --no-trunc --filter status=exited 2>/dev/null)" || return 0
  if [[ -z "$ids" ]]; then
    return 0
  fi
  # shellcheck disable=SC2086 # one id per word, on purpose
  while IFS='|' read -r name finished; do
    [[ -n "$name" ]] || continue
    epoch="$(rfc3339_to_epoch "$finished")" || continue
    if ((now - epoch > floor)); then stale="$stale ${name#/}"; fi
  done < <(docker container inspect --format '{{.Name}}|{{.State.FinishedAt}}' $ids 2>/dev/null || true)
  if [[ -n "$stale" ]]; then
    echo "hint: exited more than ${STALE_CONTAINER_DAYS} days ago, left alone:$stale"
    echo "      (remove one with \`docker rm -v <name>\` once you know nobody needs it)"
  fi
  return 0
}

# Is Docker there to sweep? Three answers, because the difference between the
# last two is the difference between a quiet night and a missed alert:
#   0  it answered
#   1  it is not running (the usual laptop-asleep case): say so, exit 0
#   2  it is there but will not answer: frozen, permission denied, a broken
#      context. That is exactly the state that let the disk fill, so it fails.
#
# `docker info` against a wedged Docker Desktop never returns, and launchd will
# not start the next night's run while this one is still going, so the probe is
# bounded. The rest of the sweep is not: a daemon that answers `info` answers
# the listings too.
probe_docker() {
  local timeout="${DORKOS_DOCKER_ORPHAN_PROBE_SECONDS:-60}" errfile pid watchdog rc=0 err
  errfile="$(mktemp 2>/dev/null)" || errfile=/dev/null
  docker info >/dev/null 2>"$errfile" &
  pid=$!
  # The watchdog stops only the probe we started, by the pid we hold. It is
  # itself stopped the moment the probe returns, so a pid recycled after the
  # probe exits is never in its sights; disown keeps bash from printing
  # "Terminated" for it.
  (
    i=0
    while ((i < timeout)); do
      kill -0 "$pid" 2>/dev/null || exit 0
      sleep 1
      i=$((i + 1))
    done
    kill "$pid" 2>/dev/null
  ) >/dev/null 2>&1 &
  watchdog=$!
  disown "$watchdog" 2>/dev/null || true
  wait "$pid" || rc=$?
  kill "$watchdog" 2>/dev/null || true
  err=""
  if [[ "$errfile" != /dev/null ]]; then
    err="$(cat "$errfile" 2>/dev/null || true)"
    rm -f "$errfile"
  fi
  ((rc == 0)) && return 0
  case "$err" in
    *"Cannot connect to the Docker daemon"* | *"Is the docker daemon running"* | \
      *"connect: no such file or directory"* | *"connect: connection refused"*)
      return 1
      ;;
  esac
  if ((rc > 128)); then
    echo "error: Docker did not answer within ${timeout}s; it may be frozen" >&2
  else
    echo "error: Docker is installed but did not answer: ${err:-no message}" >&2
  fi
  return 2
}

main() {
  while (($# > 0)); do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --min-age-hours)
        [[ $# -ge 2 ]] || { usage; return 2; }
        MIN_AGE_HOURS="$2"
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        usage
        return 2
        ;;
    esac
    shift
  done
  # No leading zeros and at most six digits: bash arithmetic reads `010` as
  # octal (8) and a huge number overflows to a negative floor, and both of
  # those shrink the floor, which is the deleting direction.
  if ! [[ "$MIN_AGE_HOURS" =~ ^(0|[1-9][0-9]{0,5})$ ]]; then
    echo "$0: --min-age-hours takes a whole number of hours, 0 to 999999, with no leading zeros" >&2
    return 2
  fi

  # A sleeping or absent Docker is not a failure for a nightly job.
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker orphan sweep: docker is not installed; nothing to do."
    return 0
  fi
  local state=0
  probe_docker || state=$?
  case "$state" in
    0) ;;
    1)
      echo "docker orphan sweep: Docker is not running; nothing to do."
      return 0
      ;;
    *) return 1 ;;
  esac

  local now
  now="$(date +%s)"
  local mode=""
  if ((DRY_RUN)); then mode="(dry run) "; fi
  echo "docker orphan sweep ${mode}at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sweep_volumes "$now"
  sweep_build_cache
  sweep_images
  report_stale_containers "$now"

  if ((errors > 0)); then
    echo "docker orphan sweep: finished with $errors error(s)" >&2
    return 1
  fi
}

main "$@"
