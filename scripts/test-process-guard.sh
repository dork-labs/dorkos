#!/usr/bin/env bash
# Fixture suite for .claude/hooks/process-guard.mjs, the PreToolUse(Bash) guard
# that refuses process kills aimed at names, groups, or everything.
#
# It exists for the same reason scripts/test-git-guard.sh does: reasoning
# about what a guard WOULD catch is not evidence about what it DOES catch.
# Every case runs through the hook's real entry point (a PreToolUse payload on
# stdin) and is asserted on the real contract (exit 2 to block, exit 0 to
# allow). The allow half matters as much as the block half — a guard that also
# blocks `kill 12345` is one that gets switched off.
#
#   bash scripts/test-process-guard.sh
#   GUARD=/path/to/other.mjs bash scripts/test-process-guard.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
guard=${GUARD:-$repo_root/.claude/hooks/process-guard.mjs}

payload_dir=$(mktemp -d -t process-guard-payload.XXXXXX)
export PROCESS_GUARD_FIXTURE_PAYLOAD=$payload_dir/payload.json
trap 'rm -rf "$payload_dir"' EXIT

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

# Run one command through the hook exactly as Claude Code would. The payload
# goes through a file rather than a pipe on purpose (see test-git-guard.sh).
verdict() {
  local command=$1 stderr status
  PROCESS_GUARD_FIXTURE_COMMAND="$command" node -e '
      require("fs").writeFileSync(
        process.env.PROCESS_GUARD_FIXTURE_PAYLOAD,
        JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: process.env.PROCESS_GUARD_FIXTURE_COMMAND },
        })
      );
    '
  stderr=$(node "$guard" <"$PROCESS_GUARD_FIXTURE_PAYLOAD" 2>&1 >/dev/null)
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
    "Blocked: pkill"*) echo block-name ;;
    "Blocked: kill aimed"*) echo block-group ;;
    *) echo "block-unknown" ;;
  esac
}

# Each line is `<expected-verdict> <command>`. Comments record why a case is
# here, so a future edit that flips one has to argue with the reason.
while read -r expected command; do
  [ -n "${expected:-}" ] || continue
  case "$expected" in \#*) continue ;; esac
  check "$command" "$expected" "$(verdict "$command")"
done <<'CASES'
# --- kill by name: the incident, and every spelling of the same reflex. ---
block-name pkill -f "tsx src/index.ts"
block-name pkill -f "DORK_HOME=/Users/x/.dork-verify" 2>/dev/null; pkill -f "tsx src/index.ts" -u $USER 2>/dev/null
block-name pkill node
block-name pkill -9 -f vite
block-name pkill -u $USER tsx
block-name killall node
block-name killall -9 Electron
block-name /usr/bin/pkill -f "pnpm dev"
block-name sudo pkill -f dorkos
# Compound commands, wrappers and substitutions — the native prefix matcher's blind spots.
block-name cd /tmp && pkill -f "tsx src/index.ts"
block-name pnpm build; pkill -f vite; echo done
block-name sh -c "pkill -f 'tsx src/index.ts'"
block-name bash -c 'killall node'
block-name echo $(pkill -f vite)
block-name for p in tsx vite; do pkill -f $p; done
block-name (pkill -f vite)
block-name env FOO=1 pkill -f vite
# --- kill aimed at everything or a group. ---
block-group kill -9 -1
block-group kill -1
block-group kill 0
block-group kill -- -1
block-group kill -TERM -1
block-group kill -s TERM -12345
block-group kill -9 -- -4242
block-group kill 12345 0
# --- allowed: a specific process the caller had to look at. ---
allow kill 12345
allow kill -9 12345
allow kill -TERM 12345
allow kill -s KILL 12345
allow kill -1 12345
allow kill -HUP 12345 67890
allow kill -- 12345
allow kill %1
allow kill $!
allow kill $(cat server.pid)
allow kill $(lsof -ti :4358)
allow lsof -ti :4358 | xargs kill
allow kill -l
allow kill -L
# --- allowed: read-only discovery, and words that merely contain "kill". ---
allow pgrep -lf "tsx src/index.ts"
allow pgrep -f vite | head
allow ps aux | grep tsx
allow echo "do not pkill anything"
allow git log --grep=pkill
allow grep -rn "pkill" scripts/
allow node scripts/killswitch.mjs
allow ./bin/kill-switch --dry-run
allow curl -s http://localhost:4242/api/health
CASES

echo "process-guard fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
