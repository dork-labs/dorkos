#!/usr/bin/env bash
# Fixture suite for .claude/hooks/format-changed.sh, the `Stop` hook that formats
# everything the working tree changed, once per turn.
#
# WHY THIS SUITE EXISTS
#
# The hook was a 13-line PostToolUse one-liner (`prettier --write $file`) that
# needed no test, because there was nothing in it to get wrong. It is now ~126
# lines that collect three git file lists, subtract deletions, filter by
# extension, drop paths that no longer exist, and only then call prettier. The
# automated PR reviewer flagged exactly that on the rewrite PR — "the rewritten
# hook (13 to 126 lines, real file-collection/filter logic) has no fixture test,
# unlike sibling hooks of similar complexity (git-guard, process-guard)" — and it
# was right. Every branch below is one an operator would never notice breaking,
# because this hook is silent by design and its work is invisible when it does
# not happen.
#
# The rewrite's own rationale is in the hook's header and in two reports:
# `research/20260320_prettier_formatting_ai_agents.md` (the per-edit pattern this
# repo used to run) and `research/20260824_agent_post_edit_formatting_stale_context.md`
# (the reproduced staleness failure that moved it to `Stop`). Neither is pinned
# here — this suite pins the resulting behavior, not the reasoning.
#
# EXIT 0 IS THE PROPERTY THAT MATTERS MOST, so every case asserts it. From a
# `Stop` hook, exit 2 blocks the turn from ending and any other non-zero shows
# the operator an error. This is a cosmetic pass backstopped twice downstream
# (lefthook pre-commit `prettier --write` with `stage_fixed: true`, and CI
# `prettier --check .` inside the required `typecheck` workflow), so failing
# loudly is strictly worse than not running at all.
#
#   bash scripts/test-format-changed.sh
#   HOOK=/path/to/other.sh bash scripts/test-format-changed.sh
#
# HOOK exists so a neutered or candidate implementation can be run against the
# same fixtures to show what it gets wrong — that is how cases (c) and (g) were
# shown to actually fail rather than merely to pass.
#
# Hermetic: every case builds a throwaway git repository under a temp dir, so
# the suite never touches this repo's tracked files. Git identity and config are
# neutered so a developer's own git config cannot change what a case measures.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
hook=${HOOK:-$repo_root/.claude/hooks/format-changed.sh}

# THE FIXTURE PRETTIER IS THE REAL ONE, WRAPPED. Two things need proving and a
# stub can only prove one of them: that eligible files come out actually
# formatted (needs a real formatter), and that ineligible ones are never handed
# over at all (needs a record of the call). So each fixture repo gets a
# `node_modules/.bin/prettier` that appends its argv to a log and then execs this
# checkout's real prettier.
#
# It has to be a wrapper and not a symlink. pnpm's `.bin/prettier` is a POSIX sh
# shim that derives `basedir` from `$0` and reaches for `$basedir/../.pnpm/...`;
# link it into a fixture repo and `$0` becomes the fixture path, so prettier
# cannot resolve its own package. Exec'ing the shim by its absolute path keeps
# `$0` correct and it resolves normally.
real_prettier=$repo_root/node_modules/.bin/prettier

# Say so once, clearly, instead of letting nine cases fail for one reason. This
# is why the suite runs in scripts-test.yml's `harness` job (which installs) and
# not `fixtures` (which deliberately does not) — same placement, and the same
# reason, as test-homedir-guard.sh.
if [ ! -x "$real_prettier" ]; then
  printf 'format-changed fixtures: no prettier at %s — run `pnpm install` first.\n' \
    "$real_prettier" >&2
  exit 1
fi

work_dir=$(mktemp -d -t format-changed.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/logs"

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid

pass=0
fail=0

# check <name> <mode> <expected> <actual>
#   mode eq    — exact string match (exit codes, file contents, expected-empty output)
#   mode has   — actual must contain expected as a substring
#   mode lacks — actual must NOT contain expected as a substring
check() {
  local name=$1 mode=$2 expected=$3 actual=$4
  case "$mode" in
    eq)
      if [ "$expected" = "$actual" ]; then
        pass=$((pass + 1))
      else
        fail=$((fail + 1))
        printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$name" "$expected" "$actual" >&2
      fi
      ;;
    has)
      if printf '%s' "$actual" | grep -qF "$expected"; then
        pass=$((pass + 1))
      else
        fail=$((fail + 1))
        printf 'FAIL  %s\n        expected to contain: %s\n        actual:\n%s\n' "$name" "$expected" "$actual" >&2
      fi
      ;;
    lacks)
      if printf '%s' "$actual" | grep -qF "$expected"; then
        fail=$((fail + 1))
        printf 'FAIL  %s\n        expected to NOT contain: %s\n        actual:\n%s\n' "$name" "$expected" "$actual" >&2
      else
        pass=$((pass + 1))
      fi
      ;;
  esac
}

# Deliberately ugly inputs whose formatted forms are unambiguous under prettier's
# defaults, so no fixture .prettierrc is needed and no assertion depends on this
# repo's own options.
UGLY_TS='const   x=1'
TIDY_TS='const x = 1;'
UGLY_MD='#  Heading


some   text'
TIDY_MD='# Heading

some text'

# init_repo <case-name> -> echoes the repo path
#
# The committed .gitignore is not decoration: without it the fixture's own
# node_modules/ shows up in `git ls-files --others --exclude-standard` and case
# (b) has no clean tree to test.
init_repo() {
  local repo=$work_dir/$1
  mkdir -p "$repo"
  (
    cd "$repo" || exit 1
    git init -q -b main .
    printf '# fixture\n' >README.md
    printf 'node_modules/\n' >.gitignore
    git add -A
    git commit -qm base
  ) >/dev/null 2>&1
  echo "$repo"
}

# install_prettier <case-name> — give the fixture repo a recording prettier.
# Omit this call to fixture the "no node_modules" path.
install_prettier() {
  local repo=$work_dir/$1 log=$work_dir/logs/$1.log
  mkdir -p "$repo/node_modules/.bin"
  cat >"$repo/node_modules/.bin/prettier" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" >>"$log"
exec "$real_prettier" "\$@"
EOF
  chmod +x "$repo/node_modules/.bin/prettier"
}

# Everything the recording prettier was called with, across every invocation.
# Empty (not missing) is the assertion for "prettier was never called": the
# wrapper writes its log before exec'ing, so a call with zero file arguments
# still leaves the flags behind.
invocations() {
  cat "$work_dir/logs/$1.log" 2>/dev/null
}

# Run the real hook entry point from inside $1, recording stdout+stderr and exit
# status in the globals sut_out/sut_status. stdin is closed because a Stop hook
# gets a JSON payload it does not read, and a suite that hangs waiting on a tty
# is a suite nobody runs.
run_sut() {
  local repo=$work_dir/$1
  sut_out=$(cd "$repo" && bash "$hook" </dev/null 2>&1)
  sut_status=$?
}

# --- (a) The happy path: eligible changed files come out formatted. ----------
case_a() {
  local repo
  repo=$(init_repo case-a)
  install_prettier case-a
  (
    cd "$repo" || exit 1
    mkdir -p src
    printf 'export {};\n' >src/a.ts
    printf '# seed\n' >notes.md
    git add -A
    git commit -qm 'seed: formatted placeholders'
    # Dirty them so they are UNSTAGED changes — the `git diff` half. The seed
    # commit holds DIFFERENT content on purpose: rewriting a file with the bytes
    # it already has produces no diff, and the case would then assert nothing.
    printf '%s\n' "$UGLY_TS" >src/a.ts
    printf 'const   y=2\n' >>src/a.ts
    printf '%s\n' "$UGLY_MD" >notes.md
  ) >/dev/null 2>&1

  run_sut case-a
  check "a: exit 0" eq 0 "$sut_status"
  check "a: silent on success" eq "" "$sut_out"
  check "a: .ts formatted" eq "$TIDY_TS
const y = 2;" "$(cat "$repo/src/a.ts")"
  check "a: .md formatted" eq "$TIDY_MD" "$(cat "$repo/notes.md")"
  check "a: prettier got both files" has "src/a.ts" "$(invocations case-a)"
  check "a: prettier got the markdown too" has "notes.md" "$(invocations case-a)"
}

# --- (b) A clean tree is a true no-op. ---------------------------------------
# Not just "exit 0": prettier must not run at all, and the tree must be byte
# identical afterwards. A hook that reformats the whole checkout on every turn
# would still exit 0 and still be silent.
case_b() {
  local repo before after
  repo=$(init_repo case-b)
  install_prettier case-b
  (
    cd "$repo" || exit 1
    mkdir -p src
    printf '%s\n' "$UGLY_TS" >src/committed.ts
    git add -A
    git commit -qm 'seed: an unformatted but COMMITTED file'
  ) >/dev/null 2>&1

  before=$(cat "$repo/src/committed.ts")
  run_sut case-b
  after=$(cat "$repo/src/committed.ts")

  check "b: exit 0" eq 0 "$sut_status"
  check "b: no output" eq "" "$sut_out"
  check "b: prettier never invoked" eq "" "$(invocations case-b)"
  check "b: committed file untouched" eq "$before" "$after"
  check "b: tree still clean" eq "" "$(cd "$repo" && git status --porcelain)"
}

# --- (c) Changes exist, but none are eligible. -------------------------------
# THE case most likely to regress, because it is the empty-array path. Line ~119
# of the hook (`[ ${#FILES[@]} -gt 0 ] || exit 0`) is the only thing standing
# between this and calling prettier with no file arguments — which on bash 5
# makes prettier exit non-zero into /dev/null, and on bash 3.2 (macOS) trips
# `set -u` on the empty array expansion and takes the whole hook down with it.
# Asserting the log is empty catches both; asserting only the exit code would
# miss the first.
case_c() {
  local repo png_before txt_before
  repo=$(init_repo case-c)
  install_prettier case-c
  (
    cd "$repo" || exit 1
    mkdir -p assets
    # A real-enough PNG header, plus a .txt — neither extension is in EXT_RE.
    printf '\211PNG\r\n\032\n' >assets/logo.png
    printf 'plain   text   file\n' >notes.txt
    git add -A
    git commit -qm 'seed: ineligible files'
    printf '\211PNG\r\n\032\nchanged' >assets/logo.png
    printf 'plain   text   file   edited\n' >notes.txt
  ) >/dev/null 2>&1

  # cksum rather than a content compare: the .png is binary, and cksum is the
  # one checksum tool that is present and spelled the same on macOS and CI.
  png_before=$(cksum <"$repo/assets/logo.png")
  txt_before=$(cat "$repo/notes.txt")
  run_sut case-c

  check "c: exit 0" eq 0 "$sut_status"
  check "c: no output" eq "" "$sut_out"
  check "c: prettier never invoked" eq "" "$(invocations case-c)"
  check "c: .png untouched" eq "$png_before" "$(cksum <"$repo/assets/logo.png")"
  check "c: .txt untouched" eq "$txt_before" "$(cat "$repo/notes.txt")"
}

# --- (d) No prettier installed: fail open, silently. -------------------------
# A fresh worktree with no `pnpm install` yet is the everyday version of this.
case_d() {
  local repo
  repo=$(init_repo case-d)
  # Deliberately no install_prettier.
  (
    cd "$repo" || exit 1
    mkdir -p src
    printf '%s\n' "$UGLY_TS" >src/a.ts
  ) >/dev/null 2>&1

  run_sut case-d
  check "d: exit 0 with no node_modules" eq 0 "$sut_status"
  check "d: no output" eq "" "$sut_out"
  check "d: file left exactly as written" eq "$UGLY_TS" "$(cat "$repo/src/a.ts")"
}

# --- (e) Outside a git repository: fail open, silently. ----------------------
case_e() {
  local outside=$work_dir/not-a-repo out status toplevel
  mkdir -p "$outside"
  printf '%s\n' "$UGLY_TS" >"$outside/a.ts"

  # Precondition, asserted rather than assumed: if the temp dir were somehow
  # inside a repository this case would pass for the wrong reason.
  toplevel=$(cd "$outside" && git rev-parse --show-toplevel 2>/dev/null)
  check "e: fixture really is outside a repo" eq "" "$toplevel"

  out=$(cd "$outside" && bash "$hook" </dev/null 2>&1)
  status=$?
  check "e: exit 0 outside a repo" eq 0 "$status"
  check "e: no output" eq "" "$out"
  check "e: file left exactly as written" eq "$UGLY_TS" "$(cat "$outside/a.ts")"
}

# --- (f) .prettierignore is honored. -----------------------------------------
# The hook does no ignore-matching of its own — it hands ignored paths to
# prettier and relies on prettier skipping them. That delegation is the thing
# under test: it only holds while the hook keeps running from the repo root,
# where prettier finds ./.prettierignore.
case_f() {
  local repo
  repo=$(init_repo case-f)
  install_prettier case-f
  (
    cd "$repo" || exit 1
    mkdir -p src vendor
    printf 'vendor/\n' >.prettierignore
    printf '%s\n' "$UGLY_TS" >src/a.ts
    printf '%s\n' "$UGLY_TS" >vendor/lib.ts
    git add -A
    git commit -qm 'seed'
    printf '%s\n' "$UGLY_TS" >src/a.ts
    printf 'const   z=3\n' >>src/a.ts
    printf '%s\n' "$UGLY_TS" >vendor/lib.ts
    printf 'const   z=3\n' >>vendor/lib.ts
  ) >/dev/null 2>&1

  run_sut case-f
  check "f: exit 0" eq 0 "$sut_status"
  check "f: no output" eq "" "$sut_out"
  check "f: non-ignored file formatted" eq "$TIDY_TS
const z = 3;" "$(cat "$repo/src/a.ts")"
  check "f: ignored file untouched" eq "$UGLY_TS
const   z=3" "$(cat "$repo/vendor/lib.ts")"
}

# --- (g) Deletions do not break it. ------------------------------------------
# Both flavors: an unstaged `rm` and a staged `git rm`. Neither subtraction is
# observable from the exit code — prettier's complaint about a missing path goes
# to /dev/null and the hook exits 0 regardless — so the invocation log is what
# makes this case able to fail at all: a deleted path must never reach prettier.
#
# The hook subtracts deletions twice, and only one of the two is load-bearing.
# Deleting `--diff-filter=d` alone leaves this case GREEN, because the later
# `[ -f "$file" ]` still drops every path that no longer exists; deleting that
# existence guard turns it red immediately. Both were measured. `--diff-filter=d`
# is real belt-and-braces rather than dead code — it keeps a renamed-away or
# case-changed path out of the list before the filesystem is consulted — but no
# honest fixture can pin it while the `-f` guard stands behind it, and a fixture
# that pretends otherwise (grepping the hook's source for the flag) would pin the
# spelling, not the behavior.
case_g() {
  local repo
  repo=$(init_repo case-g)
  install_prettier case-g
  (
    cd "$repo" || exit 1
    mkdir -p src
    printf '%s\n' "$UGLY_TS" >src/keep.ts
    printf '%s\n' "$UGLY_TS" >src/gone-unstaged.ts
    printf '%s\n' "$UGLY_TS" >src/gone-staged.ts
    git add -A
    git commit -qm 'seed: three files'
    printf '%s\n' "$UGLY_TS" >src/keep.ts
    printf 'const   w=4\n' >>src/keep.ts
    rm src/gone-unstaged.ts
    git rm -q src/gone-staged.ts
  ) >/dev/null 2>&1

  run_sut case-g
  check "g: exit 0 with deletions in the diff" eq 0 "$sut_status"
  check "g: no output" eq "" "$sut_out"
  check "g: surviving file still formatted" eq "$TIDY_TS
const w = 4;" "$(cat "$repo/src/keep.ts")"
  check "g: unstaged deletion never handed to prettier" lacks \
    "src/gone-unstaged.ts" "$(invocations case-g)"
  check "g: staged deletion never handed to prettier" lacks \
    "src/gone-staged.ts" "$(invocations case-g)"
}

# --- (h) Staged and untracked files are collected, not just unstaged ones. ---
# Three lists feed CHANGED; (a) covers `git diff`, this covers the other two.
# Dropping either one is silent — the tree just quietly stops being formatted
# for whichever half of a turn's work happens to be staged.
case_h() {
  local repo
  repo=$(init_repo case-h)
  install_prettier case-h
  (
    cd "$repo" || exit 1
    mkdir -p src
    printf '%s\n' "$UGLY_TS" >src/staged.ts
    git add src/staged.ts
    # Never added, never ignored — the `git ls-files --others` half.
    printf '%s\n' "$UGLY_MD" >untracked.md
  ) >/dev/null 2>&1

  run_sut case-h
  check "h: exit 0" eq 0 "$sut_status"
  check "h: no output" eq "" "$sut_out"
  check "h: staged file formatted" eq "$TIDY_TS" "$(cat "$repo/src/staged.ts")"
  check "h: untracked file formatted" eq "$TIDY_MD" "$(cat "$repo/untracked.md")"
}

case_a
case_b
case_c
case_d
case_e
case_f
case_g
case_h

printf '\nformat-changed fixtures: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
