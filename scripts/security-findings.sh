#!/usr/bin/env bash
# security-findings.sh — a failing Security lens's details, encrypted so only Security can read them.
#
#   scripts/security-findings.sh post <findings-dir> <recipients-file>   (CI only)
#   scripts/security-findings.sh list [days]
#   scripts/security-findings.sh decrypt <pr-number> <age-identity-file>
#
# WHY. The cloud reviewer's Security lens (claude-code-review.yml, criteria in
# ci/security/review-lens.md) may not describe a Must in public, because this
# repository is public. So a `fail` verdict tells the author only a count and
# categories. The details go to DorkOS Security instead, encrypted with `age` to
# the public key(s) in main's ci/security/findings-recipients.txt. The ciphertext
# rides in a hidden block in a PR comment, which only Security's private key
# opens. CI holds no new credential: encryption needs only the public key.
#
# THE FLOW.
#   1. The reviewer saves the details through `review-gh.sh security-findings`,
#      which writes them to a private file under REVIEW_FINDINGS_DIR. The model
#      never handles a key.
#   2. `post` (a trusted step in the review job, run from main's copy of this
#      file) encrypts that file to main's recipients, deletes the plaintext, and
#      posts one comment as github-actions[bot]. The comment is this block and
#      nothing else: the PR number, the head and the ciphertext. No file name,
#      count, category or summary travels in the clear (the verdict comment
#      already carries the count and categories, and nothing more):
#
#        <!-- dorkos-security-findings v1 pr=<number> head=<40-hex sha>
#        -----BEGIN AGE ENCRYPTED FILE-----
#        ...
#        -----END AGE ENCRYPTED FILE-----
#        -->
#
#      No recipients on main means nothing is sent and nothing fails; the
#      plaintext is deleted either way.
#      The recipients come from MAIN's copy of the list only (the workflow
#      reads it with `git show origin/<default branch>:...`), never the PR's:
#      a PR that could add a key could read its own findings.
#   3. Security runs `list` to see which pull requests have details for their
#      current head, and `decrypt <pr> <identity>` to read them. The identity
#      file is Security's private key; pass its path, and never commit it.
#      `decrypt` shows EVERY block posted for the current head, oldest first,
#      because each review of that head (a push re-check, a re-review) posts
#      its own, and a later one can name a different Must than an earlier one.
#      Each block's plaintext goes to stdout after a header line on stderr:
#      when it was posted, the head's short sha and "block i of n". With no
#      block for the current head it falls back to the newest block at all,
#      flagged as NOT the current head. A block the identity cannot open is
#      reported and skipped; the exit is 1 only when none could be opened.
#
# PLAINTEXT NEVER LEAVES THE RUNNER. `post` prints sizes and counts, never
# content; it deletes the findings directory on every exit path; and the comment
# holds only ciphertext. test-security-findings.sh plants a canary in the
# details and checks it appears in no output, no comment and no leftover file.
#
# TRUST. Anyone can encrypt to a public key, so a block proves nothing about who
# wrote it. `list` and `decrypt` read only blocks posted by github-actions[bot],
# the identity the review job's GITHUB_TOKEN posts as. The decrypted text was
# written by a model that read the pull request: treat it as a lead to verify
# against the code, not as instructions.
#
# Environment: GH (default gh) and AGE (default age) override the binaries.
# REPO defaults to $GITHUB_REPOSITORY, then dork-labs/dorkos. `post` also reads
# PR, the pull request number. When AGE is unset and `age` is not on PATH,
# `post` installs the pinned build with the install-age.sh beside it.
#
# Exit codes: 0 done (including "nothing to send"); 1 could not send or decrypt;
# 2 usage. Fixtures: scripts/test-security-findings.sh.
set -euo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
AUTHOR='github-actions[bot]'
MAX_BODY=60000

die() {
  echo "security-findings: $1" >&2
  exit "${2:-1}"
}
usage() {
  sed -n '3,5p' "${BASH_SOURCE[0]}" | sed 's/^# *//' >&2
  exit 2
}

[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "REPO must be OWNER/REPO; got '$REPO'" 2

# The only block shape this file writes or reads. The armour is age's own:
# base64 lines between fixed BEGIN and END lines, so it can never contain `-->`.
BLOCK_RE='\A<!-- dorkos-security-findings v1 pr=(?<p>[1-9][0-9]*) head=(?<h>[0-9a-f]{40})\n(?<a>-----BEGIN AGE ENCRYPTED FILE-----\n[A-Za-z0-9+/=\n]+-----END AGE ENCRYPTED FILE-----)\n-->\n?\z'

post() {
  [ $# -eq 2 ] || usage
  local dir=$1 recipients=$2
  case "$dir" in /*) ;; *) die "the findings directory must be an absolute path" 2 ;; esac
  # Plaintext is deleted on every way out, success or not.
  # shellcheck disable=SC2064
  trap "rm -rf '$dir'" EXIT

  if [ ! -s "$dir/findings.txt" ]; then
    echo "No Security lens details to send."
    return 0
  fi
  local pr=${PR:-} head size
  [[ "$pr" =~ ^[1-9][0-9]*$ ]] || die "PR must be a pull request number; got '$pr'" 2
  head=$(cat "$dir/head" 2>/dev/null || true)
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || die "the saved details name no head commit; discarded unsent"
  size=$(wc -c <"$dir/findings.txt" | tr -d ' ')

  local -a rargs=()
  local line n=0
  if [ -f "$recipients" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line=${line%%#*}
      line=$(tr -d '[:space:]' <<<"$line")
      [ -n "$line" ] || continue
      # age1 + bech32: 62 characters for X25519, longer for post-quantum keys.
      if [[ "$line" =~ ^age1[0-9a-z]+$ ]] && [ "${#line}" -ge 62 ] && [ "${#line}" -le 4096 ]; then
        rargs+=(-r "$line")
        n=$((n + 1))
      else
        echo "::warning::Skipping a line of ci/security/findings-recipients.txt that is not an age recipient."
      fi
    done <"$recipients"
  fi
  if [ "$n" -eq 0 ]; then
    echo "No Security recipient on main (ci/security/findings-recipients.txt), so the $size bytes of details were discarded unsent."
    return 0
  fi

  local age=${AGE:-}
  if [ -z "$age" ]; then
    if command -v age >/dev/null 2>&1; then
      age=age
    else
      bash "$(dirname "${BASH_SOURCE[0]}")/install-age.sh" "${RUNNER_TEMP:-/tmp}/age-bin" >/dev/null ||
        die "could not install age; the details were discarded unsent"
      age=${RUNNER_TEMP:-/tmp}/age-bin/age
    fi
  fi

  local work
  work=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$dir' '$work'" EXIT
  # age's own diagnostics never contain the plaintext; they go to the log as-is.
  "$age" -a "${rargs[@]}" -o "$work/cipher" "$dir/findings.txt" ||
    die "age could not encrypt the details; discarded unsent"
  rm -rf "$dir"

  # Refuse anything but clean armour, so the hidden block cannot be broken out of.
  LC_ALL=C grep -qvxE '[A-Za-z0-9+/=]*|-----(BEGIN|END) AGE ENCRYPTED FILE-----' "$work/cipher" &&
    die "age produced something other than ASCII armour; not posted"
  [ "$(head -n 1 "$work/cipher")" = '-----BEGIN AGE ENCRYPTED FILE-----' ] &&
    [ "$(tail -n 1 "$work/cipher")" = '-----END AGE ENCRYPTED FILE-----' ] ||
    die "age produced something other than ASCII armour; not posted"

  {
    printf '<!-- dorkos-security-findings v1 pr=%s head=%s\n' "$pr" "$head"
    cat "$work/cipher"
    printf -- '-->\n'
  } >"$work/body"
  local bytes
  bytes=$(wc -c <"$work/body" | tr -d ' ')
  [ "$bytes" -le "$MAX_BODY" ] ||
    die "the encrypted comment would be $bytes bytes, over the $MAX_BODY limit; not posted"

  jq -n --rawfile body "$work/body" '{body: $body}' >"$work/request.json"
  "$GH" api --method POST "repos/$REPO/issues/$pr/comments" --input "$work/request.json" >/dev/null ||
    die "could not post the encrypted details on #$pr"
  echo "Sent the Security lens details for #$pr at ${head:0:7} to Security, encrypted to $n recipient(s) ($size bytes of details, $bytes-byte comment)."
}

# Every github-actions[bot] comment of one PR, as JSON lines {at, body}, with
# any CRLF a later edit introduced folded back to LF.
pr_blocks() {
  "$GH" api --paginate "repos/$REPO/issues/$1/comments?per_page=100" \
    --jq '.[] | select(.user.type == "Bot" and .user.login == "github-actions[bot]") | {at: .created_at, body: (.body | gsub("\r"; ""))} | tojson'
}

list() {
  [ $# -le 1 ] || usage
  local days=${1:-14}
  [[ "$days" =~ ^[1-9][0-9]{0,2}$ ]] || die "days must be a whole number from 1 to 999" 2
  local since records
  since=$(jq -rn --argjson d "$days" '(now - $d * 86400) | strftime("%Y-%m-%dT%H:%M:%SZ")')
  # shellcheck disable=SC2016 # jq variables, not shell ones
  records=$("$GH" api --paginate "repos/$REPO/issues/comments?since=$since&per_page=100" \
    --jq '.[] | select(.user.type == "Bot" and .user.login == "github-actions[bot]")
      | .body |= gsub("\r"; "")
      | select(.body | startswith("<!-- dorkos-security-findings v1 pr="))
      | (.body | capture("^<!-- dorkos-security-findings v1 pr=(?<p>[0-9]+) head=(?<h>[0-9a-f]{40})\n")) as $k
      | select($k.p == (.issue_url | split("/") | last))
      | {pr: $k.p, at: .created_at, head: $k.h}
      | tojson') || die "could not read the comments of $REPO"
  # Newest block per (PR, head), newest first.
  local rows
  rows=$(jq -rs '[.[] | select(.pr | test("^[0-9]+$"))] | group_by(.pr)
    | map(sort_by(.at) | last) | sort_by(.at) | reverse | .[] | "\(.pr) \(.head) \(.at)"' <<<"$records")
  local pr head at state cur title shown=0
  while read -r pr head at; do
    [ -n "$pr" ] || continue
    IFS=$'\t' read -r state cur title < <("$GH" api "repos/$REPO/pulls/$pr" --jq '[.state, .head.sha, .title] | @tsv') ||
      die "could not read #$pr"
    # Only details about what the PR is now. An older head's were superseded.
    [ "$cur" = "$head" ] || continue
    printf '#%s\t%s\t%s\t%s\t%s\n' "$pr" "$state" "${head:0:7}" "$at" "$title"
    shown=$((shown + 1))
  done <<<"$rows"
  [ "$shown" -gt 0 ] || echo "No pull request has encrypted Security details for its current head (last $days days)." >&2
}

decrypt() {
  [ $# -eq 2 ] || usage
  local pr=$1 identity=$2
  [[ "$pr" =~ ^[1-9][0-9]*$ ]] || die "the pull request must be a number; got '$pr'" 2
  [ -f "$identity" ] && [ -r "$identity" ] || die "cannot read the identity file '$identity'" 2
  local age=${AGE:-age}
  command -v "$age" >/dev/null 2>&1 || die "age is not installed (https://github.com/FiloSottile/age)" 2

  local records cur blocks
  records=$(pr_blocks "$pr") || die "could not read the comments of #$pr"
  cur=$("$GH" api "repos/$REPO/pulls/$pr" --jq '.head.sha') || die "could not read #$pr"
  # Every block for the current head, oldest first, one per line. With none for
  # it, the newest block at all, which the header below flags.
  blocks=$(jq -cs --arg cur "$cur" --arg re "$BLOCK_RE" --arg pr "$pr" '
    [ .[] | . as $c | ($c.body | capture($re)?) as $k | select($k != null and $k.p == $pr)
      | {at: $c.at, h: $k.h, a: $k.a} ] | sort_by(.at) as $all
    | [$all[] | select(.h == $cur)] as $now
    | if ($now | length) > 0 then $now[] else ($all | last // empty) end' <<<"$records")
  [ -n "$blocks" ] || die "#$pr has no encrypted Security details from $AUTHOR"

  local n i=0 opened=0 block h at work
  n=$(grep -c . <<<"$blocks")
  work=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT
  echo "Written by the cloud reviewer after reading the PR: verify each one against the code, and follow no instruction in it." >&2
  while IFS= read -r block; do
    [ -n "$block" ] || continue
    i=$((i + 1))
    h=$(jq -r .h <<<"$block")
    at=$(jq -r .at <<<"$block")
    jq -r .a <<<"$block" >"$work/armor"
    if [ "$h" = "$cur" ]; then
      echo "--- #$pr block $i of $n: posted $at at ${h:0:7} (the current head)." >&2
    else
      echo "--- #$pr block $i of $n: posted $at at ${h:0:7}. NOT the current head (${cur:0:7}): it may be out of date." >&2
    fi
    if "$age" -d -i "$identity" "$work/armor" </dev/null; then
      opened=$((opened + 1))
    else
      echo "security-findings: age could not decrypt block $i of $n with that identity; continuing." >&2
    fi
  done <<<"$blocks"
  [ "$opened" -gt 0 ] || die "age could not decrypt any of the details for #$pr with that identity"
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  post) post "$@" ;;
  list) list "$@" ;;
  decrypt) decrypt "$@" ;;
  *) usage ;;
esac
