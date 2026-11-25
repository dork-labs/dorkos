# shellcheck shell=bash
# The shared body of the heavy-job PATH shims in scripts/heavy-shims/ (pnpm,
# npx, tsc, vitest, turbo). Each shim sources this file and calls
# `heavy_shim_main <name> "$@"`.
#
# WHAT A SHIM DOES
#
# It sits first on PATH (DorkOS's `runtimes.environment.pathPrepend` puts the
# folder there in every runtime's turn: Claude Code, Codex, OpenCode and Dork).
# It finds the REAL program further down PATH, decides from the real argv
# whether this run is a heavy job, and then:
#
#   * heavy, outside the gate  -> exec bash <this checkout>/scripts/heavy-run-lock.sh
#                                 --job|--tests <real program> <args...>
#   * anything else            -> exec <real program> <args...>
#
# Either way the argv is the caller's, unchanged, and stdin, stdout, stderr and
# the exit code are the real program's (exec, no pipes).
#
# WHY ARGV AND NOT TEXT
#
# .claude/hooks/heavy-command-guard.mjs reads the command TEXT of a Claude Code
# Bash call. It cannot see a heavy command inside a script, a variable or an
# alias, and Codex, OpenCode and Dork run no Claude hooks at all. A program on
# PATH sees the words it was actually started with, from every runtime and every
# script. The RULES are the guard's (what counts as heavy), not its parser; the
# guard stays as a second layer for Claude Code.
#
# WHAT COUNTS AS HEAVY (the guard's rules; see that file's header)
#   - vitest given no test file, a directory, a glob, a name filter, `related`,
#     or more than 3 test files. One to three existing *.test.* / *.spec.* files
#     are light (the targeted run AGENTS.md asks for).
#   - tsc (and vue-tsc, tsgo) in any form but --help, --version, --init,
#     --showConfig, --all.
#   - turbo running build, typecheck, test, lint or e2e.
#   - playwright test (reached through pnpm or npx; there is no playwright shim).
#   - A package manager running a package's own heavy script (build, typecheck,
#     tsc, test*, lint*, e2e, verify, check*): scoped with --filter/-F, -C/--dir,
#     -r/--recursive or --workspace, or run from inside a workspace package.
#   - At a workspace ROOT: in the DorkOS monorepo only `lint` and `lint:fix`
#     (its build, test, typecheck, verify and test:browser join the gate on their
#     own, exactly as the guard allows them). In any OTHER repo every heavy-named
#     root script is heavy: no gate of its own is assumed there.
#   - `pnpm exec|dlx|x <program>`, `pnpm <program>` and `npx <program>` are
#     judged by the program they start.
#   Light: everything else, including `pnpm install` (as the guard allows it).
#
# ANY REPO, ONE GATE
#
# The gate is machine-wide, so a heavy job in any repo goes through it: by the
# absolute path of heavy-run-lock.sh in the checkout these shims live in, never
# through `pnpm heavy` (another repo has no such script, and `pnpm` would be
# this shim again). If that script is missing, the shim says so and runs the
# real program (it never fails closed).
#
# RECURSION (the #1 risk: Nov 25 pnpm fork bomb)
#
# Four independent stops, any one of which ends a loop:
#   1. The gate is handed the REAL program's absolute path, never a bare name,
#      so the gate can never start a shim.
#   2. Whatever runs under the gate gets PATH WITHOUT the shim folder: the gated
#      run, `pnpm heavy …`, a DorkOS root script that joins the gate itself, and
#      any run that already holds a slot. PATH survives turbo's strict env mode,
#      which drops every DORKOS_* variable, so nothing under a gated run re-enters
#      a shim, however deep.
#   3. DORKOS_HEAVY_SLOT_HELD (exported by heavy-run-lock.sh to what it runs,
#      and by scripts/load-gate/turn.ts) or DORKOS_LOAD_GATE_IN_TURN set: pass
#      straight through to the real program.
#   4. DORKOS_HEAVY_SHIM_DEPTH counts shim calls nested inside each other; a
#      fourth level is refused (exit 126) instead of run.
# And a "real" program that resolves (through symlinks) into the shim folder,
# or carries the shim sentinel line, is refused (exit 126) rather than exec'd.
#
# ENVIRONMENT
#   DORKOS_HEAVY_SHIM_LOCK   the gate script to use (tests only; default
#                            <checkout>/scripts/heavy-run-lock.sh)
#   DORKOS_HEAVY_SHIM_DEPTH  set by the shims themselves; not for people
#   CI                       set (and not 0/false): pass straight through
#
# Fixtures: scripts/test-heavy-shims.sh.

HEAVY_SHIM_MAX_DEPTH=3
HEAVY_SHIM_SENTINEL='DORKOS-HEAVY-SHIM'

heavy_shim_say() { printf 'heavy-shim: %s\n' "$*" >&2; }

# The physical directory of a path, following every symlink on the way.
# Prints nothing when it cannot be resolved.
heavy_shim_realpath() {
  local target=$1 link n=0
  while [ -L "$target" ] && [ "$n" -lt 40 ]; do
    link=$(readlink -- "$target") || return 1
    case $link in
      /*) target=$link ;;
      *) target=$(dirname -- "$target")/$link ;;
    esac
    n=$((n + 1))
  done
  [ -L "$target" ] && return 1
  local dir
  dir=$(CDPATH='' cd -P -- "$(dirname -- "$target")" 2>/dev/null && pwd) || return 1
  printf '%s/%s\n' "$dir" "$(basename -- "$target")"
}

# PATH with the shim folder taken out. An entry spelled exactly like it goes at
# once; one that is also named heavy-shims is resolved to its physical path
# (/tmp vs /private/tmp) and goes if it is the same folder. Any other spelling
# (a link with another name) is caught by heavy_shim_find_real's refusal.
heavy_shim_clean_path() {
  local out='' entry phys rest=$PATH
  while :; do
    case $rest in
      *:*)
        entry=${rest%%:*}
        rest=${rest#*:}
        ;;
      *)
        entry=$rest
        rest=''
        ;;
    esac
    if [ -n "$entry" ] && [ "$entry" != "$HEAVY_SHIM_DIR" ]; then
      case ${entry%/} in
        */heavy-shims)
          phys=$(CDPATH='' cd -P -- "$entry" 2>/dev/null && pwd) || phys=$entry
          [ "$phys" = "$HEAVY_SHIM_DIR" ] || out=${out:+$out:}$entry
          ;;
        *) out=${out:+$out:}$entry ;;
      esac
    fi
    [ -z "$rest" ] && break
  done
  printf '%s\n' "$out"
}

# Find the real program on the clean PATH. Exit 127 when there is none, 126
# when the first one found is a shim after all.
heavy_shim_find_real() {
  local name=$1 clean=$2 entry candidate resolved rest
  rest=$clean
  while [ -n "$rest" ]; do
    case $rest in
      *:*)
        entry=${rest%%:*}
        rest=${rest#*:}
        ;;
      *)
        entry=$rest
        rest=''
        ;;
    esac
    [ -n "$entry" ] || continue
    candidate=$entry/$name
    [ -f "$candidate" ] && [ -x "$candidate" ] || continue
    resolved=$(heavy_shim_realpath "$candidate") || resolved=$candidate
    if [ "$(dirname -- "$resolved")" = "$HEAVY_SHIM_DIR" ] ||
      LC_ALL=C head -c 512 -- "$resolved" 2>/dev/null | LC_ALL=C grep -q "$HEAVY_SHIM_SENTINEL"; then
      heavy_shim_say "refusing to run '$name': the next '$name' on PATH ($candidate) is a heavy shim itself ($resolved), so running it would loop. Remove that entry from PATH."
      return 126
    fi
    printf '%s\n' "$candidate"
    return 0
  done
  heavy_shim_say "no real '$name' on PATH (searched PATH without $HEAVY_SHIM_DIR)."
  return 127
}

# ---------------------------------------------------------------------------
# Classification. Each sets HEAVY_SHIM_VERDICT to one of:
#   light  run the real program, PATH unchanged
#   gated  it joins the gate on its own: run it, PATH without the shims
#   job    heavy: through the gate with --job
#   tests  heavy test run: through the gate with --tests
# ---------------------------------------------------------------------------

HEAVY_SHIM_VERDICT=light

heavy_shim_asks_help() {
  local arg
  for arg in "$@"; do
    case $arg in --help | -h | --version | -v | -V) return 0 ;; esac
  done
  return 1
}

heavy_shim_classify_tsc() {
  local arg
  for arg in "$@"; do
    case $arg in
      --help | -h | --version | -v | --init | --showConfig | --all)
        HEAVY_SHIM_VERDICT=light
        return
        ;;
    esac
  done
  HEAVY_SHIM_VERDICT=job
}

heavy_shim_classify_vitest() {
  heavy_shim_asks_help "$@" && {
    HEAVY_SHIM_VERDICT=light
    return
  }
  local arg skip=0 first='' paths=0
  for arg in "$@"; do
    if [ "$skip" = 1 ]; then
      skip=0
      continue
    fi
    case $arg in
      --) continue ;;
      --project | --config | -c | --root | -r | --dir | --reporter | --shard | --testNamePattern | -t | \
        --pool | --environment | --maxWorkers | --minWorkers | --mode | --outputFile | --exclude)
        skip=1
        continue
        ;;
      -*) continue ;;
    esac
    [ -z "$first" ] && first=$arg
    case $arg in run | watch | dev | bench) continue ;; esac
    if [ "$first" = related ]; then
      HEAVY_SHIM_VERDICT=tests
      return
    fi
    # One real test file, named without glob characters: anything else is a
    # filter vitest matches against every file.
    case $arg in *[*?[]* | *'{'* | *'}'* | *']'*)
      HEAVY_SHIM_VERDICT=tests
      return
      ;;
    esac
    if ! [[ $arg =~ \.(test|spec)\.[cm]?[jt]sx?$ ]] || [ ! -f "$arg" ]; then
      HEAVY_SHIM_VERDICT=tests
      return
    fi
    paths=$((paths + 1))
  done
  if [ "$paths" -eq 0 ] || [ "$paths" -gt 3 ]; then
    HEAVY_SHIM_VERDICT=tests
  else
    HEAVY_SHIM_VERDICT=light
  fi
}

heavy_shim_classify_turbo() {
  heavy_shim_asks_help "$@" && {
    HEAVY_SHIM_VERDICT=light
    return
  }
  local arg skip=0 words=() task
  for arg in "$@"; do
    if [ "$skip" = 1 ]; then
      skip=0
      continue
    fi
    case $arg in
      --) break ;;
      --filter | -F) skip=1 ;;
      -*) ;;
      *) words+=("$arg") ;;
    esac
  done
  HEAVY_SHIM_VERDICT=light
  [ "${#words[@]}" -eq 0 ] && return
  local tasks=("${words[0]}")
  [ "${words[0]}" = run ] && tasks=("${words[@]:1}")
  [ "${#tasks[@]}" -eq 0 ] && return
  for task in "${tasks[@]}"; do
    case $task in
      test) HEAVY_SHIM_VERDICT=tests ;;
      build | typecheck | lint | e2e) [ "$HEAVY_SHIM_VERDICT" = tests ] || HEAVY_SHIM_VERDICT=job ;;
    esac
  done
}

# The nearest folder above $PWD holding a package.json, and whether it is a
# workspace root (a pnpm-workspace.yaml beside it, or no workspace above it).
heavy_shim_package_dir() {
  local dir=$PWD
  while :; do
    [ -f "$dir/package.json" ] && {
      printf '%s\n' "$dir"
      return 0
    }
    [ "$dir" = / ] && return 1
    dir=${dir%/*}
    [ -n "$dir" ] || dir=/
  done
}

heavy_shim_workspace_root() {
  local dir=$1
  while :; do
    [ -f "$dir/pnpm-workspace.yaml" ] && {
      printf '%s\n' "$dir"
      return 0
    }
    [ "$dir" = / ] && return 1
    dir=${dir%/*}
    [ -n "$dir" ] || dir=/
  done
}

# Decide a package script. $1 the script, $2 1 when scoped by a flag, $3 1 when
# -w/--workspace-root sends it to the root.
heavy_shim_classify_script() {
  local script=$1 scoped=$2 to_root=$3 pkg root heavy_kind=job
  HEAVY_SHIM_VERDICT=light
  [[ $script =~ ^(build|typecheck|tsc|test|lint|e2e|verify|check)(:.*)?$ ]] || return
  case $script in test | test:*) heavy_kind=tests ;; esac
  if [ "$scoped" = 1 ]; then
    HEAVY_SHIM_VERDICT=$heavy_kind
    return
  fi
  pkg=$(heavy_shim_package_dir) || return
  root=$(heavy_shim_workspace_root "$pkg") || root=$pkg
  [ "$to_root" = 1 ] && pkg=$root
  if [ "$pkg" != "$root" ]; then
    # A workspace package's own copy.
    HEAVY_SHIM_VERDICT=$heavy_kind
    return
  fi
  if grep -q '"name"[[:space:]]*:[[:space:]]*"@dorkos/monorepo"' "$root/package.json" 2>/dev/null; then
    case $script in
      lint | lint:fix) HEAVY_SHIM_VERDICT=job ;;
      build | test | typecheck | verify | test:browser) HEAVY_SHIM_VERDICT=gated ;;
    esac
    return
  fi
  HEAVY_SHIM_VERDICT=$heavy_kind
}

# Decide a package manager's run: scoped flags, then its subcommand.
heavy_shim_classify_pm() {
  local name=$1
  shift
  local args=("$@") n=$# i=0 arg scoped=0 to_root=0 before=1
  for ((i = 0; i < n; i++)); do
    arg=${args[i]}
    [ "$arg" = -- ] && before=0
    [ "$before" = 1 ] || continue
    case $arg in
      -C | --dir | --filter | -F | --cwd | --workspace | -r | --recursive | --workspaces | \
        --dir=* | --filter=* | -F?* | --cwd=* | --workspace=*) scoped=1 ;;
      -w | --workspace-root) [ "$name" = npm ] && scoped=1 || to_root=1 ;;
    esac
  done
  i=0
  while [ "$i" -lt "$n" ]; do
    case ${args[i]} in
      -C | --dir | --filter | -F | --cwd | --workspace) i=$((i + 2)) ;;
      -w) [ "$name" = npm ] && i=$((i + 2)) || i=$((i + 1)) ;;
      -*) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  HEAVY_SHIM_VERDICT=light
  [ "$i" -lt "$n" ] || return
  local sub=${args[i]}
  local rest=("${args[@]:i+1}")
  case $sub in
    heavy) HEAVY_SHIM_VERDICT=gated ;;
    exec | dlx | x)
      local j=0 m=${#rest[@]}
      while [ "$j" -lt "$m" ]; do
        case ${rest[j]} in
          -C | --dir | --filter | -F | --cwd | --workspace | -p | --package) j=$((j + 2)) ;;
          -*) j=$((j + 1)) ;;
          *) break ;;
        esac
      done
      [ "$j" -lt "$m" ] && heavy_shim_classify "$(basename -- "${rest[j]}")" "${rest[@]:j+1}"
      ;;
    vitest | turbo | playwright | tsc | vue-tsc | tsgo)
      heavy_shim_classify "$sub" ${rest[@]+"${rest[@]}"}
      ;;
    run | run-script)
      local j=0 m=${#rest[@]}
      while [ "$j" -lt "$m" ]; do
        case ${rest[j]} in
          -C | --dir | --filter | -F | --cwd | --workspace) j=$((j + 2)) ;;
          -*) j=$((j + 1)) ;;
          *) break ;;
        esac
      done
      [ "$j" -lt "$m" ] && heavy_shim_classify_script "${rest[j]}" "$scoped" "$to_root"
      ;;
    test | t) heavy_shim_classify_script test "$scoped" "$to_root" ;;
    *) heavy_shim_classify_script "$sub" "$scoped" "$to_root" ;;
  esac
}

heavy_shim_classify_npx() {
  local args=("$@") n=$# i=0
  while [ "$i" -lt "$n" ]; do
    case ${args[i]} in
      -p | --package | -c | --call) i=$((i + 2)) ;;
      -*) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  HEAVY_SHIM_VERDICT=light
  [ "$i" -lt "$n" ] && heavy_shim_classify "$(basename -- "${args[i]}")" "${args[@]:i+1}"
}

HEAVY_SHIM_CLASSIFY_DEPTH=0
heavy_shim_classify() {
  local name=$1
  shift
  HEAVY_SHIM_VERDICT=light
  HEAVY_SHIM_CLASSIFY_DEPTH=$((HEAVY_SHIM_CLASSIFY_DEPTH + 1))
  [ "$HEAVY_SHIM_CLASSIFY_DEPTH" -gt 4 ] && return
  case $name in
    vitest) heavy_shim_classify_vitest "$@" ;;
    tsc | vue-tsc | tsgo) heavy_shim_classify_tsc "$@" ;;
    turbo) heavy_shim_classify_turbo "$@" ;;
    playwright)
      local a sub=''
      for a in "$@"; do
        case $a in -*) ;; *)
          sub=$a
          break
          ;;
        esac
      done
      if [ "$sub" = test ] && ! heavy_shim_asks_help "$@"; then HEAVY_SHIM_VERDICT=tests; fi
      ;;
    npx | pnpx | bunx) heavy_shim_classify_npx "$@" ;;
    pnpm | npm | yarn | bun) heavy_shim_classify_pm "$name" "$@" ;;
  esac
}

# ---------------------------------------------------------------------------

heavy_shim_main() {
  local name=$1
  shift

  local depth=${DORKOS_HEAVY_SHIM_DEPTH:-0}
  case $depth in '' | *[!0-9]*) depth=0 ;; esac
  if [ "$depth" -ge "$HEAVY_SHIM_MAX_DEPTH" ]; then
    heavy_shim_say "refusing to run '$name': heavy shims are already nested $depth deep (DORKOS_HEAVY_SHIM_DEPTH), which looks like a loop. Nothing ran."
    exit 126
  fi
  export DORKOS_HEAVY_SHIM_DEPTH=$((depth + 1))

  local clean real status
  clean=$(heavy_shim_clean_path)
  real=$(heavy_shim_find_real "$name" "$clean")
  status=$?
  [ "$status" = 0 ] || exit "$status"

  # Already inside the gate: straight through, and no shim below this.
  if [ -n "${DORKOS_HEAVY_SLOT_HELD:-}" ] || [ -n "${DORKOS_LOAD_GATE_IN_TURN:-}" ]; then
    PATH=$clean exec "$real" "$@"
  fi
  # CI runs one job per machine; the gate itself would run uncapped there.
  case ${CI:-} in '' | 0 | false) ;; *) exec "$real" "$@" ;; esac

  heavy_shim_classify "$name" "$@"
  case $HEAVY_SHIM_VERDICT in
    light) exec "$real" "$@" ;;
    gated) PATH=$clean exec "$real" "$@" ;;
  esac

  local lock=${DORKOS_HEAVY_SHIM_LOCK:-$HEAVY_SHIM_DIR/../heavy-run-lock.sh}
  if [ ! -f "$lock" ]; then
    heavy_shim_say "no gate at $lock, so '$name' runs without waiting its turn."
    exec "$real" "$@"
  fi
  PATH=$clean exec bash "$lock" "--$HEAVY_SHIM_VERDICT" "$real" "$@"
}
