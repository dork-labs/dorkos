#!/usr/bin/env bash
# The `release-branch-contents` check (DOR-4639): a pull request into a release
# branch may carry only cherry-picks of main and the release commit.
#
# WHY. Releases ship from short-lived `release/v<X.Y.Z>` branches cut from the
# main commit QA pinned (decision DOR-4636). Main keeps merging while the branch
# is checked, so the branch is safe only if nothing reaches it that main does
# not already hold: a fix found during the release lands on main first and is
# then cherry-picked (Security, DOR-3100).
#
# ONE RULE, NOT TWO. Which commits may ship is decided by DOR-4638's
# `packages/cli/scripts/release-branch/check-picks.ts` (over `rules.ts`), the
# same function the release publish runs, so this check and the publish can
# never disagree. It owns, per commit:
#   - a cherry-pick: exactly one `(cherry picked from commit <sha>)` line, that
#     sha on main, not already in the branch's base, not reverted later on
#     main, and a byte-exact patch fingerprint equal to the source's (unlike
#     `git patch-id`, whitespace and binary content count, so a pick that
#     changes a string literal or a YAML indent is refused);
#   - anything else must be THE release commit: subject exactly
#     `chore(release): v<X.Y.Z>`, setting VERSION to X.Y.Z, and touching only
#     release metadata:
#     VERSION, the changelogs, the five package.json files (version only),
#     fragment deletions, the rolling changelog archive, the blog post and the
#     product media archive. Workflow, tool and lockfile paths are refused by
#     name; runnable code (config migrations, agent-release-notes.ts) is not
#     metadata and lands on main before the cut;
#   - merge and root commits, empty commits, shallow clones and read errors.
#
# THIS SCRIPT owns only what check-picks does not:
#   - the branch name is exactly `release/v<X.Y.Z>`, and X.Y.Z is the version
#     handed to the rule;
#   - main and the branch are fetched from the remote, so the main SHA the rule
#     trusts is the remote's tip, not whatever the clone had;
#   - the PR's base is on the branch, the branch shares history with main, the
#     head shares history with the base, and the range is not empty;
#   - the rule's answer is sane: a { ok, findings } verdict that agrees with
#     its exit code, findings only on commits in the range, exit 0 or 1 only;
#   - the per-commit verdict table in the job summary. Finding codes are
#     printed as the rule names them, so a code added to rules.ts needs no
#     change here.
#
# HOTFIXES. Publishing a hotfix branch cut from a tag is off in DOR-4638 until
# tags are locked (DOR-4789). A pull request into any release/v<X.Y.Z> branch
# is judged the same way here; nothing in this script treats a tag base
# specially. In branch mode (below) a hotfix branch cut from a tag FAILS
# CLOSED: its base is the merge-base with main, so every commit between that
# and the tag is judged and refused. That stays so until DOR-4789.
#
# BRANCH MODE. The desktop release job judges a whole release branch at its
# tip rather than one pull request: `--branch release/vX.Y.Z --version X.Y.Z
# --head-sha <sha>` instead of `--base-ref`/`--base-sha`. The caller passes
# the PEELED tag commit (`git rev-parse "vX.Y.Z^{commit}"`) as --head-sha and
# must check the tag name itself; this script never sees the tag. It needs
# full history (actions/checkout with fetch-depth: 0). Here:
#   - --version must be X.Y.Z (exit 2 otherwise) and equal the version in the
#     branch name, else refused `version-not-branch`;
#   - main and the branch are fetched as in PR mode, and --head-sha must be
#     the fetched branch tip, else refused `head-not-branch-tip`;
#   - the base is `git merge-base <main tip> <head>`. No merge-base is refused
#     `base-not-on-main`; more than one merge-base (a criss-cross merge) is
#     refused `base-ambiguous`; a base that is not an ancestor of both main's
#     tip and the head is refused `base-not-reachable`;
#   - then the same rule, checks, table, summary and exit codes as PR mode.
# --branch cannot be combined with --base-ref or --base-sha, and --version
# needs --branch (exit 2).
#
# The rule directory is passed in (--rule-dir). The workflow extracts MAIN's
# copy of packages/cli/scripts/release-branch/ into a temp folder, so a pull
# request cannot edit the rule that grades it. Those files import only each
# other and node builtins (DOR-4638's import test), so they run with no install:
#   node --experimental-strip-types check-picks.ts <repo> <version> <base> <head> <main-sha>
#
# CONFLICTS. A conflict-resolved pick has a different fingerprint and is
# refused, with no waiver here: land the shape the branch needs on main first,
# or take it to Security (contributing/ci.md, "Release branches").
#
# FAILS CLOSED. Exit codes:
#   0  every commit passed
#   1  at least one commit, the branch or the base was refused
#   2  the check could not decide (bad arguments, no rule directory, git or
#      node failed, shallow clone, check-picks answered 2 or something else)
#
# UNTRUSTED INPUT. The branch name, commit subjects and the rule's findings
# (which quote commit data) are data: the branch name is validated before git
# sees it, nothing is evaluated, and everything printed is sanitized so it
# cannot become a workflow command (`::...`) or break the summary table.
#
# Usage:
#   scripts/ci/release-branch-contents.sh --rule-dir <dir> --base-ref <branch> \
#     --base-sha <sha> --head-sha <sha> [--remote origin] [--summary <file>]
#   scripts/ci/release-branch-contents.sh --rule-dir <dir> --branch <branch> \
#     --version <X.Y.Z> --head-sha <sha> [--remote origin] [--summary <file>]
#
# Needs git, jq and node >= 22.6. Pinned by scripts/test-release-branch-contents.sh.

set -uo pipefail

remote=origin
rule_dir=''
base_ref=''
base_sha=''
head_sha=''
branch=''
version_arg=''
seen_base=0
seen_branch=0
seen_version=0
summary=${GITHUB_STEP_SUMMARY:-}

die() {
  echo "release-branch-contents: ERROR: $*" >&2
  exit 2
}

usage() {
  die 'usage: release-branch-contents.sh --rule-dir <dir> --base-ref <branch> --base-sha <sha> --head-sha <sha> [--remote <name>] [--summary <file>]
   or: release-branch-contents.sh --rule-dir <dir> --branch <branch> --version <X.Y.Z> --head-sha <sha> [--remote <name>] [--summary <file>]'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --rule-dir) [ $# -ge 2 ] || usage; rule_dir=$2; shift 2 ;;
    --base-ref) [ $# -ge 2 ] || usage; base_ref=$2; seen_base=1; shift 2 ;;
    --base-sha) [ $# -ge 2 ] || usage; base_sha=$2; seen_base=1; shift 2 ;;
    --head-sha) [ $# -ge 2 ] || usage; head_sha=$2; shift 2 ;;
    --branch) [ $# -ge 2 ] || usage; branch=$2; seen_branch=1; shift 2 ;;
    --version) [ $# -ge 2 ] || usage; version_arg=$2; seen_version=1; shift 2 ;;
    --remote) [ $# -ge 2 ] || usage; remote=$2; shift 2 ;;
    --summary) [ $# -ge 2 ] || usage; summary=$2; shift 2 ;;
    *) usage ;;
  esac
done
if [ "$seen_branch" -eq 1 ]; then
  mode='branch'
  [ "$seen_base" -eq 0 ] || die '--branch (branch mode) cannot be combined with --base-ref or --base-sha'
  [ -n "$rule_dir" ] && [ -n "$branch" ] && [ -n "$version_arg" ] && [ -n "$head_sha" ] || usage
else
  mode='pr'
  [ "$seen_version" -eq 0 ] || die '--version is only for branch mode (--branch)'
  [ -n "$rule_dir" ] && [ -n "$base_ref" ] && [ -n "$base_sha" ] && [ -n "$head_sha" ] || usage
fi
command -v jq >/dev/null 2>&1 || die 'jq is not installed'
command -v node >/dev/null 2>&1 || die 'node is not installed'
[[ "$remote" =~ ^[A-Za-z0-9._-]+$ ]] || die "remote name '$remote' is not a plain name"
[ -f "$rule_dir/check-picks.ts" ] ||
  die "no check-picks.ts in '$rule_dir'. The rule is packages/cli/scripts/release-branch/ on main (DOR-4638); until it is on main there is nothing to judge by, so this check cannot pass"
# The physical path. check-picks.ts now compares real paths itself and exits 2
# when it cannot confirm it is the program (DOR-4638 entry.ts); resolving here
# too is harmless and keeps an older copy on main from passing silently. The
# verdict-shape check below is the backstop either way.
rule_dir=$(cd "$rule_dir" && pwd -P) || die "cannot resolve the rule directory"

# Printable, one line, at most $2 (default 100) bytes, no table pipes, no
# backticks, and never a `::` that the runner could read as a workflow command.
clean() {
  printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177' | LC_ALL=C cut -c1-"${2:-100}" |
    sed -e 's/|/\\|/g' -e 's/`/'"'"'/g' -e 's/::/: :/g'
}

rows=''
add_row() {
  # sha, verdict, kind, subject, reason
  rows="$rows| \`${1:0:12}\` | $2 | $3 | $(clean "$4") | $(clean "$5" 400) |"$'\n'
  printf '%-12s  %-6s  %-12s  %s\n' "${1:0:12}" "$2" "$3" "$(clean "$4")"
  printf '              %s\n' "$(clean "$5" 400)"
}

write_summary() {
  [ -n "$summary" ] || return 0
  {
    echo '## release-branch-contents'
    echo
    if [ "$mode" = branch ]; then
      local base_label=${base_sha:0:12}
      echo "Branch \`$(clean "$branch")\`, base \`${base_label:-none}\` (its merge-base with main), head \`${head_sha:0:12}\`. $1"
    else
      echo "Base \`$(clean "$base_ref")\` at \`${base_sha:0:12}\`, head \`${head_sha:0:12}\`. $1"
    fi
    echo
    if [ -n "$rows" ]; then
      echo '| Commit | Verdict | Kind | Subject | Why |'
      echo '| --- | --- | --- | --- | --- |'
      printf '%s' "$rows"
      echo
    fi
    # shellcheck disable=SC2016 # literal backticks: markdown code spans
    echo 'A commit passes only as a `git cherry-pick -x` of a commit on main with the same byte-exact patch, or as the release commit `chore(release): v<X.Y.Z>` touching only release metadata. The rule is main'"'"'s packages/cli/scripts/release-branch/check-picks.ts; see contributing/ci.md, "Release branches".'
  } >>"$summary" || die "cannot write the summary to $summary"
}

refuse_pr() {
  echo "release-branch-contents: REFUSED: $*" >&2
  write_summary "**Refused:** $(clean "$*" 400)"
  exit 1
}

semver='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'

# release_version <ref>: sets $version from a release/v<X.Y.Z> name, or fails.
release_version() {
  [[ "$1" =~ ^release/v${semver}$ ]] || return 1
  version="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
}

require_full_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "'$1' is not a full commit sha"
}

# fetch_history <branch>: fetch main and <branch> from the remote, refuse a
# shallow clone, and set repo, main_tip and branch_tip.
fetch_history() {
  local ref=$1 main_ref branch_ref shallow
  repo=$(git rev-parse --show-toplevel 2>/dev/null) || die 'not inside a git repository'
  main_ref="refs/remotes/$remote/main"
  branch_ref="refs/remotes/$remote/$ref"
  git fetch --no-tags --quiet "$remote" "+refs/heads/main:$main_ref" "+refs/heads/$ref:$branch_ref" ||
    die "cannot fetch main and $ref from $remote"
  shallow=$(git rev-parse --is-shallow-repository) || die 'cannot tell whether the clone is shallow'
  [ "$shallow" = false ] || die 'the clone is shallow, so reachability from main cannot be trusted; check out with fetch-depth: 0'

  main_tip=$(git rev-parse --verify --quiet "$main_ref^{commit}") || die "cannot resolve $main_ref"
  branch_tip=$(git rev-parse --verify --quiet "$branch_ref^{commit}") || die "cannot resolve $branch_ref"
}

# --- The branch and the base ------------------------------------------------
if [ "$mode" = pr ]; then
  if ! release_version "$base_ref"; then
    refuse_pr "base branch '$base_ref' is not a release branch: the shape is release/v<X.Y.Z>, for example release/v0.137.0"
  fi

  for sha in "$base_sha" "$head_sha"; do
    require_full_sha "$sha"
  done

  fetch_history "$base_ref"
  git cat-file -e "$base_sha^{commit}" 2>/dev/null || die "base $base_sha is not a commit in this clone"
  git cat-file -e "$head_sha^{commit}" 2>/dev/null || die "head $head_sha is not a commit in this clone"

  git merge-base --is-ancestor "$base_sha" "$branch_tip"
  case $? in
    0) ;;
    1) refuse_pr "the pull request's base $base_sha is not on $base_ref (tip $branch_tip)" ;;
    *) die "git merge-base --is-ancestor failed" ;;
  esac
  cut=$(git merge-base "$main_tip" "$base_sha") ||
    refuse_pr "$base_ref shares no history with main, so it was not cut from main"
  git merge-base "$base_sha" "$head_sha" >/dev/null ||
    refuse_pr "the head $head_sha shares no history with $base_ref"
  label=$base_ref
else
  [[ "$version_arg" =~ ^${semver}$ ]] || die "--version '$(clean "$version_arg")' is not X.Y.Z"
  if ! release_version "$branch"; then
    refuse_pr "branch '$branch' is not a release branch: the shape is release/v<X.Y.Z>, for example release/v0.137.0"
  fi
  [ "$version" = "$version_arg" ] ||
    refuse_pr "version-not-branch: --version $version_arg is not the version of $branch ($version)"
  require_full_sha "$head_sha"

  fetch_history "$branch"
  git cat-file -e "$head_sha^{commit}" 2>/dev/null || die "head $head_sha is not a commit in this clone"
  [ "$head_sha" = "$branch_tip" ] ||
    refuse_pr "head-not-branch-tip: the head $head_sha is not the tip of $branch on $remote ($branch_tip)"

  # --all: a branch cut once from main has exactly one merge-base with it.
  # More than one (a criss-cross merge) is refused rather than picking one.
  bases=$(git merge-base --all "$main_tip" "$head_sha")
  case $? in
    0) ;;
    1) base_sha=''; refuse_pr "base-not-on-main: $branch (tip $head_sha) shares no history with main (tip $main_tip), so it was not cut from main" ;;
    *) die "git merge-base --all $main_tip $head_sha failed" ;;
  esac
  nbases=$(printf '%s\n' "$bases" | grep -c .)
  if [ "$nbases" -ne 1 ]; then
    base_sha=''
    refuse_pr "base-ambiguous: release branch has $nbases merge-bases with main; recut it"
  fi
  base_sha=$bases
  [[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || die "git merge-base printed '$(clean "$base_sha")', not a commit sha"
  git merge-base --is-ancestor "$base_sha" "$main_tip"
  case $? in
    0) ;;
    1) refuse_pr "base-not-reachable: the base $base_sha is not an ancestor of main's tip $main_tip" ;;
    *) die "git merge-base --is-ancestor failed" ;;
  esac
  git merge-base --is-ancestor "$base_sha" "$head_sha"
  case $? in
    0) ;;
    1) refuse_pr "base-not-reachable: the base $base_sha is not an ancestor of the head $head_sha" ;;
    *) die "git merge-base --is-ancestor failed" ;;
  esac
  cut=$base_sha
  label=$branch
fi

commits=$(git rev-list --reverse "$base_sha..$head_sha") || die "git rev-list $base_sha..$head_sha failed"
[ -n "$commits" ] || refuse_pr "no commits between the base and the head"

echo "release-branch-contents: $label (version $version), cut from main at ${cut:0:12}, main at ${main_tip:0:12}"
echo "judging $(printf '%s\n' "$commits" | grep -c .) commit(s) in ${base_sha:0:12}..${head_sha:0:12}"
echo
# --- The rule (DOR-4638) ----------------------------------------------------
verdict=$(node --experimental-strip-types --disable-warning=ExperimentalWarning \
  "$rule_dir/check-picks.ts" "$repo" "$version" "$base_sha" "$head_sha" "$main_tip")
rule_code=$?
case $rule_code in
  0 | 1) ;;
  *) die "check-picks.ts could not decide (exit $rule_code)" ;;
esac
findings=$(printf '%s' "$verdict" | jq -ce 'if (.ok | type) == "boolean" and (.findings | type) == "array" then .findings else error("bad shape") end') ||
  die 'check-picks.ts printed something that is not its { ok, findings } verdict'
ok=$(printf '%s' "$verdict" | jq -r '.ok')
count=$(printf '%s' "$findings" | jq 'length')
# The rule's own answer must agree with itself and with its exit code.
if { [ "$rule_code" -eq 0 ] && { [ "$ok" != true ] || [ "$count" -ne 0 ]; }; } ||
  { [ "$rule_code" -eq 1 ] && { [ "$ok" != false ] || [ "$count" -eq 0 ]; }; }; then
  die "check-picks.ts exit $rule_code disagrees with its verdict (ok=$ok, $count finding(s))"
fi
# A finding with no commit (no-commits) refuses the whole range.
whole=$(printf '%s' "$findings" | jq -r '[.[] | select(.sha == "")] | first | if . then "\(.code): \(.detail)" else "" end')
[ -z "$whole" ] || refuse_pr "$whole"

# --- Per commit -----------------------------------------------------------
refused=0
pick_line='^\(cherry picked from commit [0-9a-f]{40}\)$'
while IFS= read -r c; do
  [ -n "$c" ] || continue
  subject=$(git log -1 --format=%s "$c") || die "cannot read the subject of $c"
  message=$(git log -1 --format=%B "$c") || die "cannot read the message of $c"
  kind=release
  if printf '%s\n' "$message" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -Eq "$pick_line"; then
    kind=cherry-pick
  fi
  finding=$(printf '%s' "$findings" | jq -r --arg sha "$c" '[.[] | select(.sha == $sha)] | first | if . then "\(.code): \(.detail)" else "" end') ||
    die 'cannot read the findings'
  if [ -n "$finding" ]; then
    add_row "$c" REFUSE "$kind" "$subject" "$finding"
    refused=$((refused + 1))
  elif [ "$kind" = release ]; then
    add_row "$c" PASS release "$subject" "release commit for v$version, release metadata only"
  else
    add_row "$c" PASS cherry-pick "$subject" 'same patch as the main commit it cites'
  fi
done <<<"$commits"

# Every finding must have landed on a commit in the range; one that did not is
# a disagreement about the range, not a pass.
unmatched=$(printf '%s' "$findings" | jq -r '.[].sha' | grep -vxF -f <(printf '%s\n' "$commits") || true)
[ -z "$unmatched" ] || die "check-picks.ts reported commits outside ${base_sha:0:12}..${head_sha:0:12}"

echo
if [ "$refused" -gt 0 ]; then
  write_summary "**Refused:** $refused commit(s) are neither a cherry-pick of main nor the release commit."
  echo "release-branch-contents: REFUSED: $refused commit(s) are neither a cherry-pick of main nor the release commit for v$version." >&2
  exit 1
fi
write_summary '**Passed:** every commit is a cherry-pick of main or the release commit.'
echo "release-branch-contents: ok, every commit is a cherry-pick of main or the release commit for v$version."
