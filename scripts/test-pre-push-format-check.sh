#!/usr/bin/env bash
# Fixture suite for scripts/pre-push-format-check.sh, the pre-push gate that
# refuses a push whose changed files are not Prettier-formatted (DOR-1839).
#
#   bash scripts/test-pre-push-format-check.sh
#   SCRIPT=/path/to/candidate.sh bash scripts/test-pre-push-format-check.sh
#
# SCRIPT exists so a neutered or candidate implementation can be run against the
# same fixtures to show what it gets wrong — that is how the `--ignore-unknown`,
# `--diff-filter` and base-pinning cases below were shown to actually FAIL rather
# than merely to pass.
#
# WHY THIS SUITE EXISTS
#
# The gate has exactly two ways to be wrong and both end the same way. Too slack
# — a base that resolves to nothing, a changed set that silently comes back empty
# — and it passes everything forever while reporting a green step, which is the
# state DOR-1839 was opened about with a nicer log. Too eager — a deleted path
# handed to prettier, a `.sh` file with no parser, an unrelated stale ref
# sweeping in other people's commits — and it refuses honest pushes, which does
# not get investigated, it gets answered with `git push --no-verify`, and then
# the gate protects nothing at all. Neither failure announces itself.
#
# So every case below asserts the EXIT CODE and, where "did it even look?" is
# the question, the recorded prettier invocations. A gate that exits 0 having
# checked nothing and a gate that exits 0 having checked everything are
# indistinguishable from the outside, and the log is the only thing that tells
# them apart.
#
# Hermetic: every case builds a throwaway git repository under a temp dir, so
# the suite never touches this repo's tracked files or its real origin/main. Git
# identity and config are neutered so a developer's own git config cannot change
# what a case measures.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script=${SCRIPT:-$repo_root/scripts/pre-push-format-check.sh}

# THE FIXTURE PRETTIER IS THE REAL ONE, WRAPPED — same device, and the same
# justification, as scripts/test-format-changed.sh. Two things need proving and a
# stub can only prove one: that unformatted files are really detected (needs a
# real formatter and this repo's real prettier version), and that ineligible
# paths are never handed over at all (needs a record of the call). So each
# fixture repo gets a `node_modules/.bin/prettier` that appends its argv to a log
# and then execs this checkout's real prettier.
#
# It has to be a wrapper and not a symlink: pnpm's `.bin/prettier` is a POSIX sh
# shim that derives `basedir` from `$0`, so a link into a fixture repo leaves
# prettier unable to resolve its own package. Exec'ing the shim by its absolute
# path keeps `$0` correct.
#
# It is also why the script under test invokes `node_modules/.bin/prettier`
# directly rather than `pnpm exec prettier`: `pnpm exec` in a fixture repo with
# no package.json resolves nothing, so the "prettier was never invoked" cases
# would be untestable.
real_prettier=$repo_root/node_modules/.bin/prettier

# Say so once, clearly, instead of letting a dozen cases fail for one reason.
# This is why the suite runs in scripts-test.yml's `harness` job (which installs)
# and not `fixtures` (which deliberately does not) — same placement, and the same
# reason, as test-format-changed.sh and test-homedir-guard.sh.
if [ ! -x "$real_prettier" ]; then
  printf 'pre-push-format fixtures: no prettier at %s — run `pnpm install` first.\n' \
    "$real_prettier" >&2
  exit 1
fi

work_dir=$(mktemp -d -t prepush-format-check.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/logs"

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid

pass=0
fail=0

# check <name> <mode> <expected> <actual>
#   mode eq    — exact string match (exit codes, expected-empty output)
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
        printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' \
          "$name" "$expected" "$actual" >&2
      fi
      ;;
    has)
      if printf '%s' "$actual" | grep -qF "$expected"; then
        pass=$((pass + 1))
      else
        fail=$((fail + 1))
        printf 'FAIL  %s\n        expected to contain: %s\n        actual:\n%s\n' \
          "$name" "$expected" "$actual" >&2
      fi
      ;;
    lacks)
      if printf '%s' "$actual" | grep -qF "$expected"; then
        fail=$((fail + 1))
        printf 'FAIL  %s\n        expected to NOT contain: %s\n        actual:\n%s\n' \
          "$name" "$expected" "$actual" >&2
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

# init_repo <case-name> -> echoes the repo path
#
# The repo starts on `work`, with `refs/remotes/origin/main` planted at the base
# commit by `git update-ref`. That is what makes the fixture hermetic AND
# faithful: the script resolves `origin/main`, and a real remote is neither
# needed nor wanted for a suite that must never talk to the network.
#
# There is deliberately NO local `main` branch. The base-resolution cases below
# create one when they need to prove which of the two the script picks.
init_repo() {
  local repo=$work_dir/$1
  mkdir -p "$repo"
  (
    cd "$repo" || exit 1
    git init -q -b work .
    printf 'node_modules/\n' >.gitignore
    printf '# fixture\n' >README.md
    git add -A
    git commit -qm base
    git update-ref refs/remotes/origin/main HEAD
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
# wrapper writes its log before exec'ing, so even a call with zero file
# arguments leaves its flags behind.
invocations() {
  cat "$work_dir/logs/$1.log" 2>/dev/null
}

# Run the script under test from inside the fixture repo, recording combined
# output and exit status in the globals sut_out/sut_status. stdin is closed
# because the command declares no `use_stdin` in lefthook.yml and a suite that
# hangs waiting on a tty is a suite nobody runs.
run_sut() {
  local repo=$work_dir/$1
  sut_out=$(cd "$repo" && bash "$script" </dev/null 2>&1)
  sut_status=$?
}

# --- (a) The whole point: an unformatted committed file refuses the push. -----
# Also the only case that pins the MESSAGE, because the message is the feature.
# A refusal that does not name the file and the exact command is a refusal
# somebody answers with --no-verify.
case_a() {
  local repo
  repo=$(init_repo case-a)
  install_prettier case-a
  (
    cd "$repo" || exit 1
    mkdir -p src
    printf '%s\n' "$UGLY_TS" >src/bad.ts
    git add -A
    git commit -qm 'an unformatted file, committed'
  ) >/dev/null 2>&1

  run_sut case-a
  check "a: refuses the push" eq 1 "$sut_status"
  check "a: names the offending file" has "src/bad.ts" "$sut_out"
  check "a: prints the exact fix command" has \
    "pnpm exec prettier --write src/bad.ts" "$sut_out"
  check "a: says why it matters" has "prettier --check ." "$sut_out"
  check "a: files it under the push, not the working tree" has "In this push" "$sut_out"
  check "a: tells you to commit the fix" has "commit the fixes that belong to this push" "$sut_out"
  check "a: leaves the file alone (check, never write)" eq \
    "$UGLY_TS" "$(cat "$repo/src/bad.ts")"
}

# --- (b) A formatted changed set passes, silently. ---------------------------
case_b() {
  local repo
  repo=$(init_repo case-b)
  install_prettier case-b
  (
    cd "$repo" || exit 1
    mkdir -p src
    printf '%s\n' "$TIDY_TS" >src/good.ts
    printf '# Heading\n' >notes.md
    git add -A
    git commit -qm 'formatted files'
  ) >/dev/null 2>&1

  run_sut case-b
  check "b: passes" eq 0 "$sut_status"
  check "b: silent on success" eq "" "$sut_out"
  check "b: actually looked at the file" has "src/good.ts" "$(invocations case-b)"
}

# --- (c) An empty changed set is an instant pass that never calls prettier. ---
# THE case most likely to regress, because it is the empty-array path. Prettier
# with zero file arguments is an error, and on bash 3.2 (macOS) the expansion of
# an empty array under `set -u` takes the script down before prettier is even
# reached. Asserting the log is empty catches both; asserting only the exit code
# would miss neither loudly enough to be sure.
case_c() {
  local repo
  repo=$(init_repo case-c)
  install_prettier case-c

  run_sut case-c
  check "c: passes with nothing changed" eq 0 "$sut_status"
  check "c: no output" eq "" "$sut_out"
  check "c: prettier never invoked" eq "" "$(invocations case-c)"
}

# --- (d) Deletions do not break it. ------------------------------------------
# A deleted path handed to prettier exits non-zero and refuses an honest push.
#
# THE SEEDING IS THE WHOLE CASE. `src/gone.ts` is committed and origin/main is
# moved onto that commit BEFORE it is deleted, so the deletion is a real `D`
# entry in `merge-base..worktree`. An earlier version of this case created and
# deleted the file after the base was planted, which nets out of the diff
# entirely — the case had no subject and passed against a script with both
# deletion guards removed (measured: 48/48 green). Seeded this way it fails, and
# `src/keep.ts` changing after the base is what keeps prettier running at all so
# the invocation log has something to be checked against.
#
# WHAT THIS PINS AND WHAT IT CANNOT. The script excludes deletions twice — with
# `--diff-filter=ACMRT` and again with the `[ -f "$file" ]` test — and neither is
# individually attributable, because each alone still drops a path that is gone.
# Measured against this corrected fixture: removing BOTH turns the case red;
# removing either one leaves it green. So it pins the OUTCOME (a deleted path
# never reaches prettier) and not the mechanism. The filter is real
# belt-and-braces rather than dead code — it keeps a renamed-away or case-changed
# path out of the list before the filesystem is consulted at all, which on a
# case-insensitive filesystem the `-f` test cannot do — but no honest fixture can
# separate the two while both stand.
case_d() {
  local repo
  repo=$(init_repo case-d)
  install_prettier case-d
  (
    cd "$repo" || exit 1
    mkdir -p src
    printf '%s\n' "$TIDY_TS" >src/keep.ts
    printf '%s\n' "$TIDY_TS" >src/gone.ts
    git add -A
    git commit -qm 'two files, both already on origin/main'
    git update-ref refs/remotes/origin/main HEAD
    printf '%s\n' "$TIDY_TS" >>src/keep.ts
    git rm -q src/gone.ts
    git add -A
    git commit -qm 'remove one, touch the other'
  ) >/dev/null 2>&1

  run_sut case-d
  check "d: passes with a deletion in the diff" eq 0 "$sut_status"
  check "d: no output" eq "" "$sut_out"
  check "d: surviving file was checked" has "src/keep.ts" "$(invocations case-d)"
  check "d: deleted path never handed to prettier" lacks \
    "src/gone.ts" "$(invocations case-d)"
}

# --- (e) Renames report their destination, not their source. -----------------
# `--name-only` gives one path for a rename and it is the NEW one; the old path
# no longer exists, so handing it over would be case (d) again by another route.
# Seeded the same way and for the same reason: a file created and renamed after
# the base was planted appears in the diff as a plain addition of the new name,
# with no source path to get wrong.
#
# Git's rename detection means this case cannot attribute anything to
# `--diff-filter` either — a detected rename yields the destination path with or
# without it. It pins the outcome, which is what matters, and the deletion in
# case (d) is where the filter's absence is felt.
case_e() {
  local repo
  repo=$(init_repo case-e)
  install_prettier case-e
  (
    cd "$repo" || exit 1
    mkdir -p src
    printf '%s\n' "$TIDY_TS" >src/old-name.ts
    git add -A
    git commit -qm 'seed, already on origin/main'
    git update-ref refs/remotes/origin/main HEAD
    git mv src/old-name.ts src/new-name.ts
    git commit -qm rename
  ) >/dev/null 2>&1

  run_sut case-e
  check "e: passes across a rename" eq 0 "$sut_status"
  check "e: no output" eq "" "$sut_out"
  check "e: destination path was checked" has "src/new-name.ts" "$(invocations case-e)"
  check "e: source path never handed to prettier" lacks \
    "src/old-name.ts" "$(invocations case-e)"
}

# --- (f) .prettierignore is honored, including for an ignore-only push. -------
# The script does no ignore-matching of its own — it hands ignored paths to
# prettier and relies on prettier skipping them. That delegation is the thing
# under test, and it is what makes `pnpm-lock.yaml` (DOR-1715) free: prettier
# drops an ignored path before it loads a parser.
case_f() {
  local repo
  repo=$(init_repo case-f)
  install_prettier case-f
  (
    cd "$repo" || exit 1
    printf 'vendor/\n' >.prettierignore
    mkdir -p vendor
    printf '%s\n' "$UGLY_TS" >vendor/lib.ts
    git add -A
    git commit -qm 'an unformatted but IGNORED file'
  ) >/dev/null 2>&1

  run_sut case-f
  check "f: ignored-only push passes" eq 0 "$sut_status"
  check "f: no output" eq "" "$sut_out"
  check "f: the ignored path was still offered to prettier" has \
    "vendor/lib.ts" "$(invocations case-f)"
  check "f: ignored file untouched" eq "$UGLY_TS" "$(cat "$repo/vendor/lib.ts")"
}

# --- (g) Files prettier has no parser for do not refuse the push. ------------
# Without `--ignore-unknown` prettier exits 2 on these ("No parser could be
# inferred") and the script refuses — so a push containing a shell script or a
# PNG, which is most pushes, would be blocked outright. Measured: dropping the
# flag turns this case red.
case_g() {
  local repo
  repo=$(init_repo case-g)
  install_prettier case-g
  (
    cd "$repo" || exit 1
    mkdir -p bin assets
    printf '#!/bin/sh\nif [ 1 ];then echo   hi;fi\n' >bin/tool.sh
    printf '\211PNG\r\n\032\n' >assets/logo.png
    printf 'LICENSE text\n' >NOTICE
    git add -A
    git commit -qm 'files with no prettier parser'
  ) >/dev/null 2>&1

  run_sut case-g
  check "g: unparseable-by-prettier files pass" eq 0 "$sut_status"
  check "g: no output" eq "" "$sut_out"
  check "g: they were offered to prettier, which skipped them" has \
    "bin/tool.sh" "$(invocations case-g)"
}

# --- (h) No node_modules: refuse, naming `pnpm install`. ---------------------
# The fresh-worktree trap. The whole pre-push hook already dies in this state
# (turbo is missing too), but this step now runs FIRST, so its message is the one
# the operator reads. Fail-closed on purpose: "we could not check" is not "there
# is nothing to check".
case_h() {
  local repo
  repo=$(init_repo case-h)
  # Deliberately no install_prettier.
  (
    cd "$repo" || exit 1
    printf '%s\n' "$UGLY_TS" >bad.ts
    git add -A
    git commit -qm 'unformatted, and nothing to check it with'
  ) >/dev/null 2>&1

  run_sut case-h
  check "h: refuses with no node_modules" eq 1 "$sut_status"
  check "h: names the fix" has "pnpm install" "$sut_out"
  check "h: does not pretend the file was checked" lacks \
    "not Prettier-formatted" "$sut_out"
}

# --- (i) Uncommitted work counts as changed. ---------------------------------
# The changed set is merge-base..WORKING TREE, not merge-base..HEAD, because
# prettier reads bytes on disk: a set defined over commits would hand prettier
# working-tree content while claiming to describe something else. Both flavours
# of "not committed" are covered — an unstaged edit to a tracked file, and a
# staged-but-uncommitted new one.
#
# `tracked.ts` is committed and origin/main is moved onto that commit, so HEAD
# equals the merge base and NOTHING is in the committed diff — the entire changed
# set is working-tree state. Seeding it any other way would leave `tracked.ts` in
# the commit range too, and the case would still pass against a script that only
# ever looked at commits. Measured: with the endpoint changed to `HEAD`, this
# case goes red; with `tracked.ts` committed on the branch instead, it does not.
case_i() {
  local repo
  repo=$(init_repo case-i)
  install_prettier case-i
  (
    cd "$repo" || exit 1
    printf '%s\n' "$TIDY_TS" >tracked.ts
    git add -A
    git commit -qm 'formatted, and already on origin/main'
    git update-ref refs/remotes/origin/main HEAD
    printf '%s\n' "$UGLY_TS" >tracked.ts
    printf '%s\n' "$UGLY_TS" >staged.ts
    git add staged.ts
  ) >/dev/null 2>&1

  run_sut case-i
  check "i: refuses over uncommitted work" eq 1 "$sut_status"
  check "i: names the unstaged edit" has "tracked.ts" "$sut_out"
  check "i: names the staged addition" has "staged.ts" "$sut_out"
  # The half the first version of this script got wrong: neither file is in the
  # push, so claiming they are — or that CI is about to fail over them, or that
  # committing them is the fix — would be three false statements about somebody's
  # work in progress.
  check "i: files them as working-tree state" has "Uncommitted in your working tree" "$sut_out"
  check "i: never claims they are in the push" lacks "In this push" "$sut_out"
  check "i: does not advise committing work in progress" lacks \
    "commit the fixes that belong to this push" "$sut_out"
  check "i: says so outright" has "Nothing needs committing" "$sut_out"
}

# --- (j) Untracked files are NOT in the set. ---------------------------------
# The deliberate difference from the Stop hook's set. An untracked file is in no
# push and reaches no CI, so refusing over one is a toll rather than a gate.
case_j() {
  local repo
  repo=$(init_repo case-j)
  install_prettier case-j
  (
    cd "$repo" || exit 1
    printf '%s\n' "$UGLY_TS" >scratch.ts
  ) >/dev/null 2>&1

  run_sut case-j
  check "j: an untracked unformatted file passes" eq 0 "$sut_status"
  check "j: no output" eq "" "$sut_out"
  check "j: prettier never invoked" eq "" "$(invocations case-j)"
}

# --- (k) The base is origin/main, not the local `main` branch. ---------------
# The pin DOR-833/DOR-1717 exist for, tested from the direction that matters: a
# local `main` left behind by a machine that never pulls makes the diff sweep in
# commits the pusher never wrote. Here that stale span contains an unformatted
# file, so a script diffing against local `main` refuses a push it has no
# business refusing. Measured: swapping the base expression for a bare `main`
# turns this case red.
case_k() {
  local repo
  repo=$(init_repo case-k)
  install_prettier case-k
  (
    cd "$repo" || exit 1
    # A stale local `main`, left at the base commit.
    git branch main
    # Somebody else's merge, already on origin/main, carrying an unformatted file.
    printf '%s\n' "$UGLY_TS" >theirs.ts
    git add -A
    git commit -qm "somebody else's commit"
    git update-ref refs/remotes/origin/main HEAD
    # Our own branch, cut from origin/main, entirely formatted.
    printf '%s\n' "$TIDY_TS" >ours.ts
    git add -A
    git commit -qm 'our formatted work'
  ) >/dev/null 2>&1

  run_sut case-k
  check "k: passes — the stale span is not ours" eq 0 "$sut_status"
  check "k: no output" eq "" "$sut_out"
  check "k: our file was checked" has "ours.ts" "$(invocations case-k)"
  check "k: their file was never in the set" lacks "theirs.ts" "$(invocations case-k)"
}

# --- (l) With no origin/main, fall back to local `main`. ---------------------
# The `|| echo main` half of the base expression: a clone with no `origin`
# remote must still get a gate, not a silent skip.
case_l() {
  local repo
  repo=$(init_repo case-l)
  install_prettier case-l
  (
    cd "$repo" || exit 1
    git branch main
    git update-ref -d refs/remotes/origin/main
    printf '%s\n' "$UGLY_TS" >bad.ts
    git add -A
    git commit -qm 'unformatted, on a clone with no origin'
  ) >/dev/null 2>&1

  run_sut case-l
  check "l: falls back to local main and refuses" eq 1 "$sut_status"
  check "l: names the file" has "bad.ts" "$sut_out"
}

# --- (m) No base ref at all: say so and get out of the way. ------------------
# Neither origin/main nor main exists (a fork whose default branch is named
# something else, a fresh repo). There is no honest set to check, and refusing
# every push in that state would be a gate nobody can satisfy.
case_m() {
  local repo
  repo=$(init_repo case-m)
  install_prettier case-m
  (
    cd "$repo" || exit 1
    git update-ref -d refs/remotes/origin/main
    printf '%s\n' "$UGLY_TS" >bad.ts
    git add -A
    git commit -qm 'unformatted, no base to compare against'
  ) >/dev/null 2>&1

  run_sut case-m
  check "m: passes when there is no base" eq 0 "$sut_status"
  check "m: says it skipped, rather than implying it checked" has "skipping" "$sut_out"
  check "m: prettier never invoked" eq "" "$(invocations case-m)"
}

# --- (n) A file prettier cannot PARSE refuses, and says which problem it is. --
# Prettier exits 2 here, not 1, and the distinction is worth keeping: "your file
# has a syntax error" and "your file needs a space" are different sentences, and
# the second one would be a lie. CI's `prettier --check .` hits the same wall, so
# refusing is right either way.
case_n() {
  local repo
  repo=$(init_repo case-n)
  install_prettier case-n
  (
    cd "$repo" || exit 1
    printf 'const x = = ;\n' >broken.ts
    git add -A
    git commit -qm 'a file prettier cannot parse'
  ) >/dev/null 2>&1

  run_sut case-n
  check "n: refuses the push" eq 1 "$sut_status"
  check "n: reports it as a check failure, not a formatting verdict" has \
    "could not check" "$sut_out"
  check "n: passes prettier's own error through" has "SyntaxError" "$sut_out"
  check "n: does not claim the file is merely unformatted" lacks \
    "not Prettier-formatted" "$sut_out"
}

# --- (o) Symlinks are skipped, exactly the way CI skips them. ----------------
# THE ONE PLACE BEING STRICTER THAN CI WOULD HAVE BEEN A BUG. Prettier refuses a
# symlink handed to it BY NAME (`[error] Explicitly specified pattern "..." is a
# symbolic link.`, exit 2) but skips one silently when it walks a directory — and
# the directory walk is what `prettier --check .` does in the required `lint`
# check. So without the `-L` guard this gate hard-refuses a push over a file CI
# passes, while printing a message saying CI is about to fail, with no way
# through but `--no-verify`. Measured: removing the guard turns this case red.
#
# Both flavours, because they are stopped by different lines: a link to a FILE
# passes `[ -f ]` (which follows) and needs `[ ! -L ]`, while a link to a
# DIRECTORY — this repo has seventeen under `.claude/skills/` — is already
# dropped by `[ -f ]`.
case_o() {
  local repo
  repo=$(init_repo case-o)
  install_prettier case-o
  (
    cd "$repo" || exit 1
    mkdir -p src target-dir
    printf '%s\n' "$TIDY_TS" >src/real.ts
    printf '%s\n' "$TIDY_TS" >target-dir/inner.ts
    ln -s real.ts src/link.ts
    ln -s target-dir dir-link
    git add -A
    git commit -qm 'a file, a link to it, and a link to a directory'
  ) >/dev/null 2>&1

  # Precondition, asserted rather than assumed: git must have recorded these as
  # symlinks (mode 120000) or the case proves nothing about symlinks at all.
  check "o: fixture really committed a symlink" has "120000" \
    "$(cd "$repo" && git ls-files -s src/link.ts)"

  run_sut case-o
  check "o: passes, as CI's directory walk does" eq 0 "$sut_status"
  check "o: no output" eq "" "$sut_out"
  check "o: the real file was checked" has "src/real.ts" "$(invocations case-o)"
  check "o: the file symlink never reached prettier" lacks \
    "src/link.ts" "$(invocations case-o)"
  check "o: the directory symlink never reached prettier" lacks \
    "dir-link" "$(invocations case-o)"
}

# --- (p) Both buckets at once, each under the right heading. -----------------
# The mixed case is the one that can silently regress into a single list again,
# and a single list is what made the message assert falsehoods in the first
# place. Pins that each file lands under the heading that is true of it.
case_p() {
  local repo
  repo=$(init_repo case-p)
  install_prettier case-p
  (
    cd "$repo" || exit 1
    printf '%s\n' "$UGLY_TS" >shipped.ts
    git add -A
    git commit -qm 'unformatted and committed — this one really is in the push'
    printf '%s\n' "$UGLY_TS" >wip.ts
    git add wip.ts
  ) >/dev/null 2>&1

  run_sut case-p
  check "p: refuses" eq 1 "$sut_status"
  check "p: counts both" has "2 file(s) are not Prettier-formatted" "$sut_out"
  check "p: shows the push section" has "In this push" "$sut_out"
  check "p: shows the working-tree section" has "Uncommitted in your working tree" "$sut_out"
  # Order is load-bearing: the push section is printed first, so the committed
  # file must appear before the heading that introduces the other bucket.
  check "p: the committed file is under the push heading" has \
    "shipped.ts" "$(printf '%s' "$sut_out" | sed -n '/In this push/,/Uncommitted in your working tree/p')"
  check "p: the WIP file is not under the push heading" lacks \
    "wip.ts" "$(printf '%s' "$sut_out" | sed -n '/In this push/,/Uncommitted in your working tree/p')"
  check "p: the WIP file is under the working-tree heading" has \
    "wip.ts" "$(printf '%s' "$sut_out" | sed -n '/Uncommitted in your working tree/,$p')"
  check "p: one fix command covers both" has \
    "pnpm exec prettier --write shipped.ts wip.ts" "$sut_out"
  check "p: still tells you to commit the push half" has \
    "commit the fixes that belong to this push" "$sut_out"
}

case_a
case_b
case_c
case_d
case_e
case_f
case_g
case_h
case_i
case_j
case_k
case_l
case_m
case_n
case_o
case_p

printf '\npre-push-format fixtures: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
