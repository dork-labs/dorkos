#!/usr/bin/env bash
# Fixture suite for scripts/codex-macos-scope.sh, the list that decides whether
# a change pays for the macOS Codex binary run (DOR-4402).
#
# Both directions fail quietly:
#
#   too narrow — a change that can break Seatbelt-protected secrets on macOS
#                reports green without the macOS run, the failure DOR-4402
#                exists to catch;
#   too broad  — every change holds a macOS runner for about five minutes.
#
# So every entry has a path that must match, and the near-misses a regex gets
# wrong (an unanchored dot, a prefix without its slash, a sibling runtime) have
# a path that must not.
#
# Hermetic: stdin in, one word out, no git and no network.
#
#   bash scripts/test-codex-macos-scope.sh
#   SCOPE=/path/to/other.sh bash scripts/test-codex-macos-scope.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scope=${SCOPE:-$repo_root/scripts/codex-macos-scope.sh}

pass=0
fail=0

# expect <want> <label> <paths...>: the paths, one per line, must score <want>.
expect() {
  local want=$1 label=$2
  shift 2
  local got
  got=$(printf '%s\n' "$@" | bash "$scope" 2>/dev/null)
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $label: expected '$want', got '$got' for: $*" >&2
  fi
}

# --- every entry reaches the macOS suites -----------------------------------
for path in \
  apps/server/src/services/runtimes/codex/app-server/__tests__/app-server.binary.test.ts \
  apps/server/src/services/runtimes/codex/__tests__/credits-provider.binary.test.ts \
  apps/server/src/services/runtimes/codex/app-server/app-server-client.ts \
  apps/server/src/services/runtimes/codex/index.ts \
  apps/server/src/services/runtimes/shared/policy/protected-paths.ts \
  apps/server/src/services/runtimes/shared/runtime-environment.ts \
  apps/server/src/services/runtimes/shared/runtime-environment-config.ts \
  apps/server/src/services/runtimes/shared/runtime-environment-catalog.ts \
  apps/server/src/services/runtimes/claude-code/claude-config-dir.ts \
  apps/server/src/lib/boundary.ts \
  apps/server/src/lib/dork-home.ts \
  packages/shared/src/safe-git.ts \
  packages/shared/src/git-hardening.ts \
  packages/shared/src/directory-grants.ts \
  packages/shared/src/marketplace-schemas.ts \
  apps/server/package.json \
  apps/server/vitest.config.ts \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  VERSION \
  .github/workflows/codex-binary-macos.yml \
  scripts/codex-macos-scope.sh; do
  expect true "in scope: $path" "$path"
done

# Every entry must name something that exists, or the list rots silently when
# a file moves. Folders are checked as folders, files as files.
for path in \
  apps/server/src/services/runtimes/codex \
  apps/server/src/services/runtimes/shared/policy; do
  if [ -d "$repo_root/$path" ]; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    echo "FAIL: the scope names $path/, which is not a folder in this tree" >&2
  fi
done
for path in \
  apps/server/src/services/runtimes/shared/runtime-environment.ts \
  apps/server/src/services/runtimes/shared/runtime-environment-config.ts \
  apps/server/src/services/runtimes/shared/runtime-environment-catalog.ts \
  apps/server/src/services/runtimes/claude-code/claude-config-dir.ts \
  apps/server/src/lib/boundary.ts \
  apps/server/src/lib/dork-home.ts \
  packages/shared/src/safe-git.ts \
  packages/shared/src/git-hardening.ts \
  packages/shared/src/directory-grants.ts \
  packages/shared/src/marketplace-schemas.ts \
  apps/server/vitest.config.ts \
  .github/workflows/codex-binary-macos.yml; do
  if [ -f "$repo_root/$path" ]; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    echo "FAIL: the scope names $path, which is not a file in this tree" >&2
  fi
done

# --- the near-misses stay out ------------------------------------------------
for path in \
  apps/server/src/services/runtimes/codexx/index.ts \
  apps/server/src/services/runtimes/claude-code/runtime.ts \
  apps/server/src/services/runtimes/opencode/index.ts \
  apps/server/src/services/runtimes/shared/policyx/a.ts \
  apps/server/src/services/runtimes/shared/runtime-environment.tsx \
  apps/server/src/services/runtimes/shared/runtime-environment-other.ts \
  apps/server/src/services/runtimes/shared/tool-facts.ts \
  apps/server/src/lib/boundaryXts \
  apps/server/src/lib/logger.ts \
  packages/shared/src/safe-git.test.ts \
  packages/shared/src/transport.ts \
  apps/client/package.json \
  apps/server/package.jsonx \
  apps/server/vitest.config.mts \
  package.json \
  turbo.json \
  vitest.config.ts \
  pnpm-lock.yamlx \
  VERSION.md \
  docs/VERSION \
  .github/workflows/test.yml \
  .github/workflows/codex-binary-macos.yml.orig \
  scripts/test-codex-macos-scope.sh \
  docs/guides/codex.mdx \
  changelog/unreleased/261125-000000-codex.md; do
  expect false "out of scope: $path" "$path"
done

# --- whole diffs --------------------------------------------------------------
expect false 'an empty diff reaches nothing' ''
expect false 'several unrelated files' apps/client/src/a.ts apps/site/src/b.tsx docs/c.mdx
expect true 'one relevant file among unrelated ones' apps/client/src/a.ts VERSION docs/c.mdx

# A large diff whose only match is LAST: the shape a pipe into `grep -m 1` under
# `pipefail` scores as "no match" once the writer takes SIGPIPE.
big=()
for i in $(seq 1 20000); do big+=("apps/client/src/generated/file-$i.ts"); done
expect true 'a 20k-line diff whose one match is last' "${big[@]}" apps/server/src/services/runtimes/codex/a.ts
expect false 'a 20k-line diff with no match' "${big[@]}"

echo "codex-macos-scope: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
