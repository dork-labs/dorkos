#!/usr/bin/env bash
# Fixture suite for .claude/hooks/heavy-command-guard.mjs, the PreToolUse(Bash)
# guard that sends a raw heavy command (a whole vitest suite, playwright test,
# a heavy turbo task) into DorkOS's load gate through `pnpm heavy` (DOR-4209).
#
# Every case runs through the hook's real entry point (a PreToolUse payload on
# stdin) and is asserted on the real contract (exit 2 to block, exit 0 to
# allow). The allow half matters as much as the block half: a one-file vitest
# run is the targeted check AGENTS.md asks for, and the wrappers that already
# join the gate must pass, or the guard gets switched off.
#
#   bash scripts/test-heavy-command-guard.sh
#   GUARD=/path/to/other.mjs bash scripts/test-heavy-command-guard.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
guard=${GUARD:-$repo_root/.claude/hooks/heavy-command-guard.mjs}

payload_dir=$(mktemp -d -t heavy-command-guard-payload.XXXXXX)
export HEAVY_GUARD_FIXTURE_PAYLOAD=$payload_dir/payload.json
trap 'rm -rf "$payload_dir"' EXIT
# The DorkOS-chat bypass is its own case below; every other case is a bare session.
unset DORKOS_SESSION_ID

pass=0
fail=0

check() {
  local name=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' \
      "$name" "$expected" "$actual" >&2
  fi
}

# Run one command through the hook exactly as Claude Code would.
verdict() {
  local command=$1 stderr status
  HEAVY_GUARD_FIXTURE_COMMAND="$command" node -e '
      require("fs").writeFileSync(
        process.env.HEAVY_GUARD_FIXTURE_PAYLOAD,
        JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: process.env.HEAVY_GUARD_FIXTURE_COMMAND },
        })
      );
    '
  stderr=$(node "$guard" <"$HEAVY_GUARD_FIXTURE_PAYLOAD" 2>&1 >/dev/null)
  status=$?
  if [ "$status" -eq 0 ]; then
    echo allow
    return
  fi
  if [ "$status" -ne 2 ]; then
    echo "exit-$status"
    return
  fi
  case "$stderr" in
    "Blocked: "*"load gate"*"pnpm heavy"*) echo block ;;
    *) echo "block-unknown" ;;
  esac
}

# Each line is `<expected-verdict> <command>`.
while read -r expected command; do
  [ -n "${expected:-}" ] || continue
  case "$expected" in \#*) continue ;; esac
  check "$command" "$expected" "$(verdict "$command")"
done <<'CASES'
# --- a whole vitest suite, every spelling. ---
block vitest run
block vitest
block pnpm vitest run
block pnpm vitest run --project server
block pnpm exec vitest run
block npx vitest run --reporter dot
block pnpm --filter @dorkos/server exec vitest run
block env VITEST_MAX_WORKERS=4 pnpm vitest run
block timeout 600 npx vitest run
# --- playwright. ---
block npx playwright test
block pnpm exec playwright test --project chromium
block pnpm playwright test apps/e2e/tests/x.spec.ts
block playwright test
# --- heavy turbo tasks. ---
block turbo build
block turbo run build --filter=@dorkos/server
block pnpm turbo typecheck
block pnpm exec turbo lint --affected
block npx turbo run test
block turbo run e2e --filter=@dorkos/e2e
block TURBO_SCM_BASE=main turbo lint
# --- behind a shell, a substitution, a chain. ---
block bash -c 'pnpm vitest run'
block sh -c "turbo build"
block echo start && turbo build
block uptime; npx playwright test
block out=$(pnpm vitest run)
# --- targeted runs stay allowed. ---
allow pnpm vitest run apps/server/src/services/core/load-gate/__tests__/load-gate.test.ts
allow vitest run scripts/__tests__/load-wait.test.ts
allow pnpm vitest run apps/server/src/services/core/load-gate
allow pnpm vitest run --project server apps/server/src/x.test.ts
allow npx vitest --version
allow npx playwright --version
allow npx playwright install --help
# --- the wrappers that already join the gate. ---
allow pnpm heavy pnpm vitest run
allow pnpm heavy turbo build
allow bash scripts/heavy-run-lock.sh --job turbo build
allow bash scripts/heavy-run-lock.sh --label pr1-verify pnpm verify
allow pnpm build
allow pnpm test -- --run
allow pnpm typecheck
allow pnpm verify
allow pnpm verify:preopen
allow pnpm --filter @dorkos/server typecheck
# --- light turbo and everything else. ---
allow turbo dev
allow turbo watch build
allow turbo --version
allow turbo run build --help
allow ls -la
allow git status
# --- text that only names a heavy command. ---
allow echo "run turbo build later"
allow grep -rn "vitest run" scripts
allow git commit -m "ci: stop raw turbo build"
CASES

# In a DorkOS chat the server's own hook holds the command in the gate.
check 'a DorkOS chat (DORKOS_SESSION_ID set) is left to the server gate' allow \
  "$(DORKOS_SESSION_ID=fixture-chat verdict 'turbo build')"

# A payload the guard cannot read fails open, like its siblings.
status=$(printf 'not json' | node "$guard" >/dev/null 2>&1; echo $?)
check 'an unreadable payload fails open' 0 "$status"
status=$(printf '{"tool_name":"Read","tool_input":{}}' | node "$guard" >/dev/null 2>&1; echo $?)
check 'a non-Bash tool is ignored' 0 "$status"

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
