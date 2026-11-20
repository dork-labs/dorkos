#!/usr/bin/env bash
# Prove the DorkOS Codex seccomp profile does what docs/self-hosting/docker.mdx
# says, and nothing more (DOR-3800).
#
# Usage: scripts/codex-docker-sandbox-check.sh [--expect auto|full|apparmor] <image> <seccomp-profile.json>
#
# Runs the image twice, both with --network none and no mounts:
#   1. with --security-opt seccomp=<profile> (the opt-in Codex setup)
#   2. with Docker's default profile (what every other example uses)
# and prints one PASS or FAIL line per check, then a RESULT line. Exits 1 on
# any FAIL.
#
# --expect names the outcome this host should give (default auto):
#   full      no AppArmor in the container (Docker Desktop on Mac or Windows,
#             a Linux host without AppArmor): the profile lets the sandbox start
#   apparmor  Docker's docker-default AppArmor profile is enforced (Ubuntu,
#             Debian): the profile gets past seccomp, then AppArmor refuses
#             bwrap's first mount. Codex in Docker is not supported there yet
#             (DOR-4836).
#   auto      pick from the container's AppArmor label: none means full,
#             "docker-default (enforce)" means apparmor, anything else FAILs
# Each outcome is pinned to exact bwrap text (NAMESPACE_REFUSAL and
# APPARMOR_REFUSAL below), so a run can never pass by matching neither, and
# any other error FAILs. The label must also agree with an explicit --expect.
#
# The checks, lettered as in the ticket:
#   (a) full: Codex's sandbox starts with the profile, in workspace-write and
#       read-only. apparmor: both fail with APPARMOR_REFUSAL and never with
#       NAMESPACE_REFUSAL
#   (b) full: that sandbox still refuses a write outside the folder it was
#       given (~/.dork, from a workspace at ~/work), with two controls so the
#       refusal is the sandbox's doing: the node user can write ~/.dork
#       outside the sandbox, and the sandbox can write its own workspace. This
#       is Codex's own workspace-write boundary, not DorkOS's dorkos-files-*
#       profile, which the server renders per turn and this probe does not
#       reproduce. apparmor: the failed sandbox wrote nothing, inside its
#       folder or outside it
#   (c) the process's capability sets (CapInh, CapPrm, CapEff, CapBnd, CapAmb),
#       NoNewPrivs and AppArmor label are identical in both runs, and seccomp
#       is in filter mode (Seccomp: 2) in both
#   (d) both runs are uid 1000, user node
#   (e) with Docker's default profile the sandbox fails closed with
#       NAMESPACE_REFUSAL: a non-zero exit and the command never runs
#
# Codex is found the way the server finds it (resolveCodexVendoredBinary in
# apps/server/src/services/runtimes/codex/check-dependencies.ts): resolve
# @openai/codex from the dorkos package, then its per-platform package for
# this architecture. Every Codex call runs under `timeout 60`.
#
# Run it on a host left at its defaults: never loosen the host's user-namespace
# or AppArmor settings to make it pass. A host that needs that is a host the
# profile does not support.
set -euo pipefail

EXPECT=auto
if [[ "${1:-}" == --expect ]]; then
  EXPECT=${2:-}
  shift 2 || true
fi
if [[ $# -ne 2 || ! "$EXPECT" =~ ^(auto|full|apparmor)$ ]]; then
  echo "Usage: $0 [--expect auto|full|apparmor] <image> <seccomp-profile.json>" >&2
  exit 2
fi
IMAGE=$1
PROFILE=$2
if [[ ! -f "$PROFILE" ]]; then
  echo "FAIL profile not found: $PROFILE" >&2
  exit 2
fi

# The exact bwrap text each outcome is pinned to (Codex 0.163's bundled bwrap).
NAMESPACE_REFUSAL="bwrap: No permissions to create a new namespace"
APPARMOR_REFUSAL="bwrap: Failed to make / slave: Permission denied"
APPARMOR_LABEL="docker-default (enforce)"

# Mirrors resolveCodexVendoredBinary: the server's own require anchors on the
# dorkos package, which is where the image installs it.
RESOLVE_JS='
const { createRequire } = require("node:module");
const path = require("node:path");
const triple = { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" }[process.arch];
const pkg = { "x86_64-unknown-linux-musl": "@openai/codex-linux-x64", "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64" }[triple];
if (!pkg) { console.log("missing"); process.exit(0); }
try {
  const fromDorkos = createRequire("/usr/local/lib/node_modules/dorkos/package.json");
  const fromCodex = createRequire(fromDorkos.resolve("@openai/codex/package.json"));
  console.log(path.join(path.dirname(fromCodex.resolve(pkg + "/package.json")), "vendor", triple, "bin", "codex"));
} catch { console.log("missing"); }
'

# Runs inside the container as the image's own user. Prints KEY=VALUE lines
# only; the host side decides PASS or FAIL. Never exits early on a failed
# probe, so both runs always report every key they can.
# shellcheck disable=SC2016 # expanded inside the container, not here
PROBE='
set -u
one_line() { tr "\n" " " | cut -c1-400; }
status() { awk -v k="$1:" "\$1 == k {print \$2}" /proc/self/status; }
echo "ARCH=$(uname -m)"
echo "UID=$(id -u)"
echo "USER=$(id -un)"
for key in CapInh CapPrm CapEff CapBnd CapAmb NoNewPrivs Seccomp; do echo "$key=$(status "$key")"; done
label=$(tr -d "\000" < /proc/self/attr/current 2>/dev/null || true)
echo "APPARMOR=${label:-none}"
if command -v timeout >/dev/null 2>&1; then echo "TIMEOUT=$(command -v timeout)"; else echo "TIMEOUT=missing"; exit 0; fi
codex=$(node -e "$DORKOS_CHECK_RESOLVE" 2>/dev/null || echo missing)
if [ -x "$codex" ]; then echo "CODEX=$codex"; else echo "CODEX=missing"; exit 0; fi
mkdir -p /home/node/work
cd /home/node/work || exit 0

if touch /home/node/.dork/dorkos-check-control && rm -f /home/node/.dork/dorkos-check-control; then
  echo "CONTROL_WRITE=ok"
else
  echo "CONTROL_WRITE=refused"
fi

for mode in workspace-write read-only; do
  out=$(timeout 60 "$codex" sandbox -c "sandbox_mode=$mode" -- sh -c "echo SANDBOX_RAN" 2>&1)
  rc=$?
  case "$out" in *SANDBOX_RAN*) ran=yes ;; *) ran=no ;; esac
  echo "START_${mode}_RC=$rc"
  echo "START_${mode}_RAN=$ran"
  echo "START_${mode}_OUT=$(printf "%s" "$out" | one_line)"
done

rm -f /home/node/work/inside
timeout 60 "$codex" sandbox -c sandbox_mode=workspace-write -- sh -c "echo ok > /home/node/work/inside" >/dev/null 2>&1
echo "INSIDE_RC=$?"
if [ -f /home/node/work/inside ]; then echo "INSIDE_EXISTS=yes"; else echo "INSIDE_EXISTS=no"; fi

rm -f /home/node/.dork/dorkos-check-x
out=$(timeout 60 "$codex" sandbox -c sandbox_mode=workspace-write -- sh -c "echo x > /home/node/.dork/dorkos-check-x" 2>&1)
echo "DORK_RC=$?"
echo "DORK_OUT=$(printf "%s" "$out" | one_line)"
if [ -e /home/node/.dork/dorkos-check-x ]; then echo "DORK_EXISTS=yes"; else echo "DORK_EXISTS=no"; fi
rm -f /home/node/.dork/dorkos-check-x
'

run_probe() {
  # --network none: nothing here needs the network. No -v: the profile is read
  # by the docker CLI on this host, not mounted into the container.
  docker run --rm --network none "$@" -e DORKOS_CHECK_RESOLVE="$RESOLVE_JS" \
    --entrypoint sh "$IMAGE" -c "$PROBE" 2>&1 || true
}

echo "== Docker: $(docker version --format '{{.Server.Version}} ({{.Server.Os}}/{{.Server.Arch}})' 2>/dev/null || echo unknown)"
echo "== Image: $IMAGE"
echo "== Profile: $PROFILE"
echo "== Expect: $EXPECT"

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
has() { [[ "$1" == *"$2"* ]] && echo yes || echo no; }

# The outcome this host gives, from the container's AppArmor label. An
# explicit --expect must agree with it; an unknown label is never a mode.
label=$(get "$DEFAULT" APPARMOR)
case "$label" in
  none) detected=full ;;
  "$APPARMOR_LABEL") detected=apparmor ;;
  *) detected=unknown ;;
esac
mode=$EXPECT
[[ "$mode" == auto ]] && mode=$detected
check "$([[ "$detected" != unknown && "$mode" == "$detected" ]] && echo yes || echo no)" \
  "the host gives the '$mode' outcome (AppArmor label: ${label:-none}, detected: $detected, expected: $EXPECT)"

for run in WITH DEFAULT; do
  out=${!run}
  check "$([[ "$(get "$out" TIMEOUT)" == /* ]] && echo yes || echo no)" \
    "[$run] the image has timeout: $(get "$out" TIMEOUT)"
  codex=$(get "$out" CODEX)
  check "$([[ "$codex" == /* ]] && echo yes || echo no)" \
    "[$run] found Codex the way the server does, for $(get "$out" ARCH): ${codex:-no output}"
done

for sandbox in workspace-write read-only; do
  rc=$(get "$WITH" "START_${sandbox}_RC")
  ran=$(get "$WITH" "START_${sandbox}_RAN")
  why=$(get "$WITH" "START_${sandbox}_OUT")
  if [[ "$mode" == apparmor ]]; then
    check "$([[ -n "$rc" && "$rc" != 0 && "$ran" == no && "$(has "$why" "$APPARMOR_REFUSAL")" == yes && "$(has "$why" "$NAMESPACE_REFUSAL")" == no ]] && echo yes || echo no)" \
      "(a) with the profile, AppArmor refuses the $sandbox sandbox's mount, not seccomp (exit ${rc:-none}, command ran: ${ran:-none}): $why"
  else
    check "$([[ "$rc" == 0 && "$ran" == yes ]] && echo yes || echo no)" \
      "(a) with the profile, Codex's sandbox starts in $sandbox (exit ${rc:-none}, command ran: ${ran:-none})"
  fi
done

check "$(is "$(get "$WITH" CONTROL_WRITE)" ok)" \
  "(b) control: the node user can write ~/.dork outside the sandbox ($(get "$WITH" CONTROL_WRITE))"
inside_rc=$(get "$WITH" INSIDE_RC)
dork_rc=$(get "$WITH" DORK_RC)
if [[ "$mode" == apparmor ]]; then
  check "$([[ -n "$inside_rc" && "$inside_rc" != 0 && "$(get "$WITH" INSIDE_EXISTS)" == no && -n "$dork_rc" && "$dork_rc" != 0 && "$(get "$WITH" DORK_EXISTS)" == no ]] && echo yes || echo no)" \
    "(b) the refused sandbox wrote nothing (workspace: exit ${inside_rc:-none}, file $(get "$WITH" INSIDE_EXISTS); ~/.dork: exit ${dork_rc:-none}, file $(get "$WITH" DORK_EXISTS))"
else
  check "$([[ "$inside_rc" == 0 && "$(get "$WITH" INSIDE_EXISTS)" == yes ]] && echo yes || echo no)" \
    "(b) control: the sandbox can write its own workspace (exit ${inside_rc:-none}, file: $(get "$WITH" INSIDE_EXISTS))"
  # Only a sandbox that started can refuse: a sandbox that never came up also
  # leaves no file, and that must not read as a pass.
  check "$([[ "$(get "$WITH" START_workspace-write_RAN)" == yes && -n "$dork_rc" && "$dork_rc" != 0 && "$(get "$WITH" DORK_EXISTS)" == no ]] && echo yes || echo no)" \
    "(b) with the profile, a write outside the sandbox's folder (~/.dork) is refused (exit ${dork_rc:-none}, file: $(get "$WITH" DORK_EXISTS)): $(get "$WITH" DORK_OUT)"
fi

for key in CapInh CapPrm CapEff CapBnd CapAmb NoNewPrivs APPARMOR; do
  with=$(get "$WITH" "$key")
  default=$(get "$DEFAULT" "$key")
  check "$([[ -n "$with" && "$with" == "$default" ]] && echo yes || echo no)" \
    "(c) $key is identical: profile ${with:-none}, default ${default:-none}"
done
for run in WITH DEFAULT; do
  check "$(is "$(get "${!run}" Seccomp)" 2)" \
    "(c) [$run] seccomp is filtering (Seccomp: $(get "${!run}" Seccomp))"
done

for run in WITH DEFAULT; do
  out=${!run}
  check "$([[ "$(get "$out" UID)" == 1000 && "$(get "$out" USER)" == node ]] && echo yes || echo no)" \
    "(d) [$run] runs as uid $(get "$out" UID), user $(get "$out" USER)"
done

for sandbox in workspace-write read-only; do
  rc=$(get "$DEFAULT" "START_${sandbox}_RC")
  ran=$(get "$DEFAULT" "START_${sandbox}_RAN")
  why=$(get "$DEFAULT" "START_${sandbox}_OUT")
  check "$([[ -n "$rc" && "$rc" != 0 && "$ran" == no && "$(has "$why" "$NAMESPACE_REFUSAL")" == yes ]] && echo yes || echo no)" \
    "(e) with Docker's default profile, the $sandbox sandbox fails closed on the namespace refusal (exit ${rc:-none}, command ran: ${ran:-none}): $why"
done

if [[ $failures -eq 0 ]]; then
  echo "RESULT: PASS ($checks checks, '$mode' outcome)"
else
  echo "RESULT: FAIL ($failures of $checks checks failed)"
  exit 1
fi
