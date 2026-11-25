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
# A small tree the payload's cwd points at: the guard stats each vitest path, so
# only files that exist here count as named test files.
tree=$payload_dir/tree
for f in apps/server/src/services/core/load-gate/__tests__/load-gate.test.ts \
  scripts/__tests__/load-wait.test.ts apps/server/src/x.test.ts apps/server/src/a.test.ts \
  a.test.ts b.test.ts c.test.ts d.test.ts apps/client/src/x.spec.tsx; do
  mkdir -p "$tree/$(dirname "$f")" && : >"$tree/$f"
done
mkdir -p "$tree/apps/server/src/services/runtimes" "$tree/apps/server/src/routes" "$tree/packages"
export HEAVY_GUARD_FIXTURE_CWD=$tree
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
          cwd: process.env.HEAVY_GUARD_FIXTURE_CWD,
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
    "Blocked: a package manager with"*) echo block-home ;;
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
allow pnpm vitest run --project server apps/server/src/x.test.ts
allow npx vitest --version
allow npx playwright --version
allow npx playwright install --help
# --- vitest given more than a few named files (Nov 25: ~2,200 runs walked the gate). ---
block pnpm vitest run apps/server/src/services/core/load-gate
block pnpm vitest run apps/server/src/services/runtimes apps/server/src/routes packages
block pnpm vitest run auth
block pnpm vitest run a.test.ts b.test.ts c.test.ts d.test.ts
block printf '%s\n' apps/server/src | xargs pnpm vitest run
block find . -name '*.test.ts' | xargs -n 5 npx vitest run
allow pnpm vitest run a.test.ts b.test.ts c.test.ts
allow pnpm vitest run apps/client/src/x.spec.tsx
# --- tsc in any spelling. ---
block tsc --noEmit
block npx tsc -p apps/server/tsconfig.json --noEmit
block pnpm exec tsc --noEmit
block pnpm tsc -b
block node node_modules/typescript/bin/tsc --noEmit
block cd apps/server && npx tsc --noEmit
allow npx tsc --version
allow tsc --help
allow pnpm exec tsc --showConfig
# --- a package's own heavy script. ---
block pnpm --filter @dorkos/server typecheck
block pnpm -F @dorkos/client test
block pnpm --filter=@dorkos/shared build
block pnpm -C apps/server typecheck
block pnpm --dir apps/server run test
block pnpm -r typecheck
block pnpm --recursive run lint
block pnpm --filter @dorkos/server test:unit
block npm --workspace apps/server run typecheck
block npm -w apps/server test
block yarn workspace @dorkos/server typecheck
block cd apps/server && pnpm typecheck
block cd packages/shared; pnpm test
block pnpm lint
block pnpm lint:fix
allow pnpm --filter @dorkos/server dev
allow pnpm -C apps/server exec node -e 1
allow cd apps/server && pnpm dev
allow cd apps/server && ls
allow pnpm -w add -D typescript --help
# --- a raised Node heap outside the gate. ---
block NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @dorkos/server typecheck
block NODE_OPTIONS=--max-old-space-size=8192 node scripts/x.mjs
block export NODE_OPTIONS=--max-old-space-size=8192 && pnpm typecheck
block node --max-old-space-size=8192 node_modules/typescript/bin/tsc
block env NODE_OPTIONS=--max_old_space_size=8192 npx tsc --noEmit
# --- the gate with a raised heap still passes. ---
allow NODE_OPTIONS=--max-old-space-size=8192 pnpm heavy pnpm --filter @dorkos/server typecheck
allow pnpm heavy env NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @dorkos/server typecheck
allow pnpm heavy npx tsc -p apps/server/tsconfig.json --noEmit
allow pnpm heavy pnpm vitest run apps/server/src/routes
allow pnpm heavy bash -c 'cd apps/server && pnpm typecheck'
allow bash scripts/heavy-run-lock.sh --job pnpm --filter @dorkos/server typecheck
# --- Security's review of #4413: scope flags after the script, filters that look like files, cd. ---
block pnpm run --filter @dorkos/server typecheck
block npm run build -w apps/server
block pnpm build --filter x
block pnpm test --filter=@dorkos/client
allow pnpm test -- --filter x
block pnpm vitest run .test.ts
block pnpm vitest run s.test.ts
block pnpm vitest run 'apps/**/x.test.ts'
block pnpm vitest run apps/server/src/missing.test.ts
block pnpm vitest related apps/server/src/x.ts
block cd apps/server/src && pnpm typecheck
block cd apps/server && cd src && pnpm test
allow cd apps/server && cd ../.. && pnpm typecheck
allow cd apps/server && pnpm vitest run src/a.test.ts
# --- a package manager with its home moved (Nov 25 fork bomb), refused even inside the gate. ---
block-home HOME=/tmp/x pnpm vitest run a.test.ts
block-home HOME=$PWD/.tmp/home pnpm install
block-home env HOME=/tmp/h npx vitest run a.test.ts
block-home XDG_DATA_HOME=/tmp/x pnpm -v
block-home PNPM_HOME=/tmp/p pnpm add x
block-home export HOME=/tmp/h && pnpm test
block-home pnpm heavy env HOME=/tmp/h pnpm vitest run a.test.ts
block-home HOME=/tmp/h pnpm heavy pnpm typecheck
block-home pnpm heavy bash -c 'HOME=/tmp/h pnpm vitest run a.test.ts'
block-home bash -c 'HOME=/tmp/h pnpm vitest run a.test.ts'
block-home env -i pnpm install
block-home env -u HOME pnpm install
block-home COREPACK_HOME=/tmp/c corepack enable
block-home HOME=/tmp/h yarn install
block-home HOME=/tmp/h npm ci
allow HOME=/tmp/h git status
allow env HOME=/tmp/h node scripts/x.mjs
allow git commit -m "set HOME=x before pnpm"
allow DORKOS_HOME=/tmp/d pnpm vitest run a.test.ts
# --- a redirection is the shell's, not a vitest path. ---
allow pnpm vitest run a.test.ts 2>&1
allow pnpm vitest run a.test.ts > /tmp/out.txt
allow pnpm vitest run a.test.ts 2> /tmp/err.txt
allow pnpm vitest run a.test.ts &> /tmp/all.txt
allow pnpm vitest run a.test.ts >/tmp/out.txt 2>&1
block pnpm vitest run 2>&1
block pnpm vitest run > /tmp/out.txt
block pnpm vitest run apps/server/src/routes 2>&1
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

# --- `bash <script file>` beside a quoted heredoc: the heredoc stays text (Nov 25 false positive). ---
check 'a PR-body heredoc mentioning vitest, beside bash <script>, is allowed' allow \
  "$(verdict $'cat > /tmp/b.md <<\'EOF\'\nrun pnpm vitest run later\nand npx tsc --noEmit\nEOF\nbash scripts/open-pr.sh --body-file /tmp/b.md')"
check 'a python heredoc with a backticked tsc, beside bash <script>, is allowed' allow \
  "$(verdict $'python3 - <<\'EOF\'\nx = "the `tsc` hook"\nEOF\nbash scripts/test-in-project-hook.sh')"
check 'bash <script> alone is allowed' allow "$(verdict 'bash scripts/test-heavy-command-guard.sh')"
check 'bash <script> does not hide a heavy command beside it' block "$(verdict 'bash scripts/x.sh && turbo build')"
# --- the forms that DO feed text to a shell still unmask it. ---
check 'bash <<EOF runs the heredoc' block "$(verdict $'bash <<\'EOF\'\nturbo build\nEOF')"
check 'a heredoc piped into bash runs it' block "$(verdict $'cat <<\'EOF\' | bash\nturbo build\nEOF')"
check 'bash -s <<EOF runs the heredoc' block "$(verdict $'bash -s <<\'EOF\'\nnpx tsc --noEmit\nEOF')"
check 'sh -lc runs its argument' block "$(verdict "sh -lc 'npx tsc --noEmit'")"
# shellcheck disable=SC2016 # the $( ) is text for the guard to read
check 'a double-quoted substitution still runs' block "$(verdict 'echo "$(turbo build)"')"
check 'a single-quoted substitution is text' allow "$(verdict "echo '\$(turbo build)'")"
check 'eval runs its argument' block "$(verdict 'eval "turbo build"')"

# In a DorkOS chat the server's own hook holds the command in the gate.
check 'a DorkOS chat (DORKOS_SESSION_ID set) is left to the server gate' allow \
  "$(DORKOS_SESSION_ID=fixture-chat verdict 'turbo build')"

# The hook's cwd inside a package makes a bare `pnpm typecheck` that package's own script.
status=$(printf '%s' '{"tool_name":"Bash","cwd":"/repo/apps/server","tool_input":{"command":"pnpm typecheck"}}' |
  node "$guard" >/dev/null 2>&1; echo $?)
check 'pnpm typecheck with cwd in apps/server is refused' 2 "$status"
status=$(printf '%s' '{"tool_name":"Bash","cwd":"/repo/apps/server","tool_input":{"command":"cd src && pnpm typecheck"}}' |
  node "$guard" >/dev/null 2>&1; echo $?)
check 'cd src from apps/server keeps the package context' 2 "$status"
status=$(printf '%s' '{"tool_name":"Bash","cwd":"/repo","tool_input":{"command":"pnpm typecheck"}}' |
  node "$guard" >/dev/null 2>&1; echo $?)
check 'pnpm typecheck with cwd at the root joins the gate itself' 0 "$status"

# A payload the guard cannot read fails open, like its siblings.
status=$(printf 'not json' | node "$guard" >/dev/null 2>&1; echo $?)
check 'an unreadable payload fails open' 0 "$status"
status=$(printf '{"tool_name":"Read","tool_input":{}}' | node "$guard" >/dev/null 2>&1; echo $?)
check 'a non-Bash tool is ignored' 0 "$status"

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
