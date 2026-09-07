#!/usr/bin/env bash
# Pre-push gate: refuse a push whose changed files are not Prettier-formatted
# (DOR-1839).
#
#   bash scripts/pre-push-format-check.sh
#
# Silent and ~0.2s when the changed set is clean, which is every push that
# behaves. The only time it says anything is the time it saves a CI round-trip.
#
# WHY THIS EXISTS
#
# `prettier --check .` runs inside the REQUIRED `lint` merge-queue check, so an
# unformatted file cannot land — but until this gate, nothing said so until the
# PR was already open. In the week before this was written, SEVEN pull requests
# across FIVE sessions went red on that check, every one of them a single
# `prettier --write` away from green, and one spec file did it twice from two
# different sessions. Each costs a push, a CI wait, a fix commit and another
# wait, for a class of mistake a machine can settle in under a second.
#
# The formatting layers that already existed do not close this, by design:
#
#   * The `Stop` hook (.claude/hooks/format-changed.sh) formats the working
#     tree once per turn, but it FAILS OPEN on purpose — no node_modules, no
#     prettier, a parse error mid-write, all no-ops — because it is cosmetic and
#     a Stop hook that errors blocks the turn from ending.
#   * The lefthook `pre-commit` `format` command formats `{staged_files}` with
#     `stage_fixed: true`, so anything that goes through a normal commit is
#     formatted. What escapes it is everything that does not: `--no-verify`
#     commits, `git commit --amend` over a file added after the hook ran, and
#     hand-edited changelog fragments — which is exactly the population of the
#     seven failures.
#
# So the honest description of this script is "the last place the mistake is
# cheap". It is not a new source of truth about formatting; it runs the same
# prettier, from the same lockfile, against the same `.prettierrc` and
# `.prettierignore` that CI uses, so it can never disagree with the gate it
# front-runs.
#
# CHECK, NEVER WRITE
#
# The pre-commit hook writes because it can stage what it rewrote. A pre-push
# hook cannot: git has already resolved the refs it is about to send by the time
# the hook runs, so a hook that rewrites tracked files during a push leaves the
# working tree disagreeing with the commits that just went out, silently. Worse,
# the rewrite would not be IN the push — you would push the unformatted content
# and then find a dirty tree, which is the same red on the PR plus a confusing
# local state. Refusing is the only honest move: it is the one outcome where the
# thing you push and the thing on your disk still match.
#
# WHICH FILES — THE SAME "CHANGED" THE TEST GATE MEANS
#
# The base is resolved with the exact expression the `tests` command in
# lefthook.yml uses for TURBO_SCM_BASE (DOR-617/DOR-1717):
#
#     $(git rev-parse --verify --quiet origin/main || echo main)
#
# and for the same reason. Turbo's — and git's — default `main` is the LOCAL
# branch, which on this machine only moves when a human pulls while every
# worktree branch is cut straight from `origin/main`, so it trails by dozens of
# commits and the diff sweeps in everybody else's merges. A formatting gate
# scoped that way would refuse pushes over files the pusher never touched, and
# would be switched off within a day. The `main` fallback covers a clone with
# no `origin` remote.
#
# The diff is `merge-base(base, HEAD)` against the WORKING TREE — no second
# commit — which is the union of committed, staged and unstaged changes. Two
# deliberate properties:
#
#   * It mirrors turbo `--affected`, which also counts uncommitted files as
#     changed. Over-inclusive is the safe direction for a gate, and the pre-commit
#     lint command in lefthook.yml already says so in as many words.
#   * It is the only endpoint COHERENT with what prettier reads. Prettier checks
#     bytes on disk, so a set defined as "changed in HEAD" would hand prettier
#     working-tree content while claiming to describe committed content — it
#     would red a clean push over an unrelated dirty edit AND miss a dirty edit
#     to a file HEAD did not touch. Diffing to the working tree makes the set and
#     the bytes the same thing.
#
# Untracked files are NOT included, unlike the Stop hook's set. An untracked file
# is not part of any push and never reaches CI, so refusing a push over one would
# be a toll rather than a gate.
#
# THE ONE GAP, stated rather than papered over: because prettier reads the disk,
# a file that is unformatted in HEAD but already fixed in an UNCOMMITTED edit
# passes here and still reds CI. Closing it would mean checking `git show
# HEAD:<path>` content per file, which is one prettier process per file and gives
# up `.prettierignore`, config and plugin resolution. The pre-commit hook makes
# that case vanishingly rare (it formats what you commit), and the failure is
# loud and one command from fixed when it happens.
#
# THE OTHER GAP, same shape: a change to `.prettierrc` or `.prettierignore`
# re-scopes the WHOLE repository — 9,918 files as of 2026-09-07 (counted with
# `prettier.getFileInfo` over `git ls-files`) — while this gate still looks only
# at the handful you touched, one of which is the config itself. So the one edit
# that can red CI everywhere at once is the one edit this cannot see coming. It
# is deliberate: checking 9,918 files takes minutes, which is the test gate's
# job, not this one's. Run `pnpm format:check` by hand when you touch either file.
#
# `--diff-filter=ACMRT` drops deletions, so a push that removes files never hands
# prettier a path that is gone; a rename reports only its DESTINATION under
# `--name-only`, which is the path that exists. The `-f` test behind it covers a
# path that vanished between the diff and the check, and — because `-f` follows
# links — a symlink to a DIRECTORY, which this repo has seventeen of under
# `.claude/skills/`.
#
# SYMLINKS TO FILES NEED THEIR OWN GUARD, and this is the one place where being
# stricter than CI would have been a bug rather than a virtue. Prettier refuses a
# symlink handed to it BY NAME — `[error] Explicitly specified pattern "x.ts" is
# a symbolic link.`, exit 2 — but SKIPS one silently when it finds it by walking
# a directory. So `prettier --check .` in CI passes over exactly the file this
# gate would have hard-refused, and the refusal would have come with a message
# saying CI was about to fail, which was false, and no way through but
# `--no-verify`. `[ ! -L ]` makes this gate match prettier's own traversal
# behaviour, which is the behaviour that decides the PR.
#
# `-z` because git quotes non-ASCII paths unless it is emitting NUL-delimited
# output.
#
# `.prettierignore` is honored by prettier itself, which skips ignored paths it
# is handed explicitly — the same delegation .claude/hooks/format-changed.sh
# relies on, and the reason `pnpm-lock.yaml` (DOR-1715) costs this gate nothing:
# prettier drops ignored paths before it loads a parser, so a lockfile-only push
# is measurably indistinguishable from no push at all.
#
# `--ignore-unknown` rather than an extension allow-list. A changed set routinely
# contains `.sh`, `.png` and extensionless files, and prettier exits 2 with "No
# parser could be inferred" on those — a hard refusal of an innocent push. The
# flag defers to prettier's own support table, which is what `prettier --check .`
# in CI effectively uses, so this gate cannot drift from it the way a hand-written
# list would.
#
# WHY `--list-different` AND NOT `--check`
#
# They are the same computation; `--check` is `--list-different` plus prose. This
# needs the machine-readable half, because the whole point of the failure output
# is to hand back a `pnpm exec prettier --write <exact files>` line you can paste.
# Parsing that list back out of `--check`'s `[warn]` lines would be a needless
# dependency on prettier's log formatting.
#
# WHY THE DIRECT BINARY, WHEN THE MESSAGE SAYS `pnpm exec`
#
# Both spellings resolve the same lockfile-pinned prettier. `pnpm exec` is what a
# human should type and so is what the fix line prints; `node_modules/.bin/
# prettier` is what a gate should run, because it costs ~250ms less on every push
# and because it is a path a fixture can substitute — which is how
# scripts/test-pre-push-format-check.sh proves the "prettier was never invoked"
# cases at all. Same reasoning, and the same line, as
# .claude/hooks/format-changed.sh.
#
# No `--cache`. The Stop hook caches because it re-formats a branch's whole
# cumulative changed set on every single turn; this runs once per push. Prettier's
# default cache strategy is `metadata` (mtime and size), which is one more thing
# that can answer "formatted" without looking — a poor trade for a gate, at the
# prices below.
#
# WHAT IT COSTS, measured on this machine on 2026-09-07, warm:
#
#   * empty changed set                     26ms   (git plumbing only; prettier
#                                                   is never started)
#   * pnpm-lock.yaml only (21k lines,
#     .prettierignore'd, DOR-1715)          96ms   (node startup; prettier drops
#                                                   an ignored path before it
#                                                   loads a parser)
#   * this change: 7 root/scripts files    290ms
#   * the LARGEST of the last 25 commits
#     on main, 63 files                    961ms
#   * 42 files / 34 / 29                   867 / 780 / 503ms
#
# The last 25 squashed PRs on main changed a median of 11 files and a maximum of
# 63, so a real push pays well under a second. It is not free at every scale —
# 374 files takes 4.5s and 2,871 takes 29s — but those are spans of main, not
# branches, and any push that large is already paying minutes in the test gate
# behind this one. Revisit `--cache` if that ever stops being true.
#
# THE FRESH-WORKTREE CASE — the one place this DELIBERATELY fails
#
# A worktree created but never `pnpm install`ed has no prettier, and every other
# gate in the pre-push hook is equally dead there: turbo is missing too, so the
# push already failed in ~0.4s with a message about a diff base. This step runs
# FIRST, so its message is now the one you see, and it names the fix. It exits 1
# rather than skipping, because "we could not check" is not "there is nothing to
# check" — the same fail-closed argument scripts/pre-push-watchdog.sh makes for
# its timeout. `git push --no-verify` remains the deliberate way past it.
#
# Contrast with the Stop hook, which no-ops in the identical situation: that one
# is cosmetic and runs unasked dozens of times a turn, this one runs once at the
# moment you are asking for the tree to be checked.
#
# OUTPUT GOES TO STDOUT, not stderr. lefthook's `follow: true` was measured
# relaying stdout; nothing about this report is worth risking on a stream whose
# relaying was not. The `fail_text` in lefthook.yml is a one-line summary, not the
# message — the report below is.

set -uo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || repo_root=
if [ -z "$repo_root" ]; then
  # Unreachable from a real pre-push hook; cheap enough to say so rather than
  # let `cd` fail with something less obvious.
  printf 'pre-push formatting: not inside a git repository — skipping.\n'
  exit 0
fi
cd "$repo_root" || exit 1

# Identical to the `tests` command's TURBO_SCM_BASE expression, on purpose — see
# the header. `--verify --quiet` prints a sha and stays silent when the ref is
# absent, so the fallback is the literal branch name for git to resolve.
base="$(git rev-parse --verify --quiet origin/main || echo main)"

merge_base=$(git merge-base "$base" HEAD 2>/dev/null) || merge_base=
if [ -z "$merge_base" ]; then
  # No common ancestor (unrelated histories, a shallow clone that does not reach
  # back far enough). Diffing against the base tip itself is still a useful
  # "what is different here", so prefer it over giving up.
  merge_base=$(git rev-parse --verify --quiet "$base^{commit}") || merge_base=
fi
if [ -z "$merge_base" ]; then
  printf 'pre-push formatting: no origin/main or main to diff against — skipping.\n'
  exit 0
fi

files=()
while IFS= read -r -d '' file; do
  [ -n "$file" ] || continue
  [ -f "$file" ] || continue
  # `-f` follows the link, so this has to come after it and separately: prettier
  # refuses a symlink named explicitly while skipping one it finds by walking a
  # directory, and the directory walk is what CI does. See the header.
  [ ! -L "$file" ] || continue
  files+=("$file")
done < <(git diff --name-only -z --diff-filter=ACMRT "$merge_base" -- 2>/dev/null)

# Which paths this push actually CARRIES — the committed half of the same diff.
# Used only to say true things in the failure report. The set above is
# deliberately over-inclusive of working-tree state, so without this the report
# would tell someone their work in progress is "in this push" and that CI is
# about to fail over it, and advise committing it to fix that. All three would
# be false.
#
# THE DISCRIMINATOR IS "IS THE PATH IN THE PUSH", not "is the file dirty", and
# the difference matters in one direction only. A file committed unformatted and
# then edited again is dirty AND in the push; classifying by dirtiness would put
# it under a heading saying CI cannot see it, which is the one error worth
# avoiding here — a reassurance that is wrong. Classifying by path can only
# over-warn (a dirty file whose committed bytes happen to be fine gets listed as
# in the push), and an over-warning about a file you must tidy anyway costs
# nothing.
committed=$(git diff --name-only -z --diff-filter=ACMRT "$merge_base" HEAD -- 2>/dev/null | tr '\0' '\n')

# An empty changed set is an instant pass, and it must not reach prettier:
# prettier with zero file arguments is an error, and on bash 3.2 (macOS) the
# expansion of an empty array under `set -u` would take the script down first.
[ ${#files[@]} -gt 0 ] || exit 0

prettier_bin="$repo_root/node_modules/.bin/prettier"
if [ ! -x "$prettier_bin" ]; then
  printf 'git push refused: no prettier in this checkout.\n\n'
  printf '  %s\n\n' "$prettier_bin"
  printf 'is missing, so the formatting check could not run. This is what a worktree\n'
  printf 'created but never installed looks like — the test gate behind this one needs\n'
  printf 'the same node_modules and would fail next. Run:\n\n'
  printf '  pnpm install\n\n'
  exit 1
fi

prettier_errors=$(mktemp -t prepush-format.XXXXXX) || exit 1
trap 'rm -f "$prettier_errors"' EXIT

unformatted=$("$prettier_bin" --list-different --ignore-unknown "${files[@]}" 2>"$prettier_errors")
status=$?

[ "$status" -eq 0 ] && exit 0

if [ "$status" -ne 1 ]; then
  # Exit 2 is prettier failing to READ or PARSE a file, not a formatting verdict
  # — a syntax error, an unreadable path. CI's `prettier --check .` would hit the
  # same wall and go red, so this refuses too, but it must not claim the file is
  # merely unformatted.
  printf 'git push refused: prettier could not check the changed files.\n\n'
  cat "$prettier_errors"
  printf '\nCI runs the same prettier inside the required `lint` check, so this fails\n'
  printf 'there too. Fix the file it names, then push again.\n\n'
  exit 1
fi

# TWO BUCKETS, because they warrant two different sentences. A path this push
# carries is one CI will read; a path it does not is caught here only because the
# set is deliberately over-inclusive of working-tree state (see the header), and
# saying "CI will fail on this, commit it and push again" about somebody's work
# in progress would be false twice over and would advise committing it to boot.
in_push=''
working=''
while IFS= read -r file; do
  [ -n "$file" ] || continue
  if printf '%s\n' "$committed" | grep -qxF "$file"; then
    in_push="${in_push}${file}"$'\n'
  else
    working="${working}${file}"$'\n'
  fi
done <<<"$unformatted"

count=$(printf '%s\n' "$unformatted" | grep -c '[^[:space:]]')
printf 'git push refused: %s file(s) are not Prettier-formatted.\n' "$count"

if [ -n "$in_push" ]; then
  printf '\nIn this push — CI runs `prettier --check .` inside the required `lint`\n'
  printf 'check and WILL fail on these:\n\n'
  printf '%s' "$in_push" | sed 's/^/  /'
fi

if [ -n "$working" ]; then
  printf '\nUncommitted in your working tree — not in this push, and CI will not see\n'
  printf 'them until you commit them:\n\n'
  printf '%s' "$working" | sed 's/^/  /'
fi

printf '\nFix them:\n\n  pnpm exec prettier --write'
while IFS= read -r file; do
  [ -n "$file" ] || continue
  printf ' '
  printf '%q' "$file"
done <<<"$unformatted"
if [ -n "$in_push" ]; then
  printf '\n\nThen commit the fixes that belong to this push and push again.\n\n'
else
  printf '\n\nNothing needs committing — they only have to be tidy for the push to go.\n\n'
fi

exit 1
