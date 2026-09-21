#!/usr/bin/env bash
# Fixtures for scripts/sweep-ephemeral-docker.sh.
#
# Hermetic: a stub `docker` on PATH stands in for the daemon, so these run
# anywhere and never touch a real container. The one thing NOT stubbed is `ps`,
# because owner liveness is the whole point of the sweep and a stubbed `ps` would
# only prove the stub agrees with itself.
set -uo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sweep="$script_dir/sweep-ephemeral-docker.sh"
pass=0
fail=0

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A stub daemon whose whole state is a directory tree: state/<kind>/<id>/<label>.
mkdir -p "$work/bin"
cat >"$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
state="$DOCKER_STUB_STATE"
if [[ "$1" == info ]]; then
  [[ -f "$state/daemon-down" ]] && exit 1
  exit 0
fi
kind="$1"; shift
# `docker rm` with no kind word is the container form.
if [[ "$kind" == rm ]]; then kind=container; set -- rm "$@"; fi
verb="$1"; shift
case "$verb" in
  ls)
    # Honour --filter label=<key>. Without this the suite would stay green for a
    # sweep that had lost its filter and was listing every container on the host.
    want=""
    for arg in "$@"; do [[ "$arg" == label=* ]] && want="${arg#label=}"; done
    echo "$kind ${want:-NONE}" >>"$state/listings.log"
    # A daemon that has forgotten how to filter, which is what a lost --filter
    # token looks like from the sweep's side. The marker check is the only thing
    # left standing then, and it has to be pinned on its own.
    [[ -n "${DOCKER_STUB_IGNORE_FILTER:-}" ]] && want=""
    for dir in "$state/$kind"/*; do
      [[ -d "$dir" ]] || continue
      [[ -n "$want" && ! -f "$dir/$want" ]] && continue
      basename "$dir"
    done
    ;;
  inspect)
    # -f '{{index <path> "k1"}}|{{index <path> "k2"}}|{{index <path> "k3"}}' <id>
    #
    # The label PATH differs by object kind, and a wrong one is a template error,
    # not an empty string. Modelling that is the whole reason this stub inspects
    # the format instead of ignoring it: reading labels from the wrong path makes
    # every object look unstamped, which the age fallback turns into a delete.
    fmt="$2"; id="$3"
    [[ -n "${DOCKER_STUB_BREAK_INSPECT:-}" ]] && { echo 'inspect exploded' >&2; exit 1; }
    want='.Labels'
    [[ "$kind" == container ]] && want='.Config.Labels'
    if [[ "$(printf '%s' "$fmt" | grep -o '{{index [^ ]*' | sort -u | sed 's/{{index //')" != "$want" ]]; then
      echo 'template parsing error: map has no entry for key "Labels"' >&2
      exit 1
    fi
    [[ -d "$state/$kind/$id" ]] || exit 1
    out=""
    for key in $(printf '%s' "$fmt" | grep -o '"[^"]*"' | tr -d '"'); do
      out="$out|$(cat "$state/$kind/$id/$key" 2>/dev/null || true)"
    done
    echo "${out#|}"
    ;;
  rm)
    for arg in "$@"; do
      [[ "$arg" == -* ]] && continue
      rm -rf "${state:?}/$kind/$arg"
      echo "$kind $arg" >>"$state/removed.log"
    done
    ;;
esac
exit 0
STUB
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH"

# A `ps` that fails the way a hardened host, a missing binary or a foreign pid
# namespace fails. It lives on a SEPARATE path prepended for one call at a time:
# the liveness check is the point of this script, and a stub in front of every
# test would only prove the stub agrees with itself.
mkdir -p "$work/psbin"
cat >"$work/psbin/ps" <<'PSSTUB'
#!/usr/bin/env bash
echo 'ps: permission denied' >&2
exit ${PS_STUB_EXIT:-2}
PSSTUB
chmod +x "$work/psbin/ps"

# Build one object of `kind` with the given label=value pairs.
make_object() {
  local kind="$1" id="$2" dir
  shift 2
  dir="$DOCKER_STUB_STATE/$kind/$id"
  mkdir -p "$dir"
  echo 1 >"$dir/dorkos.ephemeral"
  local pair
  for pair in "$@"; do
    printf '%s' "${pair#*=}" >"$dir/${pair%%=*}"
  done
}

reset_state() {
  DOCKER_STUB_STATE="$work/state.$RANDOM"
  export DOCKER_STUB_STATE
  mkdir -p "$DOCKER_STUB_STATE"/{container,volume,network}
}

removed() { grep -qx "$1 $2" "$DOCKER_STUB_STATE/removed.log" 2>/dev/null; }

check() {
  local label="$1" ok="$2"
  if [[ "$ok" == true ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $label"
  fi
}

# The start time of a live process, in the sweep's own normalized form. The
# locale and zone are pinned here for the same reason the sweep pins them: an
# unpinned `lstart` renders differently per environment, and a stamp that does
# not read back identically deletes a live run.
live_started() {
  LC_ALL=C TZ=UTC ps -o lstart= -p "$1" | sed 's/[[:space:]][[:space:]]*/-/g; s/^-//; s/-$//'
}

# Linux allows pids up to pid_max, which is 4194304 on most distros and on
# GitHub runners, so 999999 is perfectly reachable there and would make the
# "dead owner" fixtures read a LIVE process. One past the ceiling cannot exist.
impossible_pid=$(( $(cat /proc/sys/kernel/pid_max 2>/dev/null || echo 99999) + 1 ))

now="$(date +%s)"
ancient=$((now - 86400))
recent=$((now - 5))

# 1. A dead owner is an orphan however young the object is.
reset_state
make_object container dead-owner "dorkos.ephemeral.owner=$impossible_pid" \
  "dorkos.ephemeral.owner-started=Mon-Jan-1-00:00:00-2001" "dorkos.ephemeral.created=$now"
"$sweep" >/dev/null
check "dead owner is swept even when seconds old" "$(removed container dead-owner && echo true || echo false)"

# 2. A live owner keeps its objects however OLD they are. This is the case age
#    alone gets wrong: a slow acceptance run must never be shot mid-test.
reset_state
make_object container live-owner "dorkos.ephemeral.owner=$$" \
  "dorkos.ephemeral.owner-started=$(live_started $$)" "dorkos.ephemeral.created=$ancient"
make_object container dead-peer "dorkos.ephemeral.owner=999999999" \
  "dorkos.ephemeral.owner-started=Mon-Jan-1-00:00:00-2001" "dorkos.ephemeral.created=$ancient"
"$sweep" >/dev/null
check "live owner is kept even a day later" "$(removed container live-owner && echo false || echo true)"
check "...while its dead peer in the same sweep goes (positive control)" "$(removed container dead-peer && echo true || echo false)"

# 3. Pids are recycled. A live process wearing a dead run's number must not
#    inherit its containers, which is what the start time is for.
reset_state
make_object container recycled-pid "dorkos.ephemeral.owner=$$" \
  "dorkos.ephemeral.owner-started=Mon-Jan-1-00:00:00-2001" "dorkos.ephemeral.created=$now"
"$sweep" >/dev/null
check "a recycled pid does not shield a dead run's objects" "$(removed container recycled-pid && echo true || echo false)"

# 4-6. Unknown owner falls back to age: ancient goes, recent stays, unstamped
#      (only our own older code can make one) counts as ancient.
reset_state
make_object container old-unowned "dorkos.ephemeral.created=$ancient"
make_object container young-unowned "dorkos.ephemeral.created=$recent"  # the keep side's control is old-unowned, above
make_object container unstamped
"$sweep" >/dev/null
check "unowned and old is swept" "$(removed container old-unowned && echo true || echo false)"
check "unowned and recent is kept" "$(removed container young-unowned && echo false || echo true)"
check "unowned and unstamped is swept" "$(removed container unstamped && echo true || echo false)"

# 7. All three kinds are swept, not just containers: a leaked volume is the
#    expensive one, and a leaked network exhausts the address pool.
reset_state
make_object container c1 "dorkos.ephemeral.created=$ancient"
make_object volume v1 "dorkos.ephemeral.created=$ancient"
make_object network n1 "dorkos.ephemeral.created=$ancient"
summary="$("$sweep")"
check "containers are swept" "$(removed container c1 && echo true || echo false)"
check "volumes are swept" "$(removed volume v1 && echo true || echo false)"
check "networks are swept" "$(removed network n1 && echo true || echo false)"
check "the summary counts each kind" "$([[ "$summary" == "Swept 1 container(s), 1 volume(s), 1 network(s) from dead runs." ]] && echo true || echo false)"

# 8. A quiet sweep says nothing. A line every acceptance run would train the eye
#    to skip the line that matters.
reset_state
make_object container keeper "dorkos.ephemeral.owner=$$" "dorkos.ephemeral.owner-started=$(live_started $$)"
check "a sweep that frees nothing is silent" "$([[ -z "$("$sweep")" ]] && echo true || echo false)"
make_object container loud "dorkos.ephemeral.created=$ancient"
check "...and one that frees something speaks (positive control)" "$([[ -n "$("$sweep")" ]] && echo true || echo false)"

# 9. The age floor is configurable, because a slow suite on a loaded machine is
#    the thing this must not outrun.
reset_state
make_object container two-hours-old "dorkos.ephemeral.created=$((now - 7000))"
DORKOS_EPHEMERAL_MAX_AGE_SECONDS=600 "$sweep" >/dev/null
check "a lower age floor sweeps more" "$(removed container two-hours-old && echo true || echo false)"
reset_state
make_object container two-hours-old "dorkos.ephemeral.created=$((now - 7000))"
DORKOS_EPHEMERAL_MAX_AGE_SECONDS=99999 "$sweep" >/dev/null
check "a higher age floor sweeps less" "$(removed container two-hours-old && echo false || echo true)"

# 10. No daemon is not a failure. The caller needs Docker and will say so far
#     better than a sweep can; failing here would break the run before it starts.
reset_state
touch "$DOCKER_STUB_STATE/daemon-down"
make_object container orphan "dorkos.ephemeral.created=$ancient"
"$sweep" >/dev/null 2>&1
check "a missing daemon exits clean" "$([[ $? -eq 0 ]] && echo true || echo false)"
check "a missing daemon removes nothing" "$(removed container orphan && echo false || echo true)"

# 11. When Docker will not tell us about an object, we keep it. A template that
#     stops working must leak disk, never delete a live run's database.
reset_state
make_object container unreadable "dorkos.ephemeral.created=$ancient"
DOCKER_STUB_BREAK_INSPECT=1 "$sweep" >/dev/null
check "an unreadable object is kept, not deleted" "$(removed container unreadable && echo false || echo true)"
# ...and the same object with inspect working is swept, so the check above is
# not passing merely because the sweep never looked at anything.
"$sweep" >/dev/null
check "...and is swept once inspect works again (positive control)" "$(removed container unreadable && echo true || echo false)"

# 12. An object with no marker is not ours. The listing filter is one token; if
#     it is ever dropped, the sweep sees every container on the machine, and an
#     unstamped one would otherwise read as "ancient, therefore delete".
reset_state
mkdir -p "$DOCKER_STUB_STATE/container/someone-elses-database"
printf '%s' "$ancient" >"$DOCKER_STUB_STATE/container/someone-elses-database/dorkos.ephemeral.created"
make_object container ours-and-ancient "dorkos.ephemeral.created=$ancient"
"$sweep" >/dev/null
check "an unmarked object is never touched" "$(removed container someone-elses-database && echo false || echo true)"
check "...while our own ancient one still goes (positive control)" "$(removed container ours-and-ancient && echo true || echo false)"

# 13. When `ps` cannot answer, the owner is unknowable, and unknowable must mean
#     keep. Exit 2 here stands for a missing binary, a hardened hidepid, or a pid
#     that belongs to another namespace.
reset_state
make_object container unknowable-owner "dorkos.ephemeral.owner=$$" \
  "dorkos.ephemeral.owner-started=$(live_started $$)" "dorkos.ephemeral.created=$ancient"
make_object container unowned-ancient "dorkos.ephemeral.created=$ancient"
PATH="$work/psbin:$PATH" "$sweep" >/dev/null
check "an owner ps cannot report on is kept" "$(removed container unknowable-owner && echo false || echo true)"
check "...while the sweep still ran (positive control)" "$(removed container unowned-ancient && echo true || echo false)"

# 14. Exit 1 from `ps` is the real "no such process", and that IS an orphan.
reset_state
make_object container really-gone "dorkos.ephemeral.owner=$$" \
  "dorkos.ephemeral.owner-started=$(live_started $$)" "dorkos.ephemeral.created=$now"
PS_STUB_EXIT=1 PATH="$work/psbin:$PATH" "$sweep" >/dev/null
check "ps reporting no such process is an orphan" "$(removed container really-gone && echo true || echo false)"

# 15. Two independent layers keep this sweep away from things that are not ours:
#     the listing filter, and the marker re-read on the object itself. Dropping
#     either one alone is survivable, which is the point, so each is pinned by
#     itself: here the daemon ignores the filter entirely and the marker must
#     still save the stranger.
reset_state
mkdir -p "$DOCKER_STUB_STATE/container/unrelated-service"
printf '%s' "$ancient" >"$DOCKER_STUB_STATE/container/unrelated-service/dorkos.ephemeral.created"
make_object container ours-too "dorkos.ephemeral.created=$ancient"
DOCKER_STUB_IGNORE_FILTER=1 "$sweep" >/dev/null
check "an unfiltered listing still spares a stranger" "$(removed container unrelated-service && echo false || echo true)"
check "...while ours is still reclaimed (positive control)" "$(removed container ours-too && echo true || echo false)"

# And the other layer: every listing this sweep asks for is filtered by our
# label, so the daemon is never asked to enumerate the whole machine.
reset_state
"$sweep" >/dev/null
check "every listing is filtered by our label" "$([[ "$(sort -u "$DOCKER_STUB_STATE/listings.log" | tr '\n' ' ')" == "container dorkos.ephemeral network dorkos.ephemeral volume dorkos.ephemeral " ]] && echo true || echo false)"

# 16. A sweep running in a different locale and zone than the stamp must still
#     recognise the owner. `ps -o lstart=` renders in the caller's LC_TIME and
#     TZ, and agents on this machine are launched from different environments,
#     so an unpinned rendering makes a live run look like a stranger.
reset_state
make_object container other-timezone "dorkos.ephemeral.owner=$$" \
  "dorkos.ephemeral.owner-started=$(live_started $$)" "dorkos.ephemeral.created=$ancient"
make_object container other-timezone-control "dorkos.ephemeral.created=$ancient"
TZ=Asia/Tokyo LC_ALL=fr_FR.UTF-8 "$sweep" >/dev/null
check "a live owner survives a sweep from another timezone and locale" "$(removed container other-timezone && echo false || echo true)"
check "...while that sweep still reclaimed (positive control)" "$(removed container other-timezone-control && echo true || echo false)"

# 17. The labels a creator stamps are exactly what the sweep reads back, and they
#     are space-free so they survive the word-splitting the caller relies on.
labels="$("$sweep" --print-labels "$$")"
check "print-labels emits four labels" "$([[ "$(printf '%s\n' $labels | grep -c '^--label$')" == 4 ]] && echo true || echo false)"
check "print-labels marks the object ephemeral" "$([[ "$labels" == *"--label dorkos.ephemeral=1"* ]] && echo true || echo false)"
check "print-labels stamps a created timestamp" "$([[ "$labels" =~ dorkos\.ephemeral\.created=[0-9]+ ]] && echo true || echo false)"

# The round trip that everything else rests on: an object stamped by a LIVE
# process is read back as alive. A format change in `ps` breaks this test rather
# than silently sweeping every live run's containers.
reset_state
owner_pid="$(printf '%s\n' $labels | sed -n 's/^dorkos\.ephemeral\.owner=//p')"
started="$(printf '%s\n' $labels | sed -n 's/^dorkos\.ephemeral\.owner-started=//p')"
check "the stamped owner is the CALLER, not the sweep's own short-lived shell" "$([[ "$owner_pid" == "$$" ]] && echo true || echo false)"
make_object container round-trip "dorkos.ephemeral.owner=$owner_pid" "dorkos.ephemeral.owner-started=$started"
"$sweep" >/dev/null
check "a live process's own stamp reads back as alive" "$(removed container round-trip && echo false || echo true)"

# A creator that forgets to pass its pid must fail loudly rather than stamp
# something the next sweep reads as already dead.
"$sweep" --print-labels >/dev/null 2>&1
check "print-labels without a pid is an error" "$([[ $? -ne 0 ]] && echo true || echo false)"
"$sweep" --print-labels "$impossible_pid" >/dev/null 2>&1
check "print-labels for a dead pid is an error" "$([[ $? -ne 0 ]] && echo true || echo false)"

echo "sweep-ephemeral-docker: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
