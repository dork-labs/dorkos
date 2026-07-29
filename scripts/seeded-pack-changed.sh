#!/usr/bin/env bash
# Decide whether a branch changed the text agents actually get seeded with.
#
# WHY THIS EXISTS. `operating-skills-version-check.yml` requires a bump to
# `OPERATING_SKILLS_VERSION` whenever a pull request changes the Operating DorkOS
# skill pack, because `seed.ts` rewrites an already-seeded copy only when the
# stored stamp is STRICTLY LOWER than the constant. That guard has no `paths:`
# filter (a filtered workflow stays Pending forever on a non-matching pull
# request and therefore can never be a REQUIRED check), so this decision is the
# only scoping it has. It runs on every pull request and short-circuits the whole
# job on all but the few that touch seeded content.
#
# The scoping used to be one `git diff --quiet` over both paths, which is
# file-granular and cannot tell a comment from skill text. That made the header's
# own promise false — "a PR that does not change what gets seeded must not be
# required to bump" — for the case that actually arose: DOR-671 rewrote the
# paragraph of `pack.ts` TSDoc that said the re-seed gap was still open, which
# that PR closed. Nothing an agent reads moved. Bumping to satisfy the guard
# would have rewritten all six seeded files in every workspace with byte-
# identical bodies and needed a History entry describing a comment edit, which
# devalues the version trail the whole ratchet argument rests on.
#
# THE TWO PATHS ARE SCOPED DIFFERENTLY, ON PURPOSE.
#
#   PACK_FILE  — comment lines are ignored. `pack.ts` is mostly prose ABOUT the
#                pack: a ~90-line docblock, then the constant and the array. Its
#                comments are never seeded anywhere.
#   SKILLS_DIR — byte-granular, unchanged. A comment inside a skill body IS
#                seeded text. The bodies are template literals written for a
#                model to read, so "prose" and "content" are the same thing
#                there, and `seed.ts` hashes the body verbatim. Do not soften
#                this side to match the other; they are not the same problem.
#
# What counts as a comment line is deliberately narrow: a diff line whose content
# begins with `*`, `/*` or `//`, which covers every line of a TSDoc block
# including its opener and closer. A line that merely CONTAINS `//` is real code.
#
# Blank lines are ignored too. A blank line carries no seeded text, so a change
# made only of them cannot alter the constant or the pack array. Removing a blank
# line from inside a TSDoc block is otherwise indistinguishable from real code
# movement, because a bare `+`/`-` diff line matches no comment pattern.
#
# `--output-indicator-new/old` is what makes the filtering safe rather than
# nearly safe. The obvious spelling greps `^[+-]` and then drops `^(\+\+\+|---)`
# to shed the file headers, but that also drops any REMOVED line whose own
# content starts with `--`: git renders it `----`, which is indistinguishable
# from the `--- a/path` header by prefix alone. Re-lettering content lines to
# `<`/`>` leaves the headers as the only `+++`/`---` in the stream, so no content
# line can ever be mistaken for one. Pinned by the `---` fixture in
# scripts/test-seeded-pack-changed.sh.
#
# Usage:
#   scripts/seeded-pack-changed.sh <fork-point> [<head>]
#
# Prints exactly one line to stdout:
#   changed     seeded content moved; the version guard must run
#   unchanged   nothing an agent reads moved; no bump is owed
#
# The reasoning goes to stderr, so a caller can capture the verdict alone.
# Exit status is 0 for a verdict and 2 only when git could not answer, so an
# unresolvable ref can never be mistaken for a quiet `unchanged`. That direction
# matters more than it looks: every wrong answer this script can give in the
# `unchanged` direction disables a required check silently.
#
# Runs against the git repository in the CURRENT WORKING DIRECTORY. PACK_FILE and
# SKILLS_DIR default to the real paths and are read from the environment when
# set, which is how the workflow's job-level `env:` stays the single source of
# truth for both this step and the version-reading steps after it.

set -uo pipefail

pack_file=${PACK_FILE:-packages/operating-skills/src/pack.ts}
skills_dir=${SKILLS_DIR:-packages/operating-skills/src/skills}

die() {
  printf 'seeded-pack-changed: %s\n' "$1" >&2
  exit 2
}

[ $# -ge 1 ] || die 'usage: seeded-pack-changed.sh <fork-point> [<head>]'

fork_point=$1
head=${2:-HEAD}

git rev-parse --git-dir >/dev/null 2>&1 ||
  die "not inside a git repository (cwd: $PWD)."

# Both paths are repo-root-relative, and git resolves a pathspec against the CWD.
# Run from `packages/` and the same real pack.ts edit matches nothing, which this
# script would otherwise report as `unchanged` with exit 0 and no warning. The
# workflow is safe only because `run:` defaults to $GITHUB_WORKSPACE, which one
# `working-directory:` key would quietly undo.
toplevel=$(git rev-parse --show-toplevel) ||
  die "could not resolve the repository root from $PWD."
cd "$toplevel" || die "could not enter the repository root $toplevel."

for ref in "$fork_point" "$head"; do
  git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null ||
    die "could not resolve '$ref' to a commit. Refusing to report 'unchanged' off
a ref this script never read — that would switch a required check off silently."
done

# A pathspec that matches nothing produces an empty diff, which is byte-identical
# to "nothing changed" and is the same false green. One typo in the workflow's
# `env:`, or a package restructure that moves both paths, disables this guard on
# every pull request forever with nothing going red. The fixture suite proves the
# workflow and this script AGREE on the two strings; only this proves either one
# points at something real.
for path in "$pack_file" "$skills_dir"; do
  [ -n "$(git ls-tree -r --name-only "$head" -- "$path")" ] ||
    die "'$path' matches nothing at $head. This guard scopes on that path, so it
would report 'unchanged' for every change from here on. If the pack moved or was
renamed, update PACK_FILE/SKILLS_DIR in
.github/workflows/operating-skills-version-check.yml and the defaults in this
script together."
done

# --- The skills directory: byte-granular, any difference counts ---------------
#
# `--quiet` implies `--exit-code`: 0 means identical, 1 means they differ, and
# anything above that is git failing, which must not read as "identical".
git diff --quiet "$fork_point" "$head" -- "$skills_dir"
skills_status=$?
case $skills_status in
  0) skills_changed=false ;;
  1) skills_changed=true ;;
  *) die "git diff failed on $skills_dir (exit $skills_status)." ;;
esac

# --- The pack file: comment and blank lines do not count ----------------------
#
# Captured in two steps rather than one pipeline so that "git could not diff"
# and "grep matched nothing" cannot arrive as the same non-zero status. The
# second is a normal outcome and the first is fatal.
if ! pack_diff=$(git diff --unified=0 \
  --output-indicator-new='>' --output-indicator-old='<' \
  "$fork_point" "$head" -- "$pack_file" 2>&1); then
  die "git diff failed on $pack_file: $pack_diff"
fi

# Zero `<`/`>` lines has two very different causes, and only one of them is
# clean. A comment-only diff yields plenty of content lines and then filters them
# all away — fine. But a diff git does NOT render as a line stream yields none at
# all, and reading that as "no real lines" is the same false green as an empty
# pathspec: a real 4-to-5 bump in a file marked `-diff`, or one carrying a NUL
# byte, reports `unchanged`. `--numstat` is the authority on which happened,
# because it reports `-` for a binary diff and real counts for a text one.
if ! pack_numstat=$(git diff --numstat "$fork_point" "$head" -- "$pack_file" 2>&1); then
  die "git diff --numstat failed on $pack_file: $pack_numstat"
fi

if [ -n "$pack_numstat" ]; then
  pack_added=$(printf '%s\n' "$pack_numstat" | awk 'NR==1 {print $1}')
  pack_deleted=$(printf '%s\n' "$pack_numstat" | awk 'NR==1 {print $2}')

  if [ "$pack_added" = '-' ] || [ "$pack_deleted" = '-' ]; then
    die "git renders the diff of $pack_file as BINARY, so this guard cannot read
which lines moved. Refusing to report 'unchanged' off a diff it never parsed. A
text file lands here when a .gitattributes entry marks it \`-diff\` or when it
picks up a NUL byte; fix that rather than trusting this check."
  fi

  # Mode-only and rename-only changes legitimately move zero lines, so `0 0` is
  # a real answer rather than a parse failure.
  content_lines=$(printf '%s\n' "$pack_diff" | grep -cE '^[<>]') || content_lines=0
  if [ "$pack_added" -ne 0 ] || [ "$pack_deleted" -ne 0 ]; then
    [ "$content_lines" -gt 0 ] ||
      die "git reports $pack_added added and $pack_deleted deleted line(s) in
$pack_file, but the diff yielded no readable content lines. That is an
unparseable diff, not a clean one."
  fi
fi

# An empty grep result exits 1. That is expected here (it is the whole point of a
# comment-only diff), so it is converted to an empty string rather than allowed
# to look like a failure.
pack_real=$(printf '%s\n' "$pack_diff" |
  grep -E '^[<>]' |
  grep -vE '^[<>][[:space:]]*(\*|/\*|//)' |
  grep -vE '^[<>][[:space:]]*$') || pack_real=''

if [ -n "$pack_real" ] || [ "$skills_changed" = true ]; then
  printf 'changed\n'
  {
    printf 'seeded-pack-changed: seeded pack content changed between %s and %s.\n' \
      "$fork_point" "$head"
    if [ "$skills_changed" = true ]; then
      printf '  %s:\n' "$skills_dir"
      git diff --name-only "$fork_point" "$head" -- "$skills_dir" | sed 's/^/    /'
    fi
    if [ -n "$pack_real" ]; then
      printf '  %s, non-comment lines:\n' "$pack_file"
      printf '%s\n' "$pack_real" | sed 's/^/    /'
    fi
  } >&2
  exit 0
fi

printf 'unchanged\n'
{
  printf 'seeded-pack-changed: nothing an agent reads changed between %s and %s.\n' \
    "$fork_point" "$head"
  if ! git diff --quiet "$fork_point" "$head" -- "$pack_file"; then
    # Distinguish the two clean ways to reach here, so the line does not report a
    # comment edit that did not happen.
    if [ "${pack_added:-0}" -eq 0 ] && [ "${pack_deleted:-0}" -eq 0 ]; then
      printf '  %s changed only in file mode or name; no lines moved.\n' "$pack_file"
    else
      printf '  %s changed, but only in comments or blank lines.\n' "$pack_file"
    fi
  fi
  printf '  No version bump is owed.\n'
} >&2
exit 0
