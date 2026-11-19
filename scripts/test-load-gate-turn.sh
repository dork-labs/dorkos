#!/usr/bin/env bash
# Fixture suite for the app's line in scripts/heavy-run-lock.sh (DOR-4209 PR5a):
# a --job waits its turn in the same first-come line as agents' heavy shell
# jobs, through scripts/load-gate/turn.ts and the server's own TicketQueue.
#
#   bash scripts/test-load-gate-turn.sh
#
# What it proves, each case able to go red:
#
#   * ONE LINE. A repo job waits behind a job the app's queue holds (a ticket
#     written by TicketQueue itself, standing in for the server), and an app job
#     waits behind a repo job, first come first served.
#   * IT NAMES THE PROGRAM ONLY. The waiting ticket says `sleep`, not its
#     arguments or an environment assignment in front of it.
#   * IT NEVER WEDGES. A repo run nested inside a job the app already let run
#     (an agent's gated `pnpm build`) goes straight through instead of waiting
#     on its own parent's slot.
#   * IT NEVER FAILS CLOSED. A folder that is a symlink or a file, no tsx, and a
#     helper that dies before starting the command all still run it.
#   * IT GIVES THE SLOT BACK when the command ends: success, failure (exit code
#     kept) and a signal.
#   * IT READS THE APP'S SETTINGS. `enabled: false` and `slots: 2` in the
#     config's `runtimes.loadGate` change what a repo job does; the commit gate
#     and DORKOS_LOAD_GATE_LINE=0 never join the line.
#
# Needs `pnpm install` (tsx, zod): the line is the server's own code. Every case
# gets its own queue folder, lock folder and DORK_HOME, so the real line on this
# machine is never touched, and the load is fixed at 0 so this host's load never
# decides a case.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOCK="$repo_root/scripts/heavy-run-lock.sh"
TSX_BIN="$repo_root/node_modules/.bin/tsx"

unset CI DORKOS_HEAVY_SLOT_HELD DORKOS_HEAVY_LOCK DORKOS_HEAVY_WAIT_SECONDS DORKOS_HEAVY_SLOTS \
  DORKOS_IGNORE_LOAD DORKOS_LOAD_GATE_LINE DORKOS_LOAD_GATE_TSX DORKOS_LOAD_GATE_SLOTS \
  DORKOS_LOAD_GATE_MAX_LOAD DORKOS_LOAD_GATE_HARD_CAP_MINUTES CI_STEWARD_TIMINGS_FILE CI_STEWARD_RUN_ID
export DORKOS_HEAVY_LOADAVG_CMD='echo 0.00'
export DORKOS_LOAD_GATE_LOAD=0
export DORKOS_LOAD_GATE_POLL_MS=200

if [ ! -x "$TSX_BIN" ]; then
  echo "FAIL this suite needs tsx at $TSX_BIN — run pnpm install first"
  exit 1
fi

work=$(mktemp -d)
# Only ever the pids this suite itself forked, by the pid (Hard Rule 7).
own_pids=()
cleanup() {
  for p in ${own_pids[@]+"${own_pids[@]}"}; do kill -KILL "$p" 2>/dev/null; done
  rm -rf "$work"
}
trap cleanup EXIT

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  printf 'ok   %s\n' "$1"
}
not_ok() {
  fail=$((fail + 1))
  printf 'FAIL %s\n' "$1"
}
check_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1 — wanted $2, got $3"; fi
}
check_contains() {
  if grep <<<"$3" -qF -- "$2"; then ok "$1"; else not_ok "$1 — '$2' not in: $3"; fi
}
check_lacks() {
  if grep <<<"$3" -qF -- "$2"; then not_ok "$1 — '$2' found in: $3"; else ok "$1"; fi
}

# A fresh world for one case: its own queue folder, lock folder and DORK_HOME.
fresh() {
  case_dir=$(mktemp -d "$work/case.XXXXXX")
  export DORKOS_LOAD_GATE_DIR="$case_dir/line"
  export DORKOS_HEAVY_LOCK_DIR="$case_dir/locks"
  export DORK_HOME="$case_dir/home"
  mkdir -p "$DORK_HOME"
  order="$case_dir/order"
  : >"$order"
}

# True once the queue folder holds a running job.
await_slot() {
  for _ in $(seq 1 300); do
    ls "$DORKOS_LOAD_GATE_DIR"/slot-*.json >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  return 1
}
await_ticket() {
  for _ in $(seq 1 300); do
    ls "$DORKOS_LOAD_GATE_DIR"/ticket-*.json >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  return 1
}
await_file() {
  for _ in $(seq 1 300); do
    [ -s "$1" ] && return 0
    sleep 0.1
  done
  return 1
}
# Running jobs and waiting tickets left in the folder: none once everything ended.
leftovers() { find "$DORKOS_LOAD_GATE_DIR" -maxdepth 1 \( -name 'slot-*' -o -name 'ticket-*' -o -name 'through-*' \) 2>/dev/null | wc -l | tr -d ' '; }

# The app's side: a job queued through TicketQueue itself, as the server's gate
# queues an agent's command. It waits its turn, notes when it starts and ends in
# $order, and either sleeps or runs a command as its own child while it holds
# the slot. Written outside the repo, importing the queue by path.
cat >"$work/app-job.mts" <<'TS'
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const [repo, order, ready, mode, ...rest] = process.argv.slice(2) as [string, string, string, string, ...string[]];
const queueModule = `${repo}/apps/server/src/services/core/load-gate/ticket-queue.ts`;
const { TicketQueue } = await import(pathToFileURL(queueModule).href);
const queue = new TicketQueue({ dir: process.env.DORKOS_LOAD_GATE_DIR });
const ticket = queue.enqueue({ job: 'pnpm' });
fs.writeFileSync(ready, 'queued');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
for (;;) {
  queue.beat(ticket);
  if (queue.tryAcquire(ticket, { slots: 1, load: 0, maxLoad: 16 }) === 'slot') break;
  await sleep(100);
}
fs.appendFileSync(order, 'app-start\n');
if (mode === 'run') {
  const child = spawn(rest[0]!, rest.slice(1), { stdio: 'inherit' });
  await new Promise((resolve) => child.on('exit', resolve));
} else {
  await sleep(Number(rest[0]) * 1000);
}
fs.appendFileSync(order, 'app-end\n');
queue.release(ticket);
TS

start_app_job() {
  app_ready="$case_dir/app-ready"
  "$TSX_BIN" "$work/app-job.mts" "$repo_root" "$order" "$app_ready" "$@" >"$case_dir/app-out" 2>&1 &
  app_pid=$!
  own_pids+=("$app_pid")
}

echo "== one line: a repo job waits behind the app's job =="

fresh
export DORKOS_LOAD_GATE_SLOTS=1
start_app_job sleep 3
await_slot || not_ok "the app's job never took its slot, so the next case proves nothing"
out=$(bash "$LOCK" --job bash -c "echo repo-start >>'$order'; echo repo-ran" 2>&1)
check_eq 'the repo job still exits 0' 0 "$?"
check_contains 'its output is forwarded' 'repo-ran' "$out"
check_contains 'it says it is waiting in the line' "waiting in this computer's line for heavy jobs" "$out"
wait "$app_pid" 2>/dev/null
check_eq 'the repo job started only after the app job ended' 'app-start app-end repo-start' "$(tr '\n' ' ' <"$order" | sed 's/ $//')"
check_eq 'nothing is left in the line' 0 "$(leftovers)"

echo ""
echo "== one line: the app's job waits behind a repo job =="

fresh
bash "$LOCK" --job bash -c "echo repo-start >>'$order'; sleep 3; echo repo-end >>'$order'" >/dev/null 2>&1 &
repo_pid=$!
own_pids+=("$repo_pid")
await_slot || not_ok "the repo job never took a slot in the line"
start_app_job sleep 0
wait "$app_pid" 2>/dev/null
wait "$repo_pid" 2>/dev/null
check_eq 'the app job started only after the repo job ended' 'repo-start repo-end app-start app-end' "$(tr '\n' ' ' <"$order" | sed 's/ $//')"
check_eq 'nothing is left in the line' 0 "$(leftovers)"

echo ""
echo "== a ticket names its program only =="

fresh
start_app_job sleep 3
await_slot || not_ok "the app's job never took its slot"
bash "$LOCK" --job env SECRET_PATH=/private/branch sleep 0 >/dev/null 2>&1 &
repo_pid=$!
own_pids+=("$repo_pid")
await_ticket || not_ok 'the repo job never queued a ticket'
ticket_text=$(cat "$DORKOS_LOAD_GATE_DIR"/ticket-*.json 2>/dev/null)
check_contains 'the waiting ticket is labelled by its program' '"job":"sleep"' "$ticket_text"
check_lacks 'and never by what was typed around it' 'SECRET_PATH' "$ticket_text"
wait "$app_pid" "$repo_pid" 2>/dev/null

echo ""
echo "== a repo run nested in a job the app let run goes straight through =="

fresh
# One minute, so a nested run that wrongly queues ends inside this suite too.
export DORKOS_LOAD_GATE_HARD_CAP_MINUTES=1
started=$(date +%s)
start_app_job run bash "$LOCK" --job bash -c 'echo nested-ran'
wait "$app_pid" 2>/dev/null
elapsed=$(($(date +%s) - started))
out=$(cat "$case_dir/app-out")
check_contains 'the nested run ran' 'nested-ran' "$out"
check_lacks 'without waiting on its own parent' 'waiting in' "$out"
if [ "$elapsed" -lt 30 ]; then ok "the nested run finished in ${elapsed}s"; else not_ok "the nested run waited ${elapsed}s for its own parent's slot"; fi
unset DORKOS_LOAD_GATE_HARD_CAP_MINUTES

echo ""
echo "== it never fails closed =="

fresh
mkdir -p "$case_dir/real"
ln -s "$case_dir/real" "$DORKOS_LOAD_GATE_DIR"
out=$(bash "$LOCK" --job bash -c 'echo ran-past-a-symlink; exit 5' 2>&1)
check_eq 'a symlinked queue folder still runs the job, exit code kept' 5 "$?"
check_contains 'its output is forwarded' 'ran-past-a-symlink' "$out"
check_contains 'and it says the line could not be used' 'could not be used' "$out"

fresh
mkdir -p "$(dirname "$DORKOS_LOAD_GATE_DIR")"
: >"$DORKOS_LOAD_GATE_DIR"
out=$(bash "$LOCK" --job bash -c 'echo ran-past-a-file' 2>&1)
check_eq 'a queue folder that is a file still runs the job' 0 "$?"
check_contains 'its output is forwarded' 'ran-past-a-file' "$out"

fresh
out=$(DORKOS_LOAD_GATE_TSX="$work/no-such-tsx" bash "$LOCK" --job bash -c 'echo ran-without-tsx' 2>&1)
check_eq 'no tsx still runs the job' 0 "$?"
check_contains 'its output is forwarded' 'ran-without-tsx' "$out"
check_contains 'and it says so' 'no tsx' "$out"

fresh
printf '#!/usr/bin/env bash\nexit 9\n' >"$work/dying-tsx"
chmod +x "$work/dying-tsx"
out=$(DORKOS_LOAD_GATE_TSX="$work/dying-tsx" bash "$LOCK" --job bash -c 'echo ran-after-the-helper-died' 2>&1)
check_eq 'a helper that dies before starting the command still runs it' 0 "$?"
check_contains 'once' 'ran-after-the-helper-died' "$out"
check_contains 'and it says the line did not start' 'did not start (exit 9)' "$out"

echo ""
echo "== the slot comes back however the command ends =="

fresh
out=$(bash "$LOCK" --job bash -c 'echo passed' 2>&1)
check_eq 'a passing job exits 0' 0 "$?"
check_eq 'and leaves nothing in the line' 0 "$(leftovers)"
out=$(bash "$LOCK" --job bash -c 'exit 7' 2>&1)
check_eq 'a failing job keeps its exit code' 7 "$?"
check_eq 'and leaves nothing in the line' 0 "$(leftovers)"
pidf="$case_dir/job-pid"
bash "$LOCK" --job bash -c "echo \$\$ >'$pidf'; exec sleep 30" >/dev/null 2>&1 &
repo_pid=$!
own_pids+=("$repo_pid")
await_slot || not_ok 'the job never took a slot in the line'
await_file "$pidf" || not_ok 'the job never started'
# The job's own process, by the pid it wrote: nothing else on this machine.
kill -TERM "$(cat "$pidf")" 2>/dev/null
wait "$repo_pid" 2>/dev/null
check_eq 'a job ended by a signal exits 128 + 15' 143 "$?"
check_eq 'and leaves nothing in the line' 0 "$(leftovers)"

echo ""
echo "== it reads the app's settings, and only a --job joins =="

fresh
unset DORKOS_LOAD_GATE_SLOTS
printf '{"runtimes":{"loadGate":{"slots":2}}}\n' >"$DORK_HOME/config.json"
start_app_job sleep 3
await_slot || not_ok "the app's job never took its slot"
out=$(bash "$LOCK" --job bash -c 'echo second-slot' 2>&1)
check_lacks 'slots: 2 in the config lets a second job run beside the app job' 'waiting in' "$out"
check_contains 'and it ran' 'second-slot' "$out"
wait "$app_pid" 2>/dev/null

fresh
printf '{"runtimes":{"loadGate":{"enabled":false}}}\n' >"$DORK_HOME/config.json"
start_app_job sleep 3
await_slot || not_ok "the app's job never took its slot"
out=$(bash "$LOCK" --job bash -c 'echo gate-off' 2>&1)
check_lacks 'enabled: false in the config means a job does not wait' 'waiting in' "$out"
check_eq 'nothing of the job is in the line' 0 "$(find "$DORKOS_LOAD_GATE_DIR" -maxdepth 1 -name 'ticket-*' | wc -l | tr -d ' ')"
wait "$app_pid" 2>/dev/null

fresh
export DORKOS_LOAD_GATE_SLOTS=1
start_app_job sleep 3
await_slot || not_ok "the app's job never took its slot"
out=$(bash "$LOCK" bash -c 'echo commit-gate' 2>&1)
check_lacks 'the commit gate (no --job) never joins the line' 'waiting in' "$out"
out=$(DORKOS_LOAD_GATE_LINE=0 bash "$LOCK" --job bash -c 'echo line-off' 2>&1)
check_lacks 'DORKOS_LOAD_GATE_LINE=0 keeps a job out of the line' 'waiting in' "$out"
check_contains 'and it ran' 'line-off' "$out"
wait "$app_pid" 2>/dev/null

echo ""
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
