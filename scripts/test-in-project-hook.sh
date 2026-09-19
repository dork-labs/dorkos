#!/usr/bin/env bash
# Fixture suite for .claude/hooks/in-project.sh, the wrapper every working-tree
# hook in .claude/settings.json runs through, and for the anchoring rule those
# commands must follow.
#
# It exists because the failure it prevents was silent: a session that `cd`-ed
# into a sibling repository made every hook resolve THAT repo as the project,
# fail with "No such file or directory", and skip checkpoints, formatting and
# the PreToolUse guards for the turn (2026-09-13). Each case below runs the real
# wrapper with a probe command against real git checkouts built in a temp dir,
# and asserts on the real contract: the probe runs (and where), or the wrapper
# exits 0 with no output.
#
#   bash scripts/test-in-project-hook.sh
#   WRAPPER=/path/to/other.sh bash scripts/test-in-project-hook.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
wrapper=${WRAPPER:-$repo_root/.claude/hooks/in-project.sh}

tmp=$(mktemp -d -t in-project-hook.XXXXXX)
trap 'rm -rf "$tmp"' EXIT

pass=0
fail=0
check() {
  local name=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$name" "$expected" "$actual"
  fi
}

# --- fixtures: a project with a linked worktree, an unrelated repo, a plain dir
mk_repo() {
  git init -q "$1" && git -C "$1" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
}
project=$tmp/project
mk_repo "$project"
mkdir -p "$project/.claude/hooks"
cp "$wrapper" "$project/.claude/hooks/in-project.sh"
git -C "$project" worktree add -q "$tmp/project-wt" -b wt
mkdir -p "$tmp/project-wt/.claude/hooks"
other=$tmp/other
mk_repo "$other"
other_with_hooks=$tmp/other-with-hooks
mk_repo "$other_with_hooks"
mkdir -p "$other_with_hooks/.claude/hooks"
plain=$tmp/plain
mkdir -p "$plain"

# run <cwd> <CLAUDE_PROJECT_DIR or ""> <args...>; prints "exit=<code> out=<stdout>"
run() {
  local cwd=$1 root=$2; shift 2
  local out code
  if [ -n "$root" ]; then
    out=$(cd "$cwd" && CLAUDE_PROJECT_DIR=$root "$project/.claude/hooks/in-project.sh" "$@" 2>&1); code=$?
  else
    out=$(cd "$cwd" && env -u CLAUDE_PROJECT_DIR "$project/.claude/hooks/in-project.sh" "$@" 2>&1); code=$?
  fi
  printf 'exit=%s out=%s' "$code" "$out"
}
real() { cd "$1" && pwd -P; }

# --- the contract
check "main checkout runs the hook in its toplevel" \
  "exit=0 out=$(real "$project")" "$(run "$project" "$project" sh -c 'pwd -P')"
check "a subdirectory of the main checkout runs the hook in the toplevel" \
  "exit=0 out=$(real "$project")" "$(mkdir -p "$project/sub" && run "$project/sub" "$project" sh -c 'pwd -P')"
check "a linked worktree runs the hook in the WORKTREE's toplevel" \
  "exit=0 out=$(real "$tmp/project-wt")" "$(run "$tmp/project-wt" "$project" sh -c 'pwd -P')"
check "another repository is skipped silently" \
  "exit=0 out=" "$(run "$other" "$project" sh -c 'echo ran')"
check "another repository with its own .claude/hooks is still skipped (different common dir)" \
  "exit=0 out=" "$(run "$other_with_hooks" "$project" sh -c 'echo ran')"
check "a directory outside any repo is skipped silently" \
  "exit=0 out=" "$(run "$plain" "$project" sh -c 'echo ran')"
check "arguments reach the hook untouched" \
  "exit=0 out=a b" "$(run "$project" "$project" sh -c 'printf "%s %s" "$1" "$2"' _ a b)"
check "the hook's exit code is the wrapper's exit code" \
  "exit=2 out=" "$(run "$project" "$project" sh -c 'exit 2')"
check "CLAUDE_PROJECT_DIR unset: falls back to the current checkout when it has hooks" \
  "exit=0 out=$(real "$other_with_hooks")" "$(run "$other_with_hooks" "" sh -c 'pwd -P')"
check "CLAUDE_PROJECT_DIR unset: a checkout without .claude/hooks is skipped, not an error" \
  "exit=0 out=" "$(run "$other" "" sh -c 'echo ran')"
check "CLAUDE_PROJECT_DIR pointing at a non-directory: falls back like unset" \
  "exit=0 out=$(real "$project")" "$(run "$project" "$tmp/does-not-exist" sh -c 'pwd -P')"

# --- the anchoring rule in settings.json
settings=$repo_root/.claude/settings.json
anchor='"${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"'
# `|| bad=…` matters: this probe's PASS condition is empty output, so a probe
# that throws (unparseable settings.json, an entry with no `hooks` key) would
# otherwise certify the file it could not read. Measured — it did.
# `includes`, not `endsWith`: a guard command now carries a trailing
# `|| exit 2`, so it no longer ends with its own filename.
bad=$(node -e '
const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const anchor=process.argv[2];
const guards=["file-guard.mjs","git-guard.mjs","process-guard.mjs"];
const out=[];for(const [ev,arr] of Object.entries(s.hooks||{}))for(const h of arr)for(const c of h.hooks){
  const isGuard=guards.some(g=>c.command.includes(g));
  const ok=isGuard ? c.command.startsWith("cd "+anchor+" && ") : c.command.startsWith(anchor+"/.claude/hooks/in-project.sh ");
  if(!ok) out.push(ev+": "+c.command);}
process.stdout.write(out.join("\n"))' "$settings" "$anchor" 2>&1) || bad="probe failed (exit $?): $bad"
check "every settings.json hook is anchored (guards via cd, working-tree hooks via in-project.sh)" "" "$bad"

printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
