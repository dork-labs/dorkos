#!/usr/bin/env bash
# Fixtures for scripts/sweep-docker-orphans.sh.
#
# Hermetic: a stub `docker` on PATH stands in for the daemon, so these run
# anywhere and never touch a real volume. This sweep's failure mode is DELETING
# something, so every keep case is paired with a positive control: the same
# object with the one protecting condition flipped, which the sweep must then
# remove. A keep case without its control could pass because the sweep never
# looked at anything.
#
# The sweep is run with /bin/bash, which on macOS is bash 3.2: that is the shell
# the launchd template runs it with, and the one a bash-4-ism would break.
set -uo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sweep="$script_dir/sweep-docker-orphans.sh"
pass=0
fail=0

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A stub daemon whose whole state is a directory tree:
#   state/volume/<name>/created          the CreatedAt string, verbatim
#   state/volume/<name>/size             the human size `system df -v` reports
#   state/container/<id>/mounts          volume names, one per line
#   state/container/<id>/name, status, finished
# Every call is appended to state/calls.log so a fixture can prove what the
# sweep did NOT do, which is the whole of --dry-run.
mkdir -p "$work/bin"
cat >"$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
state="$DOCKER_STUB_STATE"
echo "$*" >>"$state/calls.log"
# The real `system df` formatter turns a literal \n into a newline before it
# parses the template, so `{{"\n"}}` is a template error there. Rejected
# everywhere here so the sweep cannot drift back to it.
for arg in "$@"; do
  [[ "$arg" == *'{{"\n"}}'* ]] && { echo 'template parsing error: unterminated quoted string' >&2; exit 1; }
done
if [[ "$1" == info ]]; then
  if [[ -f "$state/daemon-down" ]]; then
    echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2
    exit 1
  fi
  if [[ -f "$state/daemon-denied" ]]; then
    echo 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock' >&2
    exit 1
  fi
  [[ -f "$state/daemon-frozen" ]] && sleep 5
  exit 0
fi

mounted_by() { # the ids of every container that mounts the named volume
  local vol="$1" c
  for c in "$state/container"/*; do
    [[ -d "$c" ]] || continue
    grep -qxF "$vol" "$c/mounts" 2>/dev/null && basename "$c"
  done
  return 0
}

case "$1 $2" in
  "volume ls")
    [[ -f "$state/break-volume-ls" ]] && { echo 'Error: daemon hiccup' >&2; exit 1; }
    for v in "$state/volume"/*; do
      [[ -d "$v" ]] || continue
      name="$(basename "$v")"
      # A daemon whose dangling filter lies, so the sweep's own mount check is
      # the only thing left standing and can be pinned by itself.
      if [[ -z "${DOCKER_STUB_DANGLING_LIES:-}" && -n "$(mounted_by "$name")" ]]; then continue; fi
      echo "$name"
    done
    ;;
  "volume inspect")
    name="${!#}"
    [[ -d "$state/volume/$name" ]] || { echo "Error: no such volume: $name" >&2; exit 1; }
    # A container that starts between the listing and the removal: it appears
    # the moment the sweep first looks closely at this volume.
    if [[ "${DOCKER_STUB_RACE_ATTACH:-}" == "$name" ]]; then
      mkdir -p "$state/container/racer"
      echo "$name" >"$state/container/racer/mounts"
      echo running >"$state/container/racer/status"
    fi
    cat "$state/volume/$name/created"
    ;;
  "volume rm")
    name="${!#}"
    # The same late start, one step later: after the sweep's own re-check,
    # before Docker's. Docker's refusal is the last guard.
    if [[ "${DOCKER_STUB_ATTACH_AT_RM:-}" == "$name" ]]; then
      mkdir -p "$state/container/late"
      echo "$name" >"$state/container/late/mounts"
    fi
    if [[ -n "${DOCKER_STUB_RM_ERROR:-}" ]]; then echo "$DOCKER_STUB_RM_ERROR" >&2; exit 1; fi
    if [[ -n "$(mounted_by "$name")" ]]; then
      echo "Error response from daemon: remove $name: volume is in use - [$(mounted_by "$name" | head -1)]" >&2
      exit 1
    fi
    rm -rf "${state:?}/volume/$name"
    echo "volume $name" >>"$state/removed.log"
    echo "$name"
    ;;
  "ps --all")
    shift
    want_status="" want_volume=""
    while (($# > 0)); do
      case "$1" in
        --filter) shift; case "$1" in status=*) want_status="${1#status=}" ;; volume=*) want_volume="${1#volume=}" ;; esac ;;
      esac
      shift
    done
    [[ -n "${DOCKER_STUB_BREAK_PS:-}" ]] && exit 1
    for c in "$state/container"/*; do
      [[ -d "$c" ]] || continue
      [[ -n "$want_status" && "$(cat "$c/status" 2>/dev/null)" != "$want_status" ]] && continue
      # A volume filter that matches nothing, so the machine-wide mount list can
      # be pinned without the per-volume re-check covering for it.
      [[ -n "$want_volume" && -n "${DOCKER_STUB_VOLUME_FILTER_LIES:-}" ]] && continue
      [[ -n "$want_volume" ]] && ! grep -qxF "$want_volume" "$c/mounts" 2>/dev/null && continue
      basename "$c"
    done
    ;;
  "container inspect")
    # A container removed mid-listing fails the whole batch; this knob fails
    # the first N inspects so the sweep's retry, and its give-up, can be pinned.
    if [[ -n "${DOCKER_STUB_INSPECT_FAILS:-}" ]]; then
      n="$(cat "$state/inspect-fails" 2>/dev/null || echo 0)"
      echo $((n + 1)) >"$state/inspect-fails"
      if ((n < DOCKER_STUB_INSPECT_FAILS)); then echo 'Error: No such container: gone' >&2; exit 1; fi
    fi
    fmt="$4"
    shift 4
    for id in "$@"; do
      c="$state/container/$id"
      [[ -d "$c" ]] || { echo "Error: No such container: $id" >&2; exit 1; }
      if [[ "$fmt" == *Mounts* ]]; then
        cat "$c/mounts" 2>/dev/null
        echo
      else
        echo "/$(cat "$c/name" 2>/dev/null || echo "$id")|$(cat "$c/finished" 2>/dev/null)"
      fi
    done
    ;;
  "system df")
    if [[ "$*" == *-v* ]]; then
      for v in "$state/volume"/*; do
        [[ -d "$v" ]] || continue
        echo "$(basename "$v")|$(cat "$v/size" 2>/dev/null || echo 0B)"
      done
    else
      echo "Images|1GB"
      echo "Build Cache|2.5GB"
    fi
    ;;
  "builder prune")
    echo "builder prune" >>"$state/removed.log"
    [[ -f "$state/break-builder" ]] && { echo 'ERROR: buildkit unavailable' >&2; exit 1; }
    printf 'ID\t\tRECLAIMABLE\tSIZE\nabc\t\ttrue\t\t1.5GB\nTotal:\t1.5GB\n'
    ;;
  "image ls")
    cat "$state/dangling-images" 2>/dev/null
    ;;
  "image prune")
    echo "image prune" >>"$state/removed.log"
    echo "Deleted Images:"
    echo "Total reclaimed space: 300MB"
    ;;
  *)
    echo "stub docker: unexpected call: $*" >&2
    exit 64
    ;;
esac
exit 0
STUB
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH"

run_sweep() { /bin/bash "$sweep" "$@"; }

reset_state() {
  DOCKER_STUB_STATE="$work/state.$RANDOM$RANDOM"
  export DOCKER_STUB_STATE
  mkdir -p "$DOCKER_STUB_STATE"/{volume,container}
  : >"$DOCKER_STUB_STATE/calls.log"
}

# 64 hex characters, as Docker names an anonymous volume.
anon() { printf '%064x' "$1"; }

# An RFC 3339 UTC timestamp for an epoch, on BSD or GNU date.
utc_stamp() {
  date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ
}
# The same instant written as local time at a fixed offset, e.g. +09:00, the way
# an engine running in that zone writes CreatedAt.
offset_stamp() {
  local epoch="$1" sign="$2" hours="$3" shifted
  if [[ "$sign" == + ]]; then shifted=$((epoch + hours * 3600)); else shifted=$((epoch - hours * 3600)); fi
  local s
  s="$(date -u -r "$shifted" +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d "@$shifted" +%Y-%m-%dT%H:%M:%S)"
  printf '%s%s%02d:00\n' "$s" "$sign" "$hours"
}

now="$(date +%s)"
hours_ago() { echo $((now - $1 * 3600)); }

make_volume() { # name created-string [size]
  mkdir -p "$DOCKER_STUB_STATE/volume/$1"
  printf '%s' "$2" >"$DOCKER_STUB_STATE/volume/$1/created"
  printf '%s' "${3:-10MB}" >"$DOCKER_STUB_STATE/volume/$1/size"
}
make_container() { # id status volume... ; name defaults to id
  local id="$1" status="$2"
  shift 2
  mkdir -p "$DOCKER_STUB_STATE/container/$id"
  echo "$status" >"$DOCKER_STUB_STATE/container/$id/status"
  echo "$id" >"$DOCKER_STUB_STATE/container/$id/name"
  : >"$DOCKER_STUB_STATE/container/$id/mounts"
  local v
  for v in "$@"; do echo "$v" >>"$DOCKER_STUB_STATE/container/$id/mounts"; done
}

removed() { grep -qx "volume $1" "$DOCKER_STUB_STATE/removed.log" 2>/dev/null; }
called() { grep -q "$1" "$DOCKER_STUB_STATE/calls.log"; }

check() {
  if [[ "$2" == true ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1"
  fi
}
yes_if() { if "$@"; then echo true; else echo false; fi; }
no_if() { if "$@"; then echo false; else echo true; fi; }

old="$(utc_stamp "$(hours_ago 48)")"
young="$(utc_stamp "$(hours_ago 2)")"

# 1. The case this exists for: old, anonymous, dangling. Removed.
reset_state
make_volume "$(anon 1)" "$old"
run_sweep >/dev/null
check "an old anonymous dangling volume is removed" "$(yes_if removed "$(anon 1)")"

# 2. A named volume is never touched, however old and unreferenced. The control
#    is the same volume under a Docker-made name.
reset_state
make_volume postgres_data "$old"
make_volume "$(anon 2)" "$old"
make_volume "ABCDEF$(anon 2 | cut -c7-)" "$old" # 64 chars, but not lowercase hex
make_volume "$(anon 2 | cut -c2-)" "$old"       # lowercase hex, but 63 chars
run_sweep >/dev/null
check "a named volume is never removed" "$(no_if removed postgres_data)"
check "a 64-char name that is not lowercase hex is kept" "$(no_if removed "ABCDEF$(anon 2 | cut -c7-)")"
check "a 63-char hex name is kept" "$(no_if removed "$(anon 2 | cut -c2-)")"
check "...while the anonymous twin goes (positive control)" "$(yes_if removed "$(anon 2)")"

# 3. A volume a STOPPED container still mounts is its data. Kept. The control
#    is the same volume once that container is gone.
reset_state
make_volume "$(anon 3)" "$old"
make_container stopped-db exited "$(anon 3)"
make_volume "$(anon 4)" "$old"
make_container running-db running "$(anon 4)"
run_sweep >/dev/null
check "a volume a stopped container mounts is kept" "$(no_if removed "$(anon 3)")"
check "a volume a running container mounts is kept" "$(no_if removed "$(anon 4)")"
rm -rf "$DOCKER_STUB_STATE/container/stopped-db"
run_sweep >/dev/null
check "...and is removed once that container is gone (positive control)" "$(yes_if removed "$(anon 3)")"

# 4. The dangling filter is Docker's word; the sweep checks the machine-wide
#    mount list too. Here Docker's dangling filter lies and lists everything,
#    and so does the per-volume re-check's filter, so only the machine-wide
#    mount list stands between a stopped container and its data.
reset_state
make_volume "$(anon 5)" "$old"
make_container paused-work exited "$(anon 5)"
make_volume "$(anon 6)" "$old"
DOCKER_STUB_DANGLING_LIES=1 DOCKER_STUB_VOLUME_FILTER_LIES=1 run_sweep >/dev/null
check "a lying dangling filter still spares a stopped container's volume" "$(no_if removed "$(anon 5)")"
check "...while a truly orphaned one still goes (positive control)" "$(yes_if removed "$(anon 6)")"
# And that it is the sweep's check doing the work, not Docker's refusal: the
# volume was never even offered to `docker volume rm`.
check "...without asking Docker to remove it at all" "$(no_if called "volume rm $(anon 5)")"

# 5. Young is kept; the control is the same volume past the floor.
reset_state
make_volume "$(anon 7)" "$young"
make_volume "$(anon 8)" "$(utc_stamp "$(hours_ago 23)")"
make_volume "$(anon 9)" "$(utc_stamp "$(hours_ago 25)")"
run_sweep >/dev/null
check "a two-hour-old volume is kept" "$(no_if removed "$(anon 7)")"
check "a 23-hour-old volume is kept under the 24 h default" "$(no_if removed "$(anon 8)")"
check "...while a 25-hour-old one goes (positive control)" "$(yes_if removed "$(anon 9)")"
run_sweep --min-age-hours 1 >/dev/null
check "a lower floor removes the two-hour-old one" "$(yes_if removed "$(anon 7)")"
reset_state
make_volume "$(anon 9)" "$(utc_stamp "$(hours_ago 25)")"
DORKOS_DOCKER_ORPHAN_MIN_AGE_HOURS=48 run_sweep >/dev/null
check "a higher floor from the environment keeps the 25-hour-old one" "$(no_if removed "$(anon 9)")"

# 6. A date we cannot read keeps the volume. The control is the same volume
#    with a real date.
reset_state
make_volume "$(anon 10)" "yesterday-ish"
make_volume "$(anon 11)" ""
make_volume "$(anon 12)" "2026-13-40T99:00:00Z"
make_volume "$(anon 13)" "2026-09-01 10:00:00 +0000 UTC"
run_sweep >/dev/null
check "an unparseable CreatedAt is kept" "$(no_if removed "$(anon 10)")"
check "an empty CreatedAt is kept" "$(no_if removed "$(anon 11)")"
check "an out-of-range CreatedAt is kept" "$(no_if removed "$(anon 12)")"
check "a non-RFC 3339 CreatedAt is kept" "$(no_if removed "$(anon 13)")"
printf '%s' "$old" >"$DOCKER_STUB_STATE/volume/$(anon 10)/created"
run_sweep >/dev/null
check "...and removed once its date reads (positive control)" "$(yes_if removed "$(anon 10)")"

# 7. Dates carry their own zone, and the sweep's answer must not depend on the
#    caller's. A parser that ignored the offset would read -05:00 as five hours
#    OLDER than it is (deleting a young volume) and +09:00 as nine hours younger.
reset_state
make_volume "$(anon 14)" "$(offset_stamp "$(hours_ago 20)" - 5)" # 20 h old; 25 h if the offset were ignored
make_volume "$(anon 15)" "$(offset_stamp "$(hours_ago 27)" + 9)" # 27 h old; 18 h if the offset were ignored
make_volume "$(anon 16)" "$(utc_stamp "$(hours_ago 23)" | sed 's/Z$/.123456789Z/')"
TZ=Asia/Tokyo LC_ALL=fr_FR.UTF-8 run_sweep >/dev/null 2>&1
check "a -05:00 CreatedAt 20 h ago is kept, whatever the caller's zone" "$(no_if removed "$(anon 14)")"
check "a +09:00 CreatedAt 27 h ago is removed (positive control)" "$(yes_if removed "$(anon 15)")"
check "fractional seconds parse, and 23 h is still young" "$(no_if removed "$(anon 16)")"
TZ=America/Los_Angeles run_sweep --min-age-hours 22 >/dev/null
check "...and the same stamp goes under a 22 h floor (positive control)" "$(yes_if removed "$(anon 16)")"

# 8. A container that starts between the listing and the removal wins. Twice:
#    once caught by the sweep's own per-volume re-check, once only by Docker's
#    refusal, which must read as keep and not as an error.
reset_state
make_volume "$(anon 17)" "$old"
DOCKER_STUB_RACE_ATTACH="$(anon 17)" run_sweep >/dev/null
rc=$?
check "a volume claimed after the listing is kept" "$(no_if removed "$(anon 17)")"
check "...and the sweep caught it before asking Docker" "$(no_if called "volume rm $(anon 17)")"
check "...and that is not an error" "$([[ $rc -eq 0 ]] && echo true || echo false)"
reset_state
make_volume "$(anon 18)" "$old"
make_volume "$(anon 19)" "$old"
DOCKER_STUB_ATTACH_AT_RM="$(anon 18)" run_sweep >/dev/null 2>"$work/err"
rc=$?
check "a volume claimed at the last instant survives Docker's refusal" "$([[ -d "$DOCKER_STUB_STATE/volume/$(anon 18)" ]] && echo true || echo false)"
check "...and the refusal is not an error" "$([[ $rc -eq 0 && ! -s "$work/err" ]] && echo true || echo false)"
check "...while its neighbour still goes (positive control)" "$(yes_if removed "$(anon 19)")"
# The sweep never forces: `docker volume rm -f` would take a volume in use.
check "volume removal is never forced" "$(no_if grep -Eq '^volume rm (-f|--force)' "$DOCKER_STUB_STATE/calls.log")"

# 9. --dry-run changes nothing: no volume removal, no prune of any kind. The
#    control is the same state swept for real.
reset_state
make_volume "$(anon 20)" "$old" 51.17MB
make_volume "$(anon 21)" "$old" 1.5GB
out="$(run_sweep --dry-run)"
check "dry run removes no volume" "$(no_if called 'volume rm')"
check "dry run prunes no build cache" "$(no_if called 'builder prune')"
check "dry run prunes no image" "$(no_if called 'image prune')"
check "dry run names what it would remove" "$([[ "$out" == *"would remove volume $(anon 20)"* ]] && echo true || echo false)"
check "dry run totals the bytes" "$([[ "$out" == *"would remove 2 anonymous volume(s) (1.55GB)"* ]] && echo true || echo false)"
run_sweep >/dev/null
check "...and the real run removes them (positive control)" "$(yes_if removed "$(anon 20)")"

# 10. The real run prunes build cache by age and only dangling images, and says
#     what each reclaimed.
reset_state
out="$(run_sweep)"
check "build cache is pruned with the 7-day filter" "$(yes_if grep -q -- 'builder prune --force --filter until=168h' "$DOCKER_STUB_STATE/calls.log")"
check "image prune never takes tagged images (no --all)" "$(no_if grep -Eq 'image prune.*(-a|--all)' "$DOCKER_STUB_STATE/calls.log")"
check "the summary reports the image bytes Docker gave" "$([[ "$out" == *"dangling images: reclaimed 300MB"* ]] && echo true || echo false)"
check "the summary reports the buildx Total: line" "$([[ "$out" == *"build cache: reclaimed 1.5GB"* ]] && echo true || echo false)"
check "the summary always prints a volume line" "$([[ "$out" == *"volumes: removed 0 anonymous volume(s) (0B)"* ]] && echo true || echo false)"

# 11. Containers are never removed; old exited ones are named as a hint.
reset_state
make_container long-stopped exited
printf '%s' "$(utc_stamp "$(hours_ago 200)")" >"$DOCKER_STUB_STATE/container/long-stopped/finished"
make_container just-stopped exited
printf '%s' "$(utc_stamp "$(hours_ago 30)")" >"$DOCKER_STUB_STATE/container/just-stopped/finished"
out="$(run_sweep)"
check "an exited container over 7 days old is named" "$([[ "$out" == *"long-stopped"* ]] && echo true || echo false)"
check "a recently exited one is not" "$([[ "$out" != *"just-stopped"* ]] && echo true || echo false)"
check "no container is ever removed" "$(no_if grep -Eq '^(rm|container rm|container prune)' "$DOCKER_STUB_STATE/calls.log")"

# 12. A sleeping Docker is not an alert. The control is the same state awake.
reset_state
touch "$DOCKER_STUB_STATE/daemon-down"
make_volume "$(anon 22)" "$old"
out="$(run_sweep)"
rc=$?
check "Docker down exits 0" "$([[ $rc -eq 0 ]] && echo true || echo false)"
check "Docker down says so" "$([[ "$out" == *"Docker is not running"* ]] && echo true || echo false)"
check "Docker down removes nothing" "$(no_if removed "$(anon 22)")"
rm "$DOCKER_STUB_STATE/daemon-down"
run_sweep >/dev/null
check "...and the volume goes once Docker is up (positive control)" "$(yes_if removed "$(anon 22)")"
# No docker binary at all is the same courtesy. PATH is an EMPTY directory, not
# /usr/bin:/bin: a CI runner or a Linux box has the real docker at
# /usr/bin/docker, and this suite must never reach a real daemon.
mkdir -p "$work/empty"
out="$(PATH="$work/empty" /bin/bash "$sweep")"
rc=$?
check "no docker binary exits 0 with a notice" "$([[ $rc -eq 0 && "$out" == *"not installed"* ]] && echo true || echo false)"

# 12b. Docker that is there but will not answer is NOT the sleeping case. A
#      frozen or unreachable daemon is how the disk filled unnoticed, so it must
#      fail the nightly job rather than read as "nothing to do".
reset_state
make_volume "$(anon 27)" "$old"
touch "$DOCKER_STUB_STATE/daemon-denied"
run_sweep >/dev/null 2>&1
check "a daemon that refuses us exits non-zero" "$([[ $? -eq 1 ]] && echo true || echo false)"
rm "$DOCKER_STUB_STATE/daemon-denied"
touch "$DOCKER_STUB_STATE/daemon-frozen"
started=$SECONDS
DORKOS_DOCKER_ORPHAN_PROBE_SECONDS=1 run_sweep >/dev/null 2>"$work/err"
rc=$?
check "a frozen daemon exits non-zero" "$([[ $rc -eq 1 ]] && echo true || echo false)"
check "...within the probe bound, not after the hang" "$([[ $((SECONDS - started)) -le 3 ]] && echo true || echo false)"
check "...and says it did not answer" "$(yes_if grep -q 'did not answer' "$work/err")"
check "...and removes nothing" "$(no_if removed "$(anon 27)")"

# 13. Real errors are errors: the nightly job must see them.
reset_state
make_volume "$(anon 23)" "$old"
touch "$DOCKER_STUB_STATE/break-volume-ls"
run_sweep >/dev/null 2>&1
check "a failed volume listing exits non-zero" "$([[ $? -ne 0 ]] && echo true || echo false)"
check "...and removes nothing" "$(no_if removed "$(anon 23)")"
reset_state
make_volume "$(anon 24)" "$old"
DOCKER_STUB_BREAK_PS=1 run_sweep >/dev/null 2>&1
check "an unreadable mount list exits non-zero" "$([[ $? -ne 0 ]] && echo true || echo false)"
check "...and removes no volume (we cannot tell dangling from stopped)" "$(no_if removed "$(anon 24)")"
reset_state
make_volume "$(anon 25)" "$old"
DOCKER_STUB_RM_ERROR="Error response from daemon: disk I/O error" run_sweep >/dev/null 2>&1
check "an unexpected removal failure exits non-zero" "$([[ $? -ne 0 ]] && echo true || echo false)"
reset_state
touch "$DOCKER_STUB_STATE/break-builder"
run_sweep >/dev/null 2>&1
check "a failed build cache prune exits non-zero" "$([[ $? -ne 0 ]] && echo true || echo false)"
check "...but the image prune after it still ran" "$(yes_if grep -qx 'image prune' "$DOCKER_STUB_STATE/removed.log")"

# 14. Bad usage is exit 2, and does nothing.
reset_state
make_volume "$(anon 26)" "$old"
run_sweep --min-age-hours soon >/dev/null 2>&1
check "a non-numeric floor is a usage error" "$([[ $? -eq 2 ]] && echo true || echo false)"
run_sweep --delete-everything >/dev/null 2>&1
check "an unknown flag is a usage error" "$([[ $? -eq 2 ]] && echo true || echo false)"
# Bash reads 010 as octal 8 and 08 as an error, and a huge number overflows to
# a negative floor: all three would shrink the floor, the deleting direction.
for floor in 010 08 2562047788015216; do
  run_sweep --min-age-hours "$floor" >/dev/null 2>&1
  check "floor $floor is a usage error" "$([[ $? -eq 2 ]] && echo true || echo false)"
  DORKOS_DOCKER_ORPHAN_MIN_AGE_HOURS="$floor" run_sweep >/dev/null 2>&1
  check "floor $floor from the environment is a usage error" "$([[ $? -eq 2 ]] && echo true || echo false)"
done
check "...and none of them touched anything" "$(no_if removed "$(anon 26)")"
run_sweep --min-age-hours 0 >/dev/null
check "...while a plain 0 is accepted and sweeps (positive control)" "$(yes_if removed "$(anon 26)")"

# 15. Only bash. zsh never sets BASH_REMATCH, so its date parse comes back empty
#     and a young volume would read as ancient; sh would fail somewhere later.
reset_state
make_volume "$(anon 28)" "$young"
for shell in zsh sh; do
  command -v "$shell" >/dev/null 2>&1 || continue
  "$shell" "$sweep" >/dev/null 2>&1
  check "$shell refuses to run it" "$([[ $? -eq 2 ]] && echo true || echo false)"
done
check "...and removed nothing" "$(no_if removed "$(anon 28)")"
check "...not even a Docker call" "$([[ ! -s "$DOCKER_STUB_STATE/calls.log" ]] && echo true || echo false)"

# 16. The machine-wide mount list survives a container vanishing mid-listing (a
#     retry), and when it cannot be read at all, no volume is removed.
reset_state
make_volume "$(anon 29)" "$old"
make_container stopped-db exited "$(anon 29)"
make_volume "$(anon 30)" "$old"
DOCKER_STUB_DANGLING_LIES=1 DOCKER_STUB_VOLUME_FILTER_LIES=1 DOCKER_STUB_INSPECT_FAILS=1 run_sweep >/dev/null 2>&1
rc=$?
check "one failed inspect is retried, not fatal" "$([[ $rc -eq 0 ]] && echo true || echo false)"
check "...and the retry still protects the stopped container's volume" "$(no_if removed "$(anon 29)")"
check "...while the orphan goes (positive control)" "$(yes_if removed "$(anon 30)")"
reset_state
make_volume "$(anon 31)" "$old"
make_container stopped-db exited
DOCKER_STUB_INSPECT_FAILS=99 run_sweep >/dev/null 2>&1
check "a mount list that never reads exits non-zero" "$([[ $? -ne 0 ]] && echo true || echo false)"
check "...and removes no volume" "$(no_if removed "$(anon 31)")"

# 17. The local driver's wording for a volume in use is also a keep.
reset_state
make_volume "$(anon 32)" "$old"
DOCKER_STUB_RM_ERROR="Error response from daemon: remove $(anon 32): volume has active mounts" run_sweep >/dev/null 2>&1
check "'volume has active mounts' is a keep, not an error" "$([[ $? -eq 0 ]] && echo true || echo false)"

echo "sweep-docker-orphans: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
