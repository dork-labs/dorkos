#!/usr/bin/env bash
# Fixture suite for .claude/hooks/run-node-hook.sh, the wrapper the four
# PreToolUse guards in .claude/settings.json run through.
#
# It exists because the failure it prevents was invisible from inside a working
# session. The guards used to be started with a bare `node`, node here is
# nvm-managed, and a hook that cannot start exits 127 — which the Claude Code
# hooks reference classifies as a NON-blocking error: the tool call proceeds.
# So on any machine whose launching environment lacked an nvm PATH, AGENTS.md
# Hard Rules 6 and 7 were enforced by nothing at all, and nothing said so
# (DOR-2121).
#
# Every case below runs the real wrapper as a real process. The fail-closed
# cases are hermetic: PATH is emptied, HOME is pointed at a scratch dir, and
# DORKOS_HOOK_NODE_PATHS is set to the empty string, so the verdict cannot
# depend on whether this machine happens to have a Homebrew node. The
# resolution cases use fake `node` executables that print the path they were
# invoked as, which is the only way to prove WHICH candidate the wrapper chose
# rather than merely that it found one.
#
#   bash scripts/test-run-node-hook.sh
#   WRAPPER=/path/to/other.sh bash scripts/test-run-node-hook.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
wrapper=${WRAPPER:-$repo_root/.claude/hooks/run-node-hook.sh}
git_guard=$repo_root/.claude/hooks/git-guard.mjs
changed_hook=$repo_root/.claude/hooks/check-any-changed.mjs
real_node=$(command -v node)

tmp=$(mktemp -d -t run-node-hook.XXXXXX)
trap 'rm -rf "$tmp"' EXIT

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

# --- fixtures

# A PreToolUse payload the git guard must refuse, and one it must allow. They
# live in files, not in the command line, because this very repo's git guard
# reads the command TEXT: a shell line that merely names the refused command
# is itself refused (see the note in git-guard.mjs).
blocked_payload=$tmp/blocked.json
allowed_payload=$tmp/allowed.json
printf '{"tool_name":"Bash","tool_input":{"command":"git st%s"}}' 'ash' >"$blocked_payload"
printf '{"tool_name":"Bash","tool_input":{"command":"git status"}}' >"$allowed_payload"
empty_payload=$tmp/empty.json
printf '{"tool_name":"Bash","tool_input":{"command":"true"}}' >"$empty_payload"

# A stand-in for node that reports the path it was started as, so a case can
# assert which candidate won rather than just that the wrapper ran something.
mk_fake_node() {
  mkdir -p "$(dirname "$1")"
  printf '#!/bin/sh\nprintf "fake-node %%s args=%%s\\n" "$0" "$*"\n' >"$1"
  chmod +x "$1"
}
mk_fake_node "$tmp/fake-a/node"
mk_fake_node "$tmp/fake-b/node"
mk_fake_node "$tmp/nvm-bin/node"
mk_fake_node "$tmp/on-path/node"
mk_fake_node "$tmp/nvm-home/.nvm/versions/node/v9.1.0/bin/node"
mk_fake_node "$tmp/nvm-home/.nvm/versions/node/v10.0.0/bin/node"
mkdir -p "$tmp/bare-home"

# run <stdin-file> <env assignment>... -- <wrapper arg>...
# Prints "exit=<code> err=<stderr> out=<stdout>". The environment always starts
# empty (`env -i`), so nothing the caller's shell exported can rescue a case
# that is supposed to find no node.
run() {
  local stdin_file=$1
  shift
  local envs=()
  while [ "$1" != "--" ]; do
    envs+=("$1")
    shift
  done
  shift
  local out err code
  err=$tmp/stderr.$$
  out=$(env -i "${envs[@]}" "$wrapper" "$@" <"$stdin_file" 2>"$err")
  code=$?
  printf 'exit=%s err=%s out=%s' "$code" "$(cat "$err")" "$out"
}

blocked_line='[git-guard] blocked: node not found on PATH — the guard cannot run, so the command is refused (DOR-2121)'
warned_line='[check-any-changed] warning: node not found on PATH — this hook did not run (DOR-2121)'

# The guards print multi-line explanations, so those cases assert on the exit
# code plus one distinguishing substring rather than on the whole text. Both
# helpers are top-level functions on purpose: a `case` written inline inside a
# `$(...)` is a bash parse error.
code_and_match() { # <run output> <substring the output must contain>
  local v=$1 needle=$2 code=${1#exit=}
  code=${code%% *}
  case $v in
    *"$needle"*) printf 'exit=%s matched' "$code" ;;
    *) printf 'exit=%s MISSING %s in: %s' "$code" "$needle" "$v" ;;
  esac
}
must_not_contain() { # <run output> <substring the output must NOT contain>
  local v=$1 needle=$2
  case $v in
    *"$needle"*) printf 'present: %s' "$v" ;;
    *) printf absent ;;
  esac
}

# --- the property this whole file exists for: no node means REFUSED, not
# --- "proceeded with a non-blocking error".

check "no node anywhere: the guard exits 2 and says why" \
  "exit=2 err=$blocked_line out=" \
  "$(run "$blocked_payload" PATH= HOME="$tmp/bare-home" DORKOS_HOOK_NODE_PATHS= -- "$git_guard")"

check "no node anywhere: even an innocent command is refused (fail closed, not open)" \
  "exit=2 err=$blocked_line out=" \
  "$(run "$allowed_payload" PATH= HOME="$tmp/bare-home" DORKOS_HOOK_NODE_PATHS= -- "$git_guard")"

check "no node anywhere: an nvm tree that exists but is empty does not rescue it" \
  "exit=2 err=$blocked_line out=" \
  "$(run "$blocked_payload" PATH= HOME="$tmp/nvm-home" DORKOS_HOOK_NODE_PATHS= -- "$git_guard")"

check "--warn-only: a hook that guards nothing warns loudly and stands aside" \
  "exit=0 err=$warned_line out=" \
  "$(run "$empty_payload" PATH= HOME="$tmp/bare-home" DORKOS_HOOK_NODE_PATHS= -- --warn-only "$changed_hook")"

# --- with node reachable, the wrapper is transparent

on_path=$(dirname "$real_node")

refused=$(run "$blocked_payload" PATH="$on_path" -- "$git_guard")
check "node on PATH: the guard's own refusal is passed through (exit 2, its message)" \
  "exit=2 matched" "$(code_and_match "$refused" 'Blocked:')"

check "node on PATH: an allowed command passes, silently" \
  "exit=0 err= out=" \
  "$(run "$allowed_payload" PATH="$on_path" -- "$git_guard")"

check "node on PATH: the wrapper stays silent — the refusal is the guard's, not its own" \
  absent "$(must_not_contain "$refused" 'DOR-2121')"

# --- resolution order

check "PATH wins over DORKOS_HOOK_NODE_PATHS" \
  "exit=0 err= out=fake-node $tmp/on-path/node args=$git_guard" \
  "$(run "$empty_payload" PATH="$tmp/on-path" DORKOS_HOOK_NODE_PATHS="$tmp/fake-b/node" -- "$git_guard")"

check "DORKOS_HOOK_NODE_PATHS skips entries that do not exist and takes the first that does" \
  "exit=0 err= out=fake-node $tmp/fake-a/node args=$git_guard" \
  "$(run "$empty_payload" PATH= DORKOS_HOOK_NODE_PATHS="$tmp/nowhere/node:$tmp/fake-a/node:$tmp/fake-b/node" -- "$git_guard")"

check "NVM_BIN is used when PATH has no node" \
  "exit=0 err= out=fake-node $tmp/nvm-bin/node args=$git_guard" \
  "$(run "$empty_payload" PATH= HOME="$tmp/bare-home" NVM_BIN="$tmp/nvm-bin" -- "$git_guard")"

check "the nvm tree is searched, and v10 beats v9 (numeric, not lexical)" \
  "exit=0 err= out=fake-node $tmp/nvm-home/.nvm/versions/node/v10.0.0/bin/node args=$git_guard" \
  "$(run "$empty_payload" PATH= HOME="$tmp/nvm-home" -- "$git_guard")"

check "arguments after the script reach it untouched" \
  "exit=0 err= out=fake-node $tmp/fake-a/node args=$git_guard --one two" \
  "$(run "$empty_payload" PATH= DORKOS_HOOK_NODE_PATHS="$tmp/fake-a/node" -- "$git_guard" --one two)"

# --- misuse fails closed too

missing=$(run "$empty_payload" PATH="$on_path" -- "$tmp/no-such-guard.mjs")
check "a script that is not there is refused, not skipped" \
  "exit=2 matched" "$(code_and_match "$missing" 'hook script not found')"

check "no script argument at all is refused" \
  "exit=2 err=[run-node-hook] blocked: no hook script was named — refusing rather than proceeding unguarded (DOR-2121) out=" \
  "$(run "$empty_payload" PATH="$on_path" -- )"

# --- the current directory is not a PATH entry, whatever bash thinks

# With PATH="" bash resolves `node` to "$PWD/node" — an ABSOLUTE path to a
# file in the current directory, which for these guards is the repo root. A
# branch that adds a file called `node` would otherwise choose the interpreter
# of the hook policing it. PATH unset, PATH="." and an empty entry inside a
# normal PATH are the same hole spelled differently.
mk_fake_node "$tmp/cwd-node/node"
cwd_node_verdict() { # <PATH value to test>
  local out code
  out=$(cd "$tmp/cwd-node" && env -i PATH="$1" HOME="$tmp/bare-home" DORKOS_HOOK_NODE_PATHS= \
    "$wrapper" "$git_guard" <"$blocked_payload" 2>&1)
  code=$?
  printf 'exit=%s %s' "$code" "$out"
}
check "a node dropped in the current directory is NOT run (PATH empty)" \
  "exit=2 $blocked_line" "$(cwd_node_verdict '')"
check "a node dropped in the current directory is NOT run (PATH=.)" \
  "exit=2 $blocked_line" "$(cwd_node_verdict '.')"
check "a node dropped in the current directory is NOT run (empty entry in PATH)" \
  "exit=2 $blocked_line" "$(cwd_node_verdict ':/nonexistent-bin')"

# An unquoted $PATH is subject to pathname expansion as well as word
# splitting, so a PATH entry of "<dir>/*" used to resolve to whatever matched
# and run a node nothing had named. Same for the override list.
mk_fake_node "$tmp/glob-target/sub/node"
glob_verdict() { # <PATH value> <DORKOS_HOOK_NODE_PATHS value>
  local out code
  out=$(env -i PATH="$1" HOME="$tmp/bare-home" DORKOS_HOOK_NODE_PATHS="$2" \
    "$wrapper" "$git_guard" <"$blocked_payload" 2>&1)
  code=$?
  printf 'exit=%s %s' "$code" "$out"
}
check "a PATH entry containing a glob is not expanded" \
  "exit=2 $blocked_line" "$(glob_verdict "$tmp/glob-target/*" '')"
check "a DORKOS_HOOK_NODE_PATHS entry containing a glob is not expanded" \
  "exit=2 $blocked_line" "$(glob_verdict '' "$tmp/glob-target/*/node")"

# --- the `cd` in front of the wrapper, run as the REAL command string

# settings.json wires each guard as `cd "<anchor>" && <wrapper> … || exit 2`.
# Everything before the wrapper can fail too, and every one of those failures
# used to be a non-blocking exit code. These cases execute the actual string
# out of settings.json rather than a paraphrase of it, because a paraphrase
# would keep passing after someone edits the real one.
guard_command=$(node -e '
const settings = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const all = [];
for (const entries of Object.values(settings.hooks || {}))
  for (const entry of entries) for (const hook of entry.hooks) all.push(hook.command);
const hit = all.find((c) => c.includes("git-guard.mjs"));
if (!hit) throw new Error("no git-guard entry in settings.json");
process.stdout.write(hit);
' "$repo_root/.claude/settings.json" 2>&1) || guard_command="false # probe failed: $guard_command"

# Run from a directory that is NOT the checkout. Running from $repo_root made
# the two UNSET rows below prove nothing: the anchor collapsed to "", `cd ""`
# left the shell in the repo, and the wrapper was then found at its relative
# path and failed closed on its own merits — so the rows stayed green with
# `|| exit 2` deleted, which is exactly what they exist to catch.
cd_verdict() { # <shell> <CLAUDE_PROJECT_DIR or the word UNSET> <PATH value>
  local shell=$1 root=$2 path=$3 out code
  if [ "$root" = UNSET ]; then
    out=$(cd "$tmp" && env -i PATH="$path" "$shell" -c "$guard_command" <"$blocked_payload" 2>&1)
  else
    out=$(cd "$tmp" && env -i PATH="$path" CLAUDE_PROJECT_DIR="$root" "$shell" -c "$guard_command" <"$blocked_payload" 2>&1)
  fi
  code=$?
  # The message differs per shell and per failure; only the verdict is pinned.
  printf 'exit=%s' "$code"
}
real_path=$(dirname "$real_node"):/usr/bin:/bin
check "a stale CLAUDE_PROJECT_DIR blocks instead of proceeding (sh)" \
  "exit=2" "$(cd_verdict /bin/sh "$tmp/does-not-exist" "$real_path")"
check "a stale CLAUDE_PROJECT_DIR blocks instead of proceeding (bash)" \
  "exit=2" "$(cd_verdict /bin/bash "$tmp/does-not-exist" "$real_path")"
check "CLAUDE_PROJECT_DIR unset and git unresolvable blocks instead of proceeding (sh)" \
  "exit=2" "$(cd_verdict /bin/sh UNSET '')"
check "CLAUDE_PROJECT_DIR unset and git unresolvable blocks instead of proceeding (bash)" \
  "exit=2" "$(cd_verdict /bin/bash UNSET '')"

# And the whole real line still ALLOWS what it should: `|| exit 2` must not
# turn a clean guard run into a refusal.
allowed_through_real_command=$(cd "$repo_root" && \
  env -i PATH="$real_path" CLAUDE_PROJECT_DIR="$repo_root" /bin/sh -c "$guard_command" <"$allowed_payload" 2>&1)
check "the real wired command still allows an innocent command" \
  "exit=0 out=" "exit=$? out=$allowed_through_real_command"

# --- the wiring: a guard that stops going through the wrapper, or stops being
# --- listed at all, loses everything above, and nothing else would notice.

# `|| probe=…` is not a nicety. Captured stdout alone is empty when the probe
# THROWS — unparseable settings.json, an entry with no `hooks` key — and an
# empty result is what passing looks like here, so the check would certify the
# file it could not read.
probe=$(node -e '
const settings = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const guards = ["file-guard.mjs", "git-guard.mjs", "process-guard.mjs", "merge-guard.mjs"];
const problems = [];
const wired = new Set();
for (const [event, entries] of Object.entries(settings.hooks || {})) {
  for (const entry of entries) {
    for (const hook of entry.hooks) {
      const command = hook.command;
      // Presence is only satisfied by the real invocation. Matching a bare
      // mention of the filename let a decoy — or a comment-like string that
      // merely names the guard — stand in for the entry it replaced.
      const wrapped = guards.find((g) =>
        command.includes("run-node-hook.sh .claude/hooks/" + g)
      );
      const mentioned = guards.find((g) => command.includes(g));
      if (mentioned && !wrapped) {
        problems.push(event + " (guard named but not wrapped): " + command);
      }
      if (wrapped) {
        if (!command.endsWith("|| exit 2")) {
          problems.push(event + " (no fail-closed on the cd): " + command);
        } else {
          wired.add(wrapped);
        }
      }
      if (/(^|\s)node\s+\S+\.mjs/.test(command)) {
        problems.push(event + " (bare node): " + command);
      }
    }
  }
}
for (const guard of guards) {
  if (!wired.has(guard)) problems.push("not wired at all: " + guard);
}
process.stdout.write(problems.join("\n"));
' "$repo_root/.claude/settings.json" 2>&1) || probe="probe failed (exit $?): $probe"
check "all four guards are present, wrapped, and fail closed; no hook runs a bare node" "" "$probe"

printf 'run-node-hook fixtures: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
