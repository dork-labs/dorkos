#!/usr/bin/env bash
# Boot the built server with no hosted-side credentials and prove it answers
# `GET /api/health`, then stop it.
#
# Run it through the scrub, never on its own:
#
#   bash scripts/run-credential-free.sh bash scripts/credential-free-smoke.sh
#
# WHY A BOOT PROBE AND NOT JUST THE SUITE. The failure DOR-2081 exists to catch
# is a module that reads a hosted-side variable at IMPORT time and throws when
# it is absent. A type check never executes a module, and a build only executes
# the ones the bundler evaluates; the two things that actually import the server
# graph are the unit suite and starting the server. The suite covers the
# modules a test imports. This covers the rest of the boot path — env parsing,
# service registration, route mounting — which is where a "feature off" that was
# really a "build error" would land, and which nothing else in CI executes
# without credentials on purpose.
#
# `/api/health` is deliberately the probe: the repo's own liveness endpoint,
# fast, dependency-free, and outside the session gate, so a green answer means
# the process got all the way up rather than that some middleware short-
# circuited. scripts/smoke-test.sh uses the same endpoint the same way against a
# packaged CLI; this is the un-packaged, credential-free half of that idea.
#
# THE DATA DIRECTORY IS A THROWAWAY. DORK_HOME points at a temp dir so the probe
# never reads or writes the real `~/.dork`; DORKOS_SKIP_INSTANCE_LOCK is on so it
# cannot collide with a server the same machine is already running; and
# DORKOS_SEARCH_NO_EXTERNAL_HISTORY is on so the search index stays inside that
# temp dir instead of copying whatever Claude Code, Codex or OpenCode transcripts
# the machine happens to hold (DOR-1551 — apps/e2e sets it for the same reason,
# and a throwaway DORK_HOME alone does NOT cover it: measured here, a probe
# without it indexed 20,361 messages from a developer's real home directory).
# All three are LOCAL configuration, not hosted-side, so the scrub leaves them
# alone — scripts/test-run-credential-free.sh pins that.
#
# `localhost`, not `127.0.0.1`: DORKOS_HOST defaults to `localhost` and the
# server binds exactly that, which on a dual-stack machine is `::1` — probing
# the v4 literal times out against a perfectly healthy server (measured on
# macOS). scripts/smoke-test.sh probes `localhost` for the same reason. Keep the
# probe spelled the way the bind is spelled.
#
# STOPPING IT: by the PID this script started, and only that PID (AGENTS.md hard
# rule 7 — a kill by name on a shared machine is a kill of everyone's process).
# There is no `timeout` here either: the wait is a poll loop with its own
# deadline, which behaves identically on a runner and on macOS, where `timeout`
# does not exist.
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
server_entry="$repo_root/packages/cli/dist/bin/cli.js"
port="${DORKOS_PORT:-4242}"
deadline_seconds="${CREDENTIAL_FREE_SMOKE_TIMEOUT:-60}"

if [ ! -f "$server_entry" ]; then
  echo "credential-free smoke: $server_entry is missing — build it first (pnpm exec turbo build --filter=dorkos)." >&2
  exit 1
fi

dork_home=$(mktemp -d)
log=$(mktemp)
# SIGTERM first, SIGKILL if it does not go. The escalation is not paranoia:
# apps/server/src/index.ts installs a SIGTERM handler that awaits the OpenCode
# sidecar shutdown, the session pumps, the tunnel manager and the observability
# exporter before exiting. Any one of those hanging would leave a bare
# `wait` blocked until the JOB's timeout — which in the merge queue is the
# hour-long stall this whole check is built to avoid. A ten-second grace is
# generous for a graceful stop and bounded either way.
cleanup() {
  if [ -n "${server_pid:-}" ]; then
    kill "$server_pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$server_pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$dork_home"
  rm -f "$log"
}
trap cleanup EXIT

echo "credential-free smoke: starting the server on port $port with DORK_HOME=$dork_home"
DORK_HOME="$dork_home" \
  DORKOS_SKIP_INSTANCE_LOCK=true \
  DORKOS_SEARCH_NO_EXTERNAL_HISTORY=true \
  NODE_ENV=production \
  node "$server_entry" --port "$port" --no-open >"$log" 2>&1 &
server_pid=$!

elapsed=0
until curl -sf "http://localhost:$port/api/health" >/dev/null 2>&1; do
  # A server that already exited is a hard failure now, not in another 50
  # seconds: without this the log would only ever be read at the deadline, and a
  # module throwing at import — the exact defect this probe exists for — is
  # over in under a second.
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "credential-free smoke: the server exited before answering /api/health. Its output:" >&2
    cat "$log" >&2
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
  if [ "$elapsed" -ge "$deadline_seconds" ]; then
    echo "credential-free smoke: the server did not answer /api/health within ${deadline_seconds}s. Its output:" >&2
    cat "$log" >&2
    exit 1
  fi
done

body=$(curl -sf "http://localhost:$port/api/health")
echo "credential-free smoke: /api/health answered in ${elapsed}s: $body"
# Affirmative, not just "curl exited 0": the endpoint reports its own status,
# and a probe that accepted any 200 would accept a future handler that answers
# while the server is degraded.
printf '%s' "$body" | grep -q '"status"' || {
  echo 'credential-free smoke: /api/health answered without a status field.' >&2
  exit 1
}
echo 'credential-free smoke: the server booted and served its health endpoint with no hosted-side variable set.'
