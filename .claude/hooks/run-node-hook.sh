#!/bin/bash
# run-node-hook.sh — run a Node-based .claude hook with an EXPLICITLY resolved
# node, and fail CLOSED for the guards when there is none.
#
# WHY THIS EXISTS
#
# The four PreToolUse guards (file-guard, git-guard, process-guard,
# merge-guard) are how AGENTS.md Hard Rules 6 and 7, and the no-admin-merge
# rule in contributing/ci.md, are actually enforced: the stash and pathspec
# checkout commands, and the kill-by-name commands, are refused by code
# because prose did not hold. settings.json used to start each of them with a
# bare `node`, and `#!/usr/bin/env node` on the .mjs files is the same PATH
# lookup, not a second chance.
#
# On a machine where node is nvm-managed, node is NOT on a stripped PATH:
#   $ env -i /bin/sh -c 'command -v node'        -> nothing
#   $ env -i /bin/sh -c '/usr/bin/env node -v'   -> not found
# Hooks inherit the environment of the process that launched Claude Code, so
# whenever that environment has no nvm-initialised PATH (a launchd/LaunchAgent
# start, a desktop-app launch, a stripped-env CI shell), the guard command
# exits 127 instead of running.
#
# 127 is not a block. From the Claude Code hooks reference, "Exit code output":
# exit 2 is the blocking error, and "Any other exit code doesn't block on its
# own for most hook events" — a hook that cannot start "lands in the same
# non-blocking bucket ... the action proceeds". So a missing node did not make
# the guards noisy, it made them absent: the commands Hard Rules 6 and 7 exist
# to refuse ran, silently unguarded (DOR-2121).
#
# A safety control must not be wagered on a PATH lookup. This wrapper resolves
# node itself and, when it cannot, refuses the tool call with an explanation
# rather than letting it through.
#
# USAGE
#   .claude/hooks/run-node-hook.sh [--warn-only] <script.mjs> [args...]
#
# Default (no flag) is FAIL CLOSED: no node, no runnable script, no argument
# at all -> exit 2 with a one-line reason on stderr. That is the correct
# default, because every way of getting this wrong should end with the guard
# on rather than off.
#
# `--warn-only` is the deliberate opt-out, and exactly one caller takes it:
# `check-any-changed.mjs`, the PostToolUse reminder that nudges about docs and
# changelog fragments after an edit. It guards nothing. Failing it closed would
# refuse EVERY Write/Edit on a machine without node — turning a missing
# reminder into a total work stoppage — so it prints a loud warning and exits 0
# instead. A new node hook gets no flag unless it, too, protects nothing.
#
# HOW NODE IS RESOLVED, in order, first hit wins:
#   1. node in an ABSOLUTE directory on PATH   (the normal case; PATH is fine)
#   2. $NVM_BIN/node                           (an nvm shell that exported it)
#   3. highest ~/.nvm/versions/node/*/bin/node (nvm installed, PATH stripped)
#   4. /opt/homebrew/bin/node                  (Homebrew, Apple Silicon)
#   5. /usr/local/bin/node                     (Homebrew Intel, nodejs.org pkg)
#
# DORKOS_HOOK_NODE_PATHS overrides steps 2-5 with its own colon-separated list
# of candidate node BINARIES (not directories). Two uses: a machine whose node
# lives somewhere none of the above names, and the fixture suite, which sets it
# to the empty string to prove the fail-closed branch without depending on
# whether the test machine happens to have a Homebrew node. Step 1 is never
# overridden — if node is already on PATH, that is the node to use.
#
# NOTHING BELOW CALLS AN EXTERNAL COMMAND. No basename, no ls, no sort: this
# script's whole job is to behave when PATH is broken, and a PATH that is empty
# rather than merely stale would make every one of those unfindable — the same
# failure, one level down. `[`, `printf`, `case`, `set` and globbing are all
# shell builtins, so the only binary this file needs is the node it resolves.
# That is also why the version pick below is written out by hand instead of
# piping the glob through `sort -V`.
#
# THE `cd` IN FRONT OF THIS IS PART OF THE GUARD. Each guard's settings.json
# entry reads `cd "<project dir>" && <this> || exit 2`, and that trailing
# `|| exit 2` is load-bearing, not decoration. Without it two measured paths
# still failed open, both before this wrapper is ever reached:
#   - CLAUDE_PROJECT_DIR naming a directory that no longer exists: the `cd`
#     fails, the shell exits 1, and 1 is non-blocking.
#   - CLAUDE_PROJECT_DIR unset AND `git rev-parse` unable to answer (no git on
#     PATH, or not a checkout): the anchor expands to the empty string, `cd ""`
#     SUCCEEDS in bash leaving the directory unchanged, this file is then not
#     found at a relative path, and the shell exits 127 — also non-blocking.
# `|| exit 2` converts every non-zero outcome of the whole line, including
# both of those and a deleted wrapper, into a block. The allowed path still
# exits 0, so nothing is refused that was not already being refused.
#
# COVERAGE THIS DOES NOT HAVE (stated plainly, on purpose — this list is known
# to be incomplete, and is worth more than one that claims to be total)
#
#   - A guard entry DELETED from settings.json is not something any running
#     hook can notice; only scripts/test-run-node-hook.sh can, and it asserts
#     all four are present and wrapped.
#   - An absolute PATH directory is trusted. If someone can write a `node`
#     into /usr/local/bin they own the machine already, but say it plainly:
#     the walk below rejects the current directory, not a compromised system
#     directory.
#   - Nothing here validates that the resolved node RUNS. A node too old for
#     the guard's syntax exits non-zero, which the `|| exit 2` above turns
#     into a block rather than a silent pass — fail closed, but with a
#     confusing message.
#   - The guards' own matchers have their own holes, listed in their own
#     headers. This file only decides whether they get to run at all.
#
# Fixtures: scripts/test-run-node-hook.sh (including the two `cd` rows above,
# which it runs against the REAL command strings read out of settings.json)
set -u

warn_only=0
if [ "${1:-}" = "--warn-only" ]; then
  warn_only=1
  shift
fi

script=${1:-}
if [ -z "$script" ]; then
  printf '[run-node-hook] blocked: no hook script was named — refusing rather than proceeding unguarded (DOR-2121)\n' >&2
  exit 2
fi
shift

name=${script##*/}
name=${name%.mjs}

# Refuse (or, for --warn-only, complain and stand aside) with one line naming
# the hook and why it could not run.
give_up() {
  if [ "$warn_only" -eq 1 ]; then
    printf '[%s] warning: %s — this hook did not run (DOR-2121)\n' "$name" "$1" >&2
    exit 0
  fi
  printf '[%s] blocked: %s — the guard cannot run, so the command is refused (DOR-2121)\n' "$name" "$1" >&2
  exit 2
}

[ -f "$script" ] || give_up "hook script not found at $script (from $PWD)"

# Walk PATH by hand instead of asking `command -v`, and trust only ABSOLUTE
# entries. Measured, because the obvious shortcuts are both wrong:
#   PATH=""        -> `command -v node` returns "$PWD/node". It is absolute,
#                     so an "is it absolute?" test passes it, and $PWD for
#                     these guards is the repo root — where any branch can add
#                     a file named `node` and have it run as the interpreter
#                     of the hook that is supposed to police that branch.
#   PATH unset     -> returns "./node".
#   PATH="." or an empty entry inside a normal PATH (":/usr/bin") -> the
#                     current directory again.
# So neither "did command -v find something" nor "is the answer absolute" is
# the safe question. The safe question is which directory the answer came
# from, and that is only knowable by doing the walk here.
node_bin=""
if [ -n "${PATH:-}" ]; then
  saved_ifs=${IFS-}
  IFS=:
  # `set -f` because an unquoted $PATH is subject to pathname expansion as
  # well as word splitting: a PATH entry of "/opt/*" would expand to whatever
  # happens to match, and a `node` under any of those directories would be
  # chosen although nothing named that directory. Measured. Globbing goes
  # back on below, where the nvm walk needs it.
  set -f
  for dir in $PATH; do
    # Word splitting drops empty fields, and every remaining relative entry
    # ("." , "bin", "..") means the current directory. Skip them all.
    case $dir in
      /*) ;;
      *) continue ;;
    esac
    if [ -x "$dir/node" ] && [ ! -d "$dir/node" ]; then
      node_bin=$dir/node
      break
    fi
  done
  set +f
  IFS=$saved_ifs
fi

if [ -z "$node_bin" ]; then
  candidates=()
  if [ -n "${DORKOS_HOOK_NODE_PATHS+set}" ]; then
    saved_ifs=${IFS-}
    IFS=:
    set -f # same reason as the PATH walk above: entries are paths, not globs
    for candidate in $DORKOS_HOOK_NODE_PATHS; do
      [ -n "$candidate" ] && candidates+=("$candidate")
    done
    set +f
    IFS=$saved_ifs
  else
    [ -n "${NVM_BIN:-}" ] && candidates+=("$NVM_BIN/node")
    if [ -n "${HOME:-}" ]; then
      # Highest installed nvm version, compared numerically. A lexical pick
      # would rank v9 above v10, and an old major may not run these hooks.
      best=""
      best_rank=""
      for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
        [ -x "$candidate" ] || continue
        version=${candidate#"$HOME"/.nvm/versions/node/}
        version=${version%%/*}
        version=${version#v}
        major=${version%%.*}
        rest=${version#*.}
        minor=${rest%%.*}
        patch=${rest##*.}
        case "$major.$minor.$patch" in
          *[!0-9.]* | *..* | .* | *.) rank=000000000000000 ;;
          *) rank=$(printf '%05d%05d%05d' "$major" "$minor" "$patch") ;;
        esac
        if [ -z "$best_rank" ] || [[ $rank > $best_rank ]]; then
          best=$candidate
          best_rank=$rank
        fi
      done
      [ -n "$best" ] && candidates+=("$best")
    fi
    candidates+=(/opt/homebrew/bin/node /usr/local/bin/node)
  fi

  # bash 3.2 (the macOS /bin/bash) errors on "${empty[@]}" under `set -u`.
  if [ ${#candidates[@]} -gt 0 ]; then
    for candidate in "${candidates[@]}"; do
      if [ -x "$candidate" ]; then
        node_bin=$candidate
        break
      fi
    done
  fi
fi

[ -n "$node_bin" ] || give_up 'node not found on PATH'

# exec so stdin (the PreToolUse payload the hook reads) passes through
# untouched and the hook's own exit code is this wrapper's exit code.
exec "$node_bin" "$script" "$@"
