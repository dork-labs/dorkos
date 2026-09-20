#!/usr/bin/env bash
# Fixture suite for .claude/hooks/lint-changed.sh, the PostToolUse hook that
# lints a file right after an agent writes it and BLOCKS the write (exit 2)
# when eslint reports an error.
#
# It exists because the block fired on files that are not ours to lint. The
# hook decides "am I in the project?" from the working directory, then lints
# whatever path the tool wrote, so a helper script written into the session
# scratchpad — outside every eslint config — failed with "ESLint couldn't find
# an eslint.config.* file" and the write was refused (2026-09-19). Nothing in
# the message says the file was out of scope, so it reads as a lint error in
# code the agent just wrote.
#
# Hermetic: each case runs the real hook against a throwaway git checkout whose
# node_modules/.bin/eslint is a stub we control. So the verdicts do not depend
# on a `pnpm install` having run on the machine — this suite is part of the
# scripts-test `fixtures` job, which deliberately installs nothing.
#
#   bash scripts/test-lint-changed-hook.sh
#   HOOK=/path/to/other.sh bash scripts/test-lint-changed-hook.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
hook=${HOOK:-$repo_root/.claude/hooks/lint-changed.sh}

tmp=$(mktemp -d -t lint-changed-hook.XXXXXX)
trap 'rm -rf "$tmp"' EXIT

# A fake project: a real git repo (the hook asks git for its root) with a stub
# eslint that fails for any path containing "bad" and passes otherwise.
project=$tmp/project
mkdir -p "$project/node_modules/.bin" "$project/src"
git -C "$project" init -q
cat >"$project/node_modules/.bin/eslint" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
  *bad*)
    echo "$arg"
    echo "  1:1  error  Parsing error: stub"
    exit 1
    ;;
  esac
done
exit 0
STUB
chmod +x "$project/node_modules/.bin/eslint"
printf 'export default 1;\n' >"$project/src/good.ts"
printf 'export default 1;\n' >"$project/src/bad.ts"

outside=$tmp/outside
mkdir -p "$outside"
printf 'export default 1;\n' >"$outside/bad.mjs"
printf '# notes\n' >"$outside/notes.md"

pass=0
fail=0

# Runs the hook from inside the fake project, the way settings.json does, with
# a PostToolUse payload naming $1. Asserts the exit code is $2.
check() {
  local path=$1 want=$2 name=$3 got
  printf '{"tool_input":{"file_path":"%s"}}' "$path" | (cd "$project" && bash "$hook") >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $name — expected exit $want, got $got"
  fi
}

# 1. THE HOOK CAN STILL FAIL. An in-repo file its linter rejects is blocked —
#    without this case, "exit 0 on everything" would pass the whole suite.
check "$project/src/bad.ts" 2 "inside the repo, lint error: blocked"

# 2. A clean in-repo file passes.
check "$project/src/good.ts" 0 "inside the repo, clean: allowed"

# 3. A file outside the repo is skipped even though the same name, linted in
#    repo, is refused. This is the scratchpad case, and the fix.
check "$outside/bad.mjs" 0 "outside the repo: skipped"

# 4. A non-JavaScript file is skipped by the extension gate.
check "$outside/notes.md" 0 "not a JS/TS extension: skipped"

# 5. A path that merely starts with the repo root's characters is not inside it
#    ("/x/project-notes" vs "/x/project").
sibling=$tmp/project-notes
mkdir -p "$sibling"
printf 'export default 1;\n' >"$sibling/bad.mjs"
check "$sibling/bad.mjs" 0 "sibling directory sharing a prefix: skipped"

echo "lint-changed fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
