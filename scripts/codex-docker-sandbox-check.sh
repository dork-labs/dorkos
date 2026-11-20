#!/usr/bin/env bash
# Prove the DorkOS Codex seccomp profile does what docs/self-hosting/docker.mdx
# says, and nothing more (DOR-3800).
#
# Usage: scripts/codex-docker-sandbox-check.sh <image> <seccomp-profile.json>
#
# Runs the image twice, both with --network none and no mounts:
#   1. with --security-opt seccomp=<profile> (the opt-in Codex setup)
#   2. with Docker's default profile (what every other example uses)
# and prints one PASS or FAIL line per check, then a RESULT line. Exits 1 on
# any FAIL. The checks, lettered as in the ticket:
#   (a) Codex's sandbox starts with the profile, in workspace-write and read-only
#   (b) a write to ~/.dork from inside that sandbox is still refused, with two
#       controls so the refusal is the sandbox's doing: the node user can write
#       ~/.dork outside the sandbox, and the sandbox can write its own workspace
#   (c) CapEff (effective capabilities) is identical in both runs
#   (d) both runs are uid 1000, user node
#   (e) with Docker's default profile the sandbox fails closed: a non-zero exit
#       and the command inside never runs
#
# The Codex binary is found for the container's own architecture
# (codex-linux-x64 on amd64, codex-linux-arm64 on arm64), never hard-coded.
# Run it on a host left at its defaults: never switch off Ubuntu's
# apparmor_restrict_unprivileged_userns or kernel.unprivileged_userns_clone to
# make it pass. A host that needs that is a host the profile does not support.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <image> <seccomp-profile.json>" >&2
  exit 2
fi
IMAGE=$1
PROFILE=$2
if [[ ! -f "$PROFILE" ]]; then
  echo "FAIL profile not found: $PROFILE" >&2
  exit 2
fi

# Runs inside the container as the image's own user. Prints KEY=VALUE lines
# only; the host side decides PASS or FAIL. Never exits early on a failed
# probe, so both runs always report every key.
# shellcheck disable=SC2016 # expanded inside the container, not here
PROBE='
set -u
one_line() { tr "\n" " " | cut -c1-240; }
case "$(uname -m)" in
  x86_64) pkg=x64; triple=x86_64-unknown-linux-musl ;;
  aarch64) pkg=arm64; triple=aarch64-unknown-linux-musl ;;
  *) echo "ARCH=$(uname -m)"; echo "CODEX=missing"; exit 0 ;;
esac
echo "ARCH=$(uname -m)"
codex=/usr/local/lib/node_modules/dorkos/node_modules/@openai/codex-linux-$pkg/vendor/$triple/bin/codex
if [ -x "$codex" ]; then echo "CODEX=$codex"; else echo "CODEX=missing"; exit 0; fi
echo "UID=$(id -u)"
echo "USER=$(id -un)"
echo "CAPEFF=$(awk "/^CapEff:/ {print \$2}" /proc/self/status)"
mkdir -p /home/node/work
cd /home/node/work || exit 0

if touch /home/node/.dork/dorkos-check-control && rm -f /home/node/.dork/dorkos-check-control; then
  echo "CONTROL_WRITE=ok"
else
  echo "CONTROL_WRITE=refused"
fi

for mode in workspace-write read-only; do
  out=$("$codex" sandbox -c "sandbox_mode=$mode" -- sh -c "echo SANDBOX_RAN" 2>&1)
  rc=$?
  case "$out" in *SANDBOX_RAN*) ran=yes ;; *) ran=no ;; esac
  echo "START_${mode}_RC=$rc"
  echo "START_${mode}_RAN=$ran"
  echo "START_${mode}_OUT=$(printf "%s" "$out" | one_line)"
done

rm -f /home/node/work/inside
"$codex" sandbox -c sandbox_mode=workspace-write -- sh -c "echo ok > /home/node/work/inside" >/dev/null 2>&1
echo "INSIDE_RC=$?"
if [ -f /home/node/work/inside ]; then echo "INSIDE_EXISTS=yes"; else echo "INSIDE_EXISTS=no"; fi

rm -f /home/node/.dork/dorkos-check-x
out=$("$codex" sandbox -c sandbox_mode=workspace-write -- sh -c "echo x > /home/node/.dork/dorkos-check-x" 2>&1)
echo "DORK_RC=$?"
echo "DORK_OUT=$(printf "%s" "$out" | one_line)"
if [ -e /home/node/.dork/dorkos-check-x ]; then echo "DORK_EXISTS=yes"; else echo "DORK_EXISTS=no"; fi
rm -f /home/node/.dork/dorkos-check-x
'

run_probe() {
  # --network none: nothing here needs the network. No -v: the profile is read
  # by the docker CLI on this host, not mounted into the container.
  docker run --rm --network none "$@" --entrypoint sh "$IMAGE" -c "$PROBE" 2>&1 || true
}

echo "== Docker: $(docker version --format '{{.Server.Version}} ({{.Server.Os}}/{{.Server.Arch}})' 2>/dev/null || echo unknown)"
echo "== Image: $IMAGE"
echo "== Profile: $PROFILE"

WITH=$(run_probe --security-opt "seccomp=$PROFILE")
DEFAULT=$(run_probe)

echo "== Run with the DorkOS profile:"
printf '%s\n' "$WITH" | sed 's/^/   /'
echo "== Run with Docker's default profile:"
printf '%s\n' "$DEFAULT" | sed 's/^/   /'
echo "== Checks:"

get() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -n 1; }

failures=0
checks=0
check() {
  local ok=$1 text=$2
  checks=$((checks + 1))
  if [[ "$ok" == yes ]]; then
    echo "PASS $text"
  else
    echo "FAIL $text"
    failures=$((failures + 1))
  fi
}
is() { [[ "$1" == "$2" ]] && echo yes || echo no; }

for run in WITH DEFAULT; do
  out=${!run}
  codex=$(get "$out" CODEX)
  check "$([[ -n "$codex" && "$codex" != missing ]] && echo yes || echo no)" \
    "[$run] found Codex for $(get "$out" ARCH): ${codex:-no output}"
done

for mode in workspace-write read-only; do
  rc=$(get "$WITH" "START_${mode}_RC")
  ran=$(get "$WITH" "START_${mode}_RAN")
  check "$([[ "$rc" == 0 && "$ran" == yes ]] && echo yes || echo no)" \
    "(a) with the profile, Codex's sandbox starts in $mode (exit ${rc:-none}, command ran: ${ran:-none})"
done

check "$(is "$(get "$WITH" CONTROL_WRITE)" ok)" \
  "(b) control: the node user can write ~/.dork outside the sandbox ($(get "$WITH" CONTROL_WRITE))"
check "$([[ "$(get "$WITH" INSIDE_RC)" == 0 && "$(get "$WITH" INSIDE_EXISTS)" == yes ]] && echo yes || echo no)" \
  "(b) control: the sandbox can write its own workspace (exit $(get "$WITH" INSIDE_RC), file: $(get "$WITH" INSIDE_EXISTS))"
dork_rc=$(get "$WITH" DORK_RC)
# Only a sandbox that started can refuse: a sandbox that never came up also
# leaves no file, and that must not read as a pass.
check "$([[ "$(get "$WITH" START_workspace-write_RAN)" == yes && -n "$dork_rc" && "$dork_rc" != 0 && "$(get "$WITH" DORK_EXISTS)" == no ]] && echo yes || echo no)" \
  "(b) with the profile, a write to ~/.dork from inside the sandbox is refused (exit ${dork_rc:-none}, file: $(get "$WITH" DORK_EXISTS)): $(get "$WITH" DORK_OUT)"

cap_with=$(get "$WITH" CAPEFF)
cap_default=$(get "$DEFAULT" CAPEFF)
check "$([[ -n "$cap_with" && "$cap_with" == "$cap_default" ]] && echo yes || echo no)" \
  "(c) CapEff is identical: profile ${cap_with:-none}, default ${cap_default:-none}"

for run in WITH DEFAULT; do
  out=${!run}
  check "$([[ "$(get "$out" UID)" == 1000 && "$(get "$out" USER)" == node ]] && echo yes || echo no)" \
    "(d) [$run] runs as uid $(get "$out" UID), user $(get "$out" USER)"
done

for mode in workspace-write read-only; do
  rc=$(get "$DEFAULT" "START_${mode}_RC")
  ran=$(get "$DEFAULT" "START_${mode}_RAN")
  check "$([[ -n "$rc" && "$rc" != 0 && "$ran" == no ]] && echo yes || echo no)" \
    "(e) with Docker's default profile, the $mode sandbox fails closed (exit ${rc:-none}, command ran: ${ran:-none}): $(get "$DEFAULT" "START_${mode}_OUT")"
done

if [[ $failures -eq 0 ]]; then
  echo "RESULT: PASS ($checks checks)"
else
  echo "RESULT: FAIL ($failures of $checks checks failed)"
  exit 1
fi
