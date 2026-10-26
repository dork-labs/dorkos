#!/bin/sh
# Safe on the operator Mac: private temp folders only.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d /tmp/dorkos-enqueue-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
export DORKOS_APPROVE_SHARED="$tmp/shared" DORKOS_SECURITY_REVIEWS="$tmp/reviews"
mkdir "$tmp/reviews"
a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
printf 'Reviewed head %s\n' "$a" >"$tmp/reviews/pr-12-batch.md"
fail() { echo "FAIL: $1" >&2; exit 1; }
"$here/enqueue.sh" 12 "$a" >/dev/null
"$here/enqueue.sh" 12 "$a" >/dev/null
[ "$(cat "$tmp/shared/queue")" = "12 $a" ] || fail 'queued once'
[ -f "$tmp/shared/reviews/pr-12-batch.md" ] || fail 'review copied for the approver'
for args in "12 $b" "120 $a" "1 $a" "012 $a" "12 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" "12" "12 $a extra-text"; do
  # shellcheck disable=SC2086 # deliberate word splitting into arguments
  if "$here/enqueue.sh" $args >/dev/null 2>&1; then fail "accepted: $args"; fi
done
if "$here/enqueue.sh" "12 $a
13" "$a" >/dev/null 2>&1; then fail 'accepted a newline in the PR'; fi
[ "$(wc -l <"$tmp/shared/queue" | tr -d ' ')" = 1 ] || fail 'refusals left the queue untouched'
ln -s "$tmp/reviews/pr-12-batch.md" "$tmp/reviews/pr-13.md"
if "$here/enqueue.sh" 13 "$a" >/dev/null 2>&1; then fail 'accepted a symlinked review'; fi
echo 'Enqueue tests passed: format, review-names-SHA, dedupe, copy, refusals'
