#!/usr/bin/env bash
# Fixture suite for the heavy-job PATH shims, scripts/heavy-shims/ (pnpm, npx,
# tsc, vitest, turbo) and their shared body, scripts/lib/heavy-shim.sh.
#
#   bash scripts/test-heavy-shims.sh
#
# Nothing real runs: the "real" programs are stubs in a temp folder that log
# their argv, stdin and PATH and exit with $STUB_EXIT, and the gate is a stub
# (DORKOS_HEAVY_SHIM_LOCK) that logs how it was called and then runs the command
# the way heavy-run-lock.sh does, with DORKOS_HEAVY_SLOT_HELD=1. One case runs
# the real heavy-run-lock.sh with DORKOS_HEAVY_LOCK=0 (no slot, no line, no load).
#
# The cases, by what would go wrong without them:
#   * HEAVY GOES THROUGH THE GATE: tsc, a whole vitest run, turbo build, a
#     package's own script, `pnpm exec`/`npx` of a heavy program.
#   * LIGHT IS UNTOUCHED: identical argv (spaces, empty words, glob characters),
#     stdin, and exit code, with no gate call.
#   * NO LOOP: the gate is handed the real program's path and a PATH without the
#     shims; a run that already holds a slot, `pnpm heavy`, and CI pass straight
#     through; a "real" program that is a shim is refused; a fourth nested shim
#     is refused; a real recursive chain stops.
#   * NO SILENT FAILURE: a missing real program fails 127 and says so; a missing
#     gate runs the program and says so.

set -uo pipefail

here=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd)
shims="$here/heavy-shims"
lock_real="$here/heavy-run-lock.sh"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/heavy-shims-test.XXXXXX")
tmp=$(CDPATH='' cd -P -- "$tmp" && pwd)
trap 'rm -rf -- "$tmp"' EXIT

log="$tmp/log"
bin="$tmp/bin"
mkdir -p "$bin"

# A stub "real" program: one line per call, `REAL <name> [<arg>]... | stdin=<..>
# | shims-on-path=<yes|no> | depth=<n>`, each argv word bracketed so spaces and
# empty words show. STUB_READ=1 reads stdin. STUB_RECURSE=<n> makes pnpm call
# `pnpm install` again through PATH, to prove a real chain stops.
for name in pnpm npx tsc vitest turbo; do
  cat >"$bin/$name" <<'STUB'
#!/usr/bin/env bash
name=${0##*/}
line="REAL $name"
for a in "$@"; do line="$line [$a]"; done
input=''
[ "${STUB_READ:-}" = 1 ] && input=$(cat)
case ":$PATH:" in *"/heavy-shims:"*) on=yes ;; *) on=no ;; esac
printf '%s | stdin=%s | shims-on-path=%s | depth=%s\n' "$line" "$input" "$on" "${DORKOS_HEAVY_SHIM_DEPTH:-}" >>"$STUB_LOG"
if [ "$name" = pnpm ] && [ -n "${STUB_RECURSE:-}" ]; then
  pnpm install
  exit $?
fi
exit "${STUB_EXIT:-0}"
STUB
  chmod +x "$bin/$name"
done

base_path="$shims:$bin:/usr/bin:/bin"

# Run one command with the shims first on PATH and a clean environment.
# Prints the log, then `exit=<n>`, then stderr's first line (if any).
run() {
  : >"$log"
  local err status
  # RUN_ENV is one NAME=value word or nothing, so it is left unquoted.
  # shellcheck disable=SC2086
  err=$(
    cd "${RUN_CWD:-$tmp}" &&
      env -u CI -u DORKOS_HEAVY_SLOT_HELD -u DORKOS_LOAD_GATE_IN_TURN -u DORKOS_HEAVY_SHIM_DEPTH \
        PATH="${RUN_PATH:-$base_path}" STUB_LOG="$log" DORKOS_HEAVY_SHIM_LOCK="${RUN_LOCK:-$gate}" \
        ${RUN_ENV:-} "$@" 2>&1 >/dev/null </dev/null
  )
  status=$?
  cat "$log"
  echo "exit=$status"
  [ -n "$err" ] && printf 'stderr=%s\n' "$(printf '%s\n' "$err" | head -n 1)"
  return 0
}

pass=0
fail=0
check() {
  local name=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n--- expected\n%s\n--- actual\n%s\n' "$name" "$expected" "$actual" >&2
  fi
}
# A case whose output only has to contain a line.
check_has() {
  local name=$1 needle=$2 actual=$3
  case "$actual" in
    *"$needle"*) pass=$((pass + 1)) ;;
    *)
      fail=$((fail + 1))
      printf 'FAIL  %s\n--- expected to contain\n%s\n--- actual\n%s\n' "$name" "$needle" "$actual" >&2
      ;;
  esac
}

gated() { # <mode> <name> <args as the log shows them>
  printf 'GATE --%s %s/%s%s | shims-on-path=no\nREAL %s%s | stdin= | shims-on-path=no | depth=1\nexit=0' \
    "$1" "$bin" "$2" "$3" "$2" "$3"
}
light() { # <name> <args as the log shows them>
  printf 'REAL %s%s | stdin= | shims-on-path=yes | depth=1\nexit=0' "$1" "$2"
}
straight() { # <name> <args>: run under the gate already, so no shims below it
  printf 'REAL %s%s | stdin= | shims-on-path=no | depth=1\nexit=0' "$1" "$2"
}

# The stub gate: logs `GATE <mode> <program> [<arg>]...` and whether the shims
# are on its PATH, then runs the program as heavy-run-lock.sh does.
gate="$tmp/gate.sh"
cat >"$gate" <<'STUB'
mode=$1
program=$2
shift 2
line="GATE $mode $program"
for a in "$@"; do line="$line [$a]"; done
case ":$PATH:" in *"/heavy-shims:"*) on=yes ;; *) on=no ;; esac
printf '%s | shims-on-path=%s\n' "$line" "$on" >>"$STUB_LOG"
export DORKOS_HEAVY_SLOT_HELD=1
exec "$program" "$@"
STUB

# A workspace that is not DorkOS, one that is, and test files to name.
ws="$tmp/ws"
mkdir -p "$ws/packages/a/src"
echo 'packages: [packages/*]' >"$ws/pnpm-workspace.yaml"
echo '{ "name": "other-monorepo" }' >"$ws/package.json"
echo '{ "name": "a" }' >"$ws/packages/a/package.json"
dk="$tmp/dorkos"
mkdir -p "$dk/apps/server"
echo 'packages: [apps/*]' >"$dk/pnpm-workspace.yaml"
printf '{\n  "name": "@dorkos/monorepo"\n}\n' >"$dk/package.json"
echo '{ "name": "@dorkos/server" }' >"$dk/apps/server/package.json"
for f in a b c d; do : >"$ws/packages/a/src/$f.test.ts"; done

# --- HEAVY GOES THROUGH THE GATE --------------------------------------------
check 'tsc compiles: gated --job' "$(gated job tsc ' [--noEmit]')" "$(run tsc --noEmit)"
check 'tsc -b: gated' "$(gated job tsc ' [-b] [tsconfig.json]')" "$(run tsc -b tsconfig.json)"
check 'vitest with no file: gated --tests' "$(gated tests vitest ' [run]')" "$(run vitest run)"
check 'vitest bare (watch): gated --tests' "$(gated tests vitest '')" "$(run vitest)"
check 'vitest given a directory: gated' "$(gated tests vitest ' [run] [packages/a/src]')" \
  "$(RUN_CWD=$ws run vitest run packages/a/src)"
check 'vitest given 4 files: gated' \
  "$(gated tests vitest ' [run] [src/a.test.ts] [src/b.test.ts] [src/c.test.ts] [src/d.test.ts]')" \
  "$(RUN_CWD=$ws/packages/a run vitest run src/a.test.ts src/b.test.ts src/c.test.ts src/d.test.ts)"
check 'vitest given a missing file: gated' "$(gated tests vitest ' [run] [src/zz.test.ts]')" \
  "$(RUN_CWD=$ws/packages/a run vitest run src/zz.test.ts)"
check 'vitest given a glob: gated' "$(gated tests vitest ' [run] [src/*.test.ts]')" \
  "$(RUN_CWD=$ws/packages/a run vitest run 'src/*.test.ts')"
check 'vitest related: gated' "$(gated tests vitest ' [related] [src/a.test.ts]')" \
  "$(RUN_CWD=$ws/packages/a run vitest related src/a.test.ts)"
check 'turbo run build: gated --job' "$(gated job turbo ' [run] [build] [--filter=x]')" "$(run turbo run build --filter=x)"
check 'turbo test: gated --tests' "$(gated tests turbo ' [test]')" "$(run turbo test)"
check 'turbo --filter x typecheck: gated' "$(gated job turbo ' [--filter] [x] [typecheck]')" \
  "$(run turbo --filter x typecheck)"
check 'pnpm --filter x typecheck: gated' "$(gated job pnpm ' [--filter] [x] [typecheck]')" \
  "$(run pnpm --filter x typecheck)"
check 'pnpm -F x test: gated --tests' "$(gated tests pnpm ' [-F] [x] [test]')" "$(run pnpm -F x test)"
check 'pnpm -r run build: gated' "$(gated job pnpm ' [-r] [run] [build]')" "$(run pnpm -r run build)"
check 'pnpm exec tsc: gated' "$(gated job pnpm ' [exec] [tsc] [--noEmit]')" "$(run pnpm exec tsc --noEmit)"
check 'pnpm vitest run (no file): gated' "$(gated tests pnpm ' [vitest] [run]')" "$(run pnpm vitest run)"
check 'pnpm exec playwright test: gated' "$(gated tests pnpm ' [exec] [playwright] [test]')" \
  "$(run pnpm exec playwright test)"
check 'npx tsc: gated' "$(gated job npx ' [tsc] [-p] [.]')" "$(run npx tsc -p .)"
check 'npx --yes turbo lint: gated' "$(gated job npx ' [--yes] [turbo] [lint]')" "$(run npx --yes turbo lint)"
check "a package's own build, from its folder: gated" "$(gated job pnpm ' [build]')" \
  "$(RUN_CWD=$ws/packages/a run pnpm build)"
check 'build at a non-DorkOS workspace root: gated' "$(gated job pnpm ' [build]')" \
  "$(RUN_CWD=$ws run pnpm build)"
check 'DorkOS root lint (turbo lint, no gate of its own): gated' "$(gated job pnpm ' [lint]')" \
  "$(RUN_CWD=$dk run pnpm lint)"

# --- LIGHT IS UNTOUCHED -----------------------------------------------------
check 'pnpm install: light' "$(light pnpm ' [install] [--frozen-lockfile]')" "$(run pnpm install --frozen-lockfile)"
check 'argv kept exactly (space, empty word, glob)' "$(light pnpm ' [run] [a b] [] [*]')" \
  "$(run pnpm run 'a b' '' '*')"
check 'vitest given 3 existing files: light' \
  "$(light vitest ' [run] [src/a.test.ts] [src/b.test.ts] [src/c.test.ts]')" \
  "$(RUN_CWD=$ws/packages/a run vitest run src/a.test.ts src/b.test.ts src/c.test.ts)"
check 'tsc --version: light' "$(light tsc ' [--version]')" "$(run tsc --version)"
check 'turbo dev: light' "$(light turbo ' [dev]')" "$(run turbo dev)"
check 'turbo build --help: light' "$(light turbo ' [build] [--help]')" "$(run turbo build --help)"
check 'npx prettier: light' "$(light npx ' [prettier] [--check] [x]')" "$(run npx prettier --check x)"
check 'DorkOS root check:* script: light' "$(light pnpm ' [check:config-migration]')" \
  "$(RUN_CWD=$dk run pnpm check:config-migration)"
check 'DorkOS root build joins the gate itself: no gate, no shims below' "$(straight pnpm ' [build]')" \
  "$(RUN_CWD=$dk run pnpm build)"
check 'pnpm -w build from a DorkOS package goes to the root: no gate' "$(straight pnpm ' [-w] [build]')" \
  "$(RUN_CWD=$dk/apps/server run pnpm -w build)"
check 'pnpm heavy: no second gate, no shims below' "$(straight pnpm ' [heavy] [pnpm] [typecheck]')" \
  "$(run pnpm heavy pnpm typecheck)"

: >"$log"
(
  cd "$tmp" && printf 'from-stdin' | env -u CI -u DORKOS_HEAVY_SLOT_HELD -u DORKOS_HEAVY_SHIM_DEPTH \
    PATH="$base_path" STUB_LOG="$log" STUB_READ=1 DORKOS_HEAVY_SHIM_LOCK="$gate" pnpm install
) >/dev/null
check 'stdin reaches the real program (light)' \
  'REAL pnpm [install] | stdin=from-stdin | shims-on-path=yes | depth=1' "$(cat "$log")"
: >"$log"
(
  cd "$tmp" && printf 'into-gate' | env -u CI -u DORKOS_HEAVY_SLOT_HELD -u DORKOS_HEAVY_SHIM_DEPTH \
    PATH="$base_path" STUB_LOG="$log" STUB_READ=1 DORKOS_HEAVY_SHIM_LOCK="$gate" tsc
) >/dev/null
check_has 'stdin reaches the real program (gated)' 'REAL tsc | stdin=into-gate' "$(cat "$log")"
check_has 'exit code passes through (light)' 'exit=7' "$(RUN_ENV='STUB_EXIT=7' run pnpm install)"
check_has 'exit code passes through (gated)' 'exit=9' "$(RUN_ENV='STUB_EXIT=9' run tsc)"

# --- NO LOOP ----------------------------------------------------------------
check 'slot already held: straight through, no gate' "$(straight tsc '')" \
  "$(RUN_ENV='DORKOS_HEAVY_SLOT_HELD=1' run tsc)"
check 'inside the app turn: straight through' "$(straight vitest ' [run]')" \
  "$(RUN_ENV='DORKOS_LOAD_GATE_IN_TURN=1' run vitest run)"
check 'CI: straight through, no gate' "$(light tsc '')" "$(RUN_ENV='CI=true' run tsc)"

loop="$tmp/loop"
mkdir -p "$loop"
ln -s "$shims/pnpm" "$loop/pnpm"
out=$(RUN_PATH="$shims:$loop:$bin:/usr/bin:/bin" run pnpm install)
check_has 'a "real" pnpm that links back to the shim: refused' 'exit=126' "$out"
check_has '... and says why' 'is a heavy shim itself' "$out"
check '... and nothing ran' 0 "$(printf '%s\n' "$out" | grep -c '^REAL' || true)"
copy="$tmp/copy"
mkdir -p "$copy"
cp "$shims/tsc" "$copy/tsc"
check_has 'a copied shim further down PATH: refused' 'exit=126' \
  "$(RUN_PATH="$shims:$copy:$bin:/usr/bin:/bin" run tsc --version)"
alias_dir="$tmp/alias/heavy-shims"
mkdir -p "$tmp/alias"
ln -s "$shims" "$alias_dir"
check 'the shim folder twice, under another spelling: skipped, not looped' \
  "$(light tsc ' [--version]')" "$(RUN_PATH="$alias_dir:$shims:$bin:/usr/bin:/bin" run tsc --version)"

out=$(RUN_ENV='DORKOS_HEAVY_SHIM_DEPTH=3' run pnpm install)
check_has 'depth guard: a fourth nested shim is refused' 'exit=126' "$out"
check_has '... and says why' 'nested 3 deep' "$out"
check_has 'depth 2 still runs' 'depth=3' "$(RUN_ENV='DORKOS_HEAVY_SHIM_DEPTH=2' run pnpm install)"
out=$(RUN_ENV='STUB_RECURSE=1' run pnpm install)
check 'a real recursive chain stops after 3' 3 "$(printf '%s\n' "$out" | grep -c '^REAL pnpm')"
check_has '... with the refusal' 'exit=126' "$out"

# --- NO SILENT FAILURE ------------------------------------------------------
out=$(RUN_PATH="$shims:/usr/bin:/bin" run turbo build)
check_has 'no real turbo: 127' 'exit=127' "$out"
check_has "... and says there is no real 'turbo'" "no real 'turbo' on PATH" "$out"
out=$(RUN_LOCK="$tmp/no-such-gate.sh" run tsc)
check_has 'no gate script: runs the real program' 'REAL tsc' "$out"
check_has '... and says so' 'no gate at' "$out"

# --- THE REAL GATE, switched off (no slot, line or load wait) ----------------
out=$(RUN_LOCK="$lock_real" RUN_ENV='DORKOS_HEAVY_LOCK=0' run tsc --noEmit)
check_has 'real heavy-run-lock.sh runs the real tsc once' \
  'REAL tsc [--noEmit] | stdin= | shims-on-path=no' "$out"
check 'real heavy-run-lock.sh: exactly one run' 1 "$(printf '%s\n' "$out" | grep -c '^REAL')"

echo "heavy shims: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
