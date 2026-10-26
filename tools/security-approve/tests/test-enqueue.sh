#!/bin/sh
# Safe on the operator Mac: private temp folders only.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d /tmp/dorkos-enqueue-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
export DORKOS_APPROVE_SHARED="$tmp/shared" DORKOS_SECURITY_REVIEWS="$tmp/reviews" \
  DORKOS_SECURITY_QUEUE="$tmp/security/approve-queue"
mkdir "$tmp/reviews"
a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
x=dddddddddddddddddddddddddddddddddddddddd
fail() { echo "FAIL: $1" >&2; exit 1; }
printf 'Reviewed head %s\n' "$a" >"$tmp/reviews/pr-1-batch.md"
printf 'Reviewed head %s\n' "$b" >"$tmp/reviews/pr-2.md"

# Queue two reviewed heads; the shared queue is Security's list, published whole.
"$here/enqueue.sh" 2 "$b" >/dev/null
"$here/enqueue.sh" 1 "$a" >/dev/null
"$here/enqueue.sh" 1 "$a" >/dev/null
[ "$(cat "$tmp/security/approve-queue")" = "2 $b
1 $a" ] || fail 'own list keeps each head once'
cmp -s "$tmp/security/approve-queue" "$tmp/shared/queue" || fail 'shared queue published from own list'
[ -f "$tmp/shared/reviews/pr-1-batch.md" ] || fail 'review copied for the approver'
ls "$tmp/shared" | grep -q '^\.queue\.' && fail 'no temp file left behind'

# The digest equals the helper's (PolicyTests pins the same value for these two lines),
# and the post lists each PR with a short SHA.
out=$("$here/enqueue.sh" --digest)
printf '%s\n' "$out" | grep -qx '#2 bbbbbbbbbbbb' || fail 'post lists #2'
printf '%s\n' "$out" | grep -qx '#1 aaaaaaaaaaaa' || fail 'post lists #1'
printf '%s\n' "$out" | grep -qx 'List digest: c0c7 9cf8 1e8d 8eea (2 queued)' || fail 'digest matches the helper'

# M6: an agent appends a well-formed line to the shared queue. Security's digest does not
# include it, and --digest refuses rather than posting.
printf '9 %s\n' "$x" >>"$tmp/shared/queue"
if "$here/enqueue.sh" --digest >/dev/null 2>&1; then fail 'digest posted over an agent-added line'; fi
# The next enqueue republishes Security's list and drops the slipped-in line.
printf 'Reviewed head %s\n' "$x" >"$tmp/reviews/pr-3.md"
"$here/enqueue.sh" 3 "$x" >/dev/null
grep -q '^9 ' "$tmp/shared/queue" && fail 'republish drops the agent line'
"$here/enqueue.sh" --digest >/dev/null || fail 'digest after republish'

# Refusals leave both lists untouched.
before=$(cat "$tmp/security/approve-queue")
for args in "2 $a" "20 $a" "4 $a" "012 $a" "2 BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" "2" "2 $b extra-text"; do
  # shellcheck disable=SC2086 # deliberate word splitting into arguments
  if "$here/enqueue.sh" $args >/dev/null 2>&1; then fail "accepted: $args"; fi
done
if "$here/enqueue.sh" "2 $b
13" "$b" >/dev/null 2>&1; then fail 'accepted a newline in the PR'; fi
[ "$(cat "$tmp/security/approve-queue")" = "$before" ] || fail 'refusals left the list untouched'
ln -s "$tmp/reviews/pr-1-batch.md" "$tmp/reviews/pr-13.md"
if "$here/enqueue.sh" 13 "$a" >/dev/null 2>&1; then fail 'accepted a symlinked review'; fi

# Cap of 8 distinct entries, then clear empties both.
: >"$tmp/security/approve-queue"
for n in 1 2 3 4 5 6 7 8; do printf '%s %s\n' "$n" "$a" >>"$tmp/security/approve-queue"; done
if "$here/enqueue.sh" 2 "$b" >/dev/null 2>&1; then fail 'queued past the cap'; fi
"$here/enqueue.sh" --clear >/dev/null
[ ! -s "$tmp/security/approve-queue" ] && [ ! -s "$tmp/shared/queue" ] || fail 'clear empties both'
echo 'Enqueue tests passed: own list, atomic publish, digest, agent line refused, refusals, cap, clear'
