#!/usr/bin/env bash
# The first job of every release workflow (DOR-4030): may this run's commit be
# built, signed or published?
#
# Two ways in, and nothing else:
#
#   (a) the commit is on main (today's releases);
#   (b) the run is for tag vX.Y.Z, the tag's commit is exactly the run-time tip
#       of release/vX.Y.Z, and that branch passes MAIN's release-branch check
#       (scripts/ci/release-branch-contents.sh over main's
#       packages/cli/scripts/release-branch/check-picks.ts, DOR-4638/4639).
#       Releases ship from short-lived release branches (DOR-4636), so their
#       tags sit on the branch, not on main.
#
# EVERY PIECE COMES FROM MAIN. The workflows extract this script from
# origin/main into $RUNNER_TEMP and run it there, never from the tagged commit,
# and path (b) extracts main's copy of the release-branch check the same way,
# before anything from the tag is checked out, and runs it with no install. A
# local composite action would load from the tag's own commit (Security).
#
# WHERE IT BINDS. In a run of main's own workflow file, dispatched on main
# with a tag input (every job that holds an environment secret, DOR-4030), it
# is main's code checking a commit passed in as data, so it binds that run. On
# a tag push (only publish-community.yml, until its release identity moves to
# main in a separate PR) the workflow YAML itself comes from the tagged commit,
# so a tag on an arbitrary commit with an edited workflow can skip this step;
# there it is defense in depth only, which is why no tag-push job holds an
# environment secret. Either way the lock on the secrets is the environments' required
# reviewer (DOR-4036) and the tag and release-branch rulesets.
#
# FAILS CLOSED. Exit 0 lets the run go on. Anything else refuses: exit 1 for
# "no", exit 2 for "cannot decide" (bad arguments, git errors, main without the
# release-branch check yet). Path (b) refuses until #4024 and #4025 put that
# check on main.
#
# Usage, from a clone whose `origin` is this repository:
#   tag-is-on-main.sh --dir <clone> --sha <commit> --ref <github.ref> \
#     --what <"Images are published"> [--summary <file>]
#
# UNTRUSTED INPUT. The ref and the sha arrive as arguments from `env:`, never
# `${{ }}` inside `run:`, and are validated before git sees them.
#
# Pinned by scripts/test-tag-is-on-main.sh.

set -uo pipefail

dir=''
sha=''
ref=''
what='This run continues'
summary=${GITHUB_STEP_SUMMARY:-}

die() {
  echo "::error::tag-is-on-main: $*" >&2
  exit 2
}
refuse() {
  echo "::error::$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) [ $# -ge 2 ] || die 'usage'; dir=$2; shift 2 ;;
    --sha) [ $# -ge 2 ] || die 'usage'; sha=$2; shift 2 ;;
    --ref) [ $# -ge 2 ] || die 'usage'; ref=$2; shift 2 ;;
    --what) [ $# -ge 2 ] || die 'usage'; what=$2; shift 2 ;;
    --summary) [ $# -ge 2 ] || die 'usage'; summary=$2; shift 2 ;;
    *) die "unknown argument" ;;
  esac
done
[ -n "$dir" ] && [ -n "$sha" ] && [ -n "$ref" ] ||
  die 'usage: tag-is-on-main.sh --dir <clone> --sha <commit> --ref <ref> --what <text>'
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die 'the commit is not a full sha'
[[ "$ref" =~ ^refs/(heads|tags)/[A-Za-z0-9._/-]+$ ]] || die 'the ref is not a plain branch or tag'
git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || die 'the clone directory is not a git repository'

g() { git -C "$dir" "$@"; }

note() {
  echo "$1"
  if [ -n "$summary" ]; then echo "$1" >>"$summary" || die 'cannot write the summary'; fi
}

g fetch -q --no-tags origin "+refs/heads/main:refs/remotes/origin/main" "$sha" ||
  die 'cannot fetch main and the run commit'

# --- (a) On main -----------------------------------------------------------
g merge-base --is-ancestor "$sha" refs/remotes/origin/main
case $? in
  0)
    note "\`${sha}\` is on main."
    exit 0
    ;;
  1) ;;
  *) die 'git merge-base --is-ancestor failed' ;;
esac

# --- (b) A release tag on its release branch's tip ---------------------------
semver='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
if [[ ! "$ref" =~ ^refs/tags/v${semver}$ ]]; then
  refuse "${sha} (${ref}) is not on main, and only a v<X.Y.Z> tag can come from a release branch. ${what} only from commits on main or a checked release branch; nothing was done."
fi
version="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
tag="v${version}"
branch="release/v${version}"

g fetch -q --no-tags origin "+refs/tags/${tag}:refs/tags/${tag}" ||
  refuse "cannot read tag ${tag}; nothing was done."
tag_commit=$(g rev-parse --verify --quiet "refs/tags/${tag}^{commit}") ||
  refuse "tag ${tag} does not name a commit; nothing was done."
[ "$tag_commit" = "$sha" ] ||
  refuse "tag ${tag} is at ${tag_commit}, not this run's ${sha}; nothing was done."

# Main's copy of the check, before anything from the tag. Until #4024 and #4025
# merge there is none, and this refuses.
if ! g cat-file -e refs/remotes/origin/main:scripts/ci/release-branch-contents.sh 2>/dev/null ||
  ! g cat-file -e refs/remotes/origin/main:packages/cli/scripts/release-branch/check-picks.ts 2>/dev/null; then
  refuse "${sha} is not on main, and main has no release-branch check yet to accept ${branch} by. ${what} only from commits on main; nothing was done."
fi
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/tag-is-on-main.XXXXXX") || die 'cannot make a temp folder'
g show refs/remotes/origin/main:scripts/ci/release-branch-contents.sh >"$work/release-branch-contents.sh" ||
  die "cannot read main's release-branch-contents.sh"
mkdir -p "$work/release-branch" || die 'cannot make the rule folder'
g archive refs/remotes/origin/main packages/cli/scripts/release-branch |
  tar -x -C "$work/release-branch" --strip-components=4 ||
  die "cannot read main's release-branch rule"

# The script checks the head is the branch's run-time tip, the version matches
# the branch, the base is on main and reachable, then main's check-picks.ts.
extra=()
[ -z "$summary" ] || extra=(--summary "$summary")
(cd "$dir" && bash "$work/release-branch-contents.sh" \
  --rule-dir "$work/release-branch" \
  --branch "$branch" \
  --version "$version" \
  --head-sha "$sha" \
  --remote origin \
  ${extra[@]+"${extra[@]}"})
code=$?
case $code in
  0)
    note "\`${tag}\` is the tip of \`${branch}\`, which passed main's release-branch check."
    exit 0
    ;;
  1) refuse "${tag} (${sha}) is not on main, and ${branch} did not pass main's release-branch check. ${what} only from commits on main or a checked release branch; nothing was done." ;;
  *) refuse "${tag} (${sha}) is not on main, and main's release-branch check could not decide (exit ${code}). Nothing was done." ;;
esac
