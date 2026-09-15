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
diff_dir=$(mktemp -d -t process-guard-diff.XXXXXX)
trap 'rm -rf "$payload_dir" "$diff_dir"' EXIT

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
# --- Differential: a fixture a real shell RUNS must never be allowed. ---
# A hand-written verdict only proves what its author believed the shell does.
# So every fixture naming pkill/killall is also run through /bin/bash (3.2 on
# macOS) and zsh with both words pointing at a shim that only touches a marker
# file, in an empty directory, with a bare PATH and HOME. If a shell reached the
# shim, the guard must have blocked it. Fixtures that reach the `kill` builtin
# or sudo are never run, and the real destructive command never is.
mkdir -p "$diff_dir/shim" "$diff_dir/run"
printf '#!/bin/sh\n: >"%s/marker"\n' "$diff_dir" >"$diff_dir/shim/__ran"
chmod +x "$diff_dir/shim/__ran"
diff_shells=(/bin/bash)
if command -v zsh >/dev/null 2>&1; then diff_shells+=("$(command -v zsh)"); fi

differential() {
  local command=$1 actual=$2 standin shell
  case "$command" in *pkill* | *killall*) ;; *) return ;; esac
  standin=${command//pkill/__ran}
  standin=${standin//killall/__ran}
  if printf '%s' "$standin" | grep -Eq '(^|[^[:alnum:]_])(kill|sudo)([^[:alnum:]_]|$)'; then
    return
  fi
  for shell in "${diff_shells[@]}"; do
    rm -f "$diff_dir/marker"
    (cd "$diff_dir/run" && env -i PATH="$diff_dir/shim:/usr/bin:/bin" HOME="$diff_dir/run" \
      "$shell" -c "$standin" </dev/null >/dev/null 2>&1)
    if [ -e "$diff_dir/marker" ]; then
      check "differential: $shell runs it, so it must block: $command" block "${actual%%-*}"
    fi
  done
}

# Run one fixture through the hook, assert its verdict, then cross-check it.
case_check() {
  local name=$1 expected=$2 command=$3 actual
  actual=$(verdict "$command")
  check "$name" "$expected" "$actual"
  differential "$command" "$actual"
}

while read -r expected command; do
  [ -n "${expected:-}" ] || continue
  case "$expected" in \#*) continue ;; esac
  case_check "$command" "$expected" "$command"
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
# --- quoting: bash never expands `...` or $(...) inside single quotes. ---
# A PR body or commit message that names a kill in a markdown code span is
# text, not a command. Blocking it made those bodies impossible to write.
allow gh pr create --body 'blocks `pkill` and `killall`'
allow gh pr create --body 'see $(pkill -f x)'
allow echo 'it'\''s `pkill`'
allow echo "it's fine" 'and `pkill -f x` is quoted'
# Double quotes DO substitute, so the same text there still runs the kill.
block-name echo "`pkill -f x`"
block-name echo "$(pkill -f x)"
block-name echo "it's $(pkill -f x)"
block-name gh pr create --body "blocks `pkill`"
# A backtick between two escaped quotes sits outside every quote.
block-name echo 'a'\' `pkill -f x` \''b'
# Malformed quoting keeps the strict reading rather than guessing.
block-name echo 'unterminated `pkill -f x`
# A wrapper or eval runs its single-quoted argument, so the quotes protect nothing.
block-name bash -c 'echo $(pkill -f x)'
block-name zsh -c 'echo $(pkill -f x)'
block-name bash -c 'x=$(pkill -f x)'
block-name sudo bash -c 'echo `pkill -f x`'
block-name eval '$(pkill -f x)'
block-name eval 'pkill -f x'
# Inside $'...' a \' does not close the quote; read as strict, not modelled.
block-name echo $'\'' $(pkill -f x) '\'
block-name echo $'\'' `pkill -f x` '\'
# Inside backticks the next backtick ends the substitution whatever the quotes say.
block-name echo `echo it's` $(pkill -f x) `echo ok'`
# --- Quotes are only trusted on a line made entirely of known text-takers. ---
# Plenty of commands run their quoted argument. Every one below reached a real
# shell's kill when an earlier version trusted quotes unless it recognised the
# runner, so trusting is now the exception, not the rule.
block-name bash -lc 'echo $(pkill -f x)'
block-name bash -ec 'echo $(pkill -f x)'
block-name sh -xc 'echo `pkill -f x`'
block-name bash -c -- 'echo $(pkill -f x)'
block-name exec sh -c 'echo $(pkill -f x)'
block-name if bash -c 'echo $(pkill -f x)'; then :; fi
block-name while sh -c 'echo $(pkill -f x)'; do break; done
block-name until sh -c 'echo $(pkill -f x)'; do :; done
block-name nice -n 5 sh -c 'echo $(pkill -f x)'
block-name env -i PATH="$PATH" sh -c 'echo $(pkill -f x)'
block-name timeout 5 bash -c 'echo $(pkill -f x)'
block-name echo a | xargs sh -c 'echo $(pkill -f x)'
block-name find . -maxdepth 0 -exec sh -c 'echo $(pkill -f x)' \;
block-name trap 'echo $(pkill -f x)' EXIT
block-name node -e 'require("child_process").execSync("echo $(pkill -f x)")'
# A text-taker's substitution is itself a command, so its quotes are not trusted.
block-name echo $(bash -c 'echo $(pkill -f x)')
block-name echo "$(bash -c 'echo $(pkill -f x)')"
block-name echo `bash -c 'echo $(pkill -f x)'`
CASES

# --- heredocs: a quoted delimiter turns expansion off, an unquoted one does not. ---
# These span lines, so they cannot ride the one-line CASES table above.
case_check 'quoted heredoc PR body naming a kill' allow \
  $'gh pr create --body "$(cat <<\'EOF\'\nblocks `pkill`\nEOF\n)"'
case_check 'double-quoted heredoc delimiter' allow \
  $'cat <<"EOF" >notes.md\nsee $(pkill -f x) and `killall`\nEOF'
case_check 'backslash-quoted heredoc delimiter' allow \
  $'cat <<\\EOF >notes.md\nsee `pkill -f x`\nEOF'
case_check 'tab-stripped quoted heredoc' allow \
  $'cat <<-\'EOF\' >notes.md\n\tsee `pkill -f x`\n\tEOF'
case_check 'two quoted heredocs on one line' allow \
  $'cat <<\'A\' <<\'B\'\n`pkill`\nA\n$(pkill -f x)\nB'
case_check 'unquoted heredoc body with backticks' block-name \
  $'cat <<EOF >notes.md\nsee `pkill -f x`\nEOF'
case_check 'unquoted heredoc body with $(...)' block-name \
  $'cat <<EOF >notes.md\nsee $(pkill -f x)\nEOF'
case_check 'single quotes are literal inside an unquoted heredoc' block-name \
  $'cat <<EOF >notes.md\nsee \'$(pkill -f x)\'\nEOF'
case_check 'unquoted heredoc after a quoted one on the same line' block-name \
  $'cat <<\'A\' <<B\n`pkill`\nA\n$(pkill -f x)\nB'
case_check 'a live substitution after a quoted heredoc ends' block-name \
  $'cat <<\'EOF\' >notes.md\n`pkill`\nEOF\necho $(pkill -f x)'
case_check 'quoted heredoc that never closes stays strict' block-name \
  $'cat <<\'EOF\' >notes.md\nsee `pkill -f x`'
# Comments: an apostrophe or a heredoc marker after `#` is not quoting.
case_check 'apostrophe in a trailing comment' block-name \
  $'echo hi # it\'s\necho $(pkill -f x) # \''
case_check 'apostrophes in whole-line comments' block-name \
  $'# don\'t\necho $(pkill -f x)\n# won\'t'
case_check 'heredoc marker inside a comment' block-name \
  $'echo x # <<\'EOF\'\necho $(pkill -f x)\nEOF'
case_check 'heredoc marker flush against a comment' block-name \
  $'echo x #<<\'EOF\'\n`pkill -f x`\nEOF'
# bash 3.2 ends $(...) at the first `)`, even inside a quoted heredoc body.
case_check 'heredoc body closing its substitution early' block-name \
  $'x=$(cat <<\'EOF\'\nhi\n)\necho $(pkill -f x)\nEOF\n)'
# Inside $(...), a quoted heredoc body with an apostrophe is not vouched for.
case_check 'apostrophe in a heredoc body inside a substitution' block-name \
  $'gh pr create --body "$(cat <<\'EOF\'\nit\'s `pkill`\nEOF\n)"'
# bash 3.2 reads the delimiter LINE inside $(...) as syntax too, so an
# apostrophe there shifts where the substitution ends. Both reached the kill.
case_check 'quoted delimiter with an apostrophe inside a substitution' block-name \
  $'echo $(cat <<"it\'s"\nhi\nit\'s\n); cat <<\'X\'\n\'); echo $(pkill -f x)\nX'
case_check 'backslash-quoted delimiter with an apostrophe inside a substitution' block-name \
  $'echo $(cat <<\\it\\\'s\nhi\nit\'s\n) \'\n); echo $(pkill -f x)\n\''

echo "process-guard fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
