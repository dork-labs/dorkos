#!/usr/bin/env bash
# Fixture suite for scripts/no-code-scope.sh, the decision that lets a pull
# request changing only changelog, docs or version lines skip test.yml's six
# test shards.
#
# Both directions fail quietly:
#
#   too broad  — a change that can break a test skips the shards at PR time,
#                goes green, and is ejected from the merge queue instead.
#   too narrow — every release PR pays six shards of the full suite (13 to 15
#                minutes each on PR #3237) for tests nothing in it can change.
#
# So every kind of path the script lets through has a fixture that must score
# `false`, and the near-misses (a dependency beside a version bump, a code file
# beside docs, an empty diff, a base git cannot find) have one that must score
# `true`.
#
# Hermetic: each case builds a throwaway git repository in a temp directory.
# No network, no pnpm.
#
#   bash scripts/test-no-code-scope.sh
#   SCOPE=/path/to/other.sh bash scripts/test-no-code-scope.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scope=${SCOPE:-$repo_root/scripts/no-code-scope.sh}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.test
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.test
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null

pass=0
fail=0
# A fresh repository with a base commit shaped like a small monorepo. Prints
# its path, and nothing else: it runs in a command substitution.
fresh_repo() {
  local repo
  repo=$(mktemp -d "$work/repo.XXXXXX")
  mkdir -p "$repo/packages/shared/src" "$repo/docs" "$repo/changelog/unreleased" "$repo/blog"
  cat >"$repo/package.json" <<'JSON'
{
  "name": "fixture",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "vitest"
  }
}
JSON
  cat >"$repo/packages/shared/package.json" <<'JSON'
{
  "name": "@fixture/shared",
  "version": "0.1.0",
  "dependencies": {
    "zod": "^3.0.0"
  }
}
JSON
  echo 'export const a = 1;' >"$repo/packages/shared/src/index.ts"
  echo '# Changelog' >"$repo/CHANGELOG.md"
  echo '0.1.0' >"$repo/VERSION"
  echo '# Docs' >"$repo/docs/index.mdx"
  {
    git -C "$repo" init -q
    git -C "$repo" add -A
    git -C "$repo" commit -q -m base
  } >/dev/null 2>&1
  echo "$repo"
}

# expect <want> <label> <repo> [base] [head]: score base..head (default
# HEAD^..HEAD) and compare.
expect() {
  local want=$1 label=$2 repo=$3 base=${4:-} head=${5:-}
  [ -n "$base" ] || base=$(git -C "$repo" rev-parse HEAD^)
  [ -n "$head" ] || head=$(git -C "$repo" rev-parse HEAD)
  local got
  got=$(cd "$repo" && bash "$scope" "$base" "$head" 2>/dev/null)
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $label: expected '$want', got '$got'" >&2
  fi
}

commit() { git -C "$1" add -A && git -C "$1" commit -q --allow-empty -m change >/dev/null; }

bump() { sed -i.bak 's/"version": "0.1.0"/"version": "0.2.0"/' "$1" && rm -f "$1.bak"; }

# --- nothing testable changed: false ------------------------------------------
r=$(fresh_repo)
echo '- a fix' >"$r/changelog/unreleased/261028-000000-fix.md"
commit "$r"
expect false 'a changelog fragment only' "$r"

r=$(fresh_repo)
echo '## 0.2.0' >>"$r/CHANGELOG.md"
echo '0.2.0' >"$r/VERSION"
echo 'more' >"$r/docs/x.mdx"
echo 'post' >"$r/blog/y.mdx"
commit "$r"
expect false 'CHANGELOG.md, VERSION, docs and blog' "$r"

r=$(fresh_repo)
bump "$r/package.json"
commit "$r"
expect false 'a root package.json version bump' "$r"

r=$(fresh_repo)
bump "$r/package.json"
bump "$r/packages/shared/package.json"
echo '## 0.2.0' >>"$r/CHANGELOG.md"
echo '0.2.0' >"$r/VERSION"
commit "$r"
expect false 'a whole release: root and nested version bumps with the changelog' "$r"

r=$(fresh_repo)
bump "$r/packages/shared/package.json"
commit "$r"
expect false 'a nested package.json version bump' "$r"

r=$(fresh_repo)
mkdir -p "$r/docs/guides"
echo 'a' >"$r/docs/guides/with space.mdx"
echo 'b' >"$r/docs/naïve-välkommen.mdx"
commit "$r"
expect false 'docs paths with a space and non-ASCII names' "$r"

r=$(fresh_repo)
git -C "$r" mv docs/index.mdx docs/moved.mdx
commit "$r"
expect false 'a file moved within docs' "$r"

# --- something testable changed: true -----------------------------------------
r=$(fresh_repo)
sed -i.bak 's/"\^3.0.0"/"^3.1.0"/' "$r/packages/shared/package.json" && rm -f "$r/packages/shared/package.json.bak"
commit "$r"
expect true 'a package.json dependency change' "$r"

r=$(fresh_repo)
bump "$r/packages/shared/package.json"
sed -i.bak 's/"\^3.0.0"/"^3.1.0"/' "$r/packages/shared/package.json" && rm -f "$r/packages/shared/package.json.bak"
commit "$r"
expect true 'a version bump beside a dependency change' "$r"

r=$(fresh_repo)
sed -i.bak 's/"test": "vitest"/"test": "vitest run"/' "$r/package.json" && rm -f "$r/package.json.bak"
commit "$r"
expect true 'a root package.json script change' "$r"

r=$(fresh_repo)
mkdir -p "$r/apps/new"
printf '{\n  "version": "0.1.0"\n}\n' >"$r/apps/new/package.json"
commit "$r"
expect true 'a new package.json' "$r"

r=$(fresh_repo)
echo 'export const b = 2;' >>"$r/packages/shared/src/index.ts"
commit "$r"
expect true 'a .ts file' "$r"

r=$(fresh_repo)
echo 'more' >"$r/docs/x.mdx"
echo 'export const b = 2;' >>"$r/packages/shared/src/index.ts"
commit "$r"
expect true 'docs mixed with a .ts file' "$r"

r=$(fresh_repo)
git -C "$r" mv packages/shared/src/index.ts docs/index.ts
commit "$r"
expect true 'a code file moved into docs' "$r"

r=$(fresh_repo)
echo 'x' >"$r/docsx.md"
echo 'x' >"$r/CHANGELOG.md.orig"
commit "$r"
expect true 'near-miss names outside the prose folders' "$r"

r=$(fresh_repo)
mkdir -p "$r/apps/client/docs"
echo 'x' >"$r/apps/client/docs/a.md"
commit "$r"
expect true 'a docs folder that is not the root docs/' "$r"

r=$(fresh_repo)
commit "$r"
expect true 'an empty diff' "$r"

r=$(fresh_repo)
expect true 'an unknown base sha' "$r" 0123456789abcdef0123456789abcdef01234567 "$(git -C "$r" rev-parse HEAD)"
expect true 'an unknown head ref' "$r" "$(git -C "$r" rev-parse HEAD)" no-such-ref

# --- arguments ------------------------------------------------------------------
r=$(fresh_repo)
for args in '' 'one' 'one two three'; do
  # shellcheck disable=SC2086
  got=$(cd "$r" && bash "$scope" $args 2>/dev/null)
  if [ "$got" = true ]; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    echo "FAIL: bad arguments '$args': expected 'true', got '$got'" >&2
  fi
done

# Outside any repository: git fails, and the verdict is still `true`.
mkdir -p "$work/not-a-repo"
got=$(cd "$work/not-a-repo" && GIT_CEILING_DIRECTORIES=$work bash "$scope" HEAD^ HEAD 2>/dev/null)
if [ "$got" = true ]; then pass=$((pass + 1)); else
  fail=$((fail + 1))
  echo "FAIL: outside a repository: expected 'true', got '$got'" >&2
fi

echo "no-code-scope: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
