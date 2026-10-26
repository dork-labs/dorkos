#!/bin/sh
# Agent side (Security). Approves nothing. The approver rebuilds every line it shows
# from GitHub and drops anything moved, off main, unhinted or sensitive.
#   enqueue.sh <pr> <40-hex-sha>   queue one reviewed head, then print the list digest
#   enqueue.sh --digest            print the digest Dorian must see before he confirms
#   enqueue.sh --clear             empty the queue after Dorian's batch run
# Post the digest in #dorkos. If the batch shows a different one, Dorian stops: someone
# else added a line. No Keychain, no GitHub write.
set -eu
shared=${DORKOS_APPROVE_SHARED:-/Users/Shared/dorkos-approve}
reviews=${DORKOS_SECURITY_REVIEWS:-$HOME/.dork/agents/security-auditor/reviews}
max=8

# Same rules as the helper: well-formed lines only, first 8 distinct, sorted bytewise,
# each ending in a newline, SHA-256, first 12 hex.
entries() {
  [ -f "$shared/queue" ] || return 0
  grep -E '^[1-9][0-9]{0,6} [0-9a-f]{40}$' "$shared/queue" | awk '!seen[$0]++' | head -n "$max"
}
digest() { entries | LC_ALL=C sort | /usr/bin/shasum -a 256 | cut -c1-12; }

case ${1:-} in
--digest)
  [ $# -eq 1 ] || exit 2
  echo "List digest: $(digest) ($(entries | wc -l | tr -d ' ') queued)"
  exit 0
  ;;
--clear)
  [ $# -eq 1 ] || exit 2
  : >"$shared/queue"
  echo 'Queue cleared'
  exit 0
  ;;
esac

usage() { echo 'Usage: enqueue.sh <pr> <40-hex-sha> | --digest | --clear' >&2; exit 2; }
[ $# -eq 2 ] || usage
pr=$1
sha=$2
case $pr in '' | 0* | *[!0-9]*) usage ;; esac
[ ${#pr} -le 7 ] || usage
case $sha in *[!0-9a-f]*) usage ;; esac
[ ${#sha} -eq 40 ] || usage
review=
for file in "$reviews/pr-$pr.md" "$reviews/pr-$pr"[!0-9]*.md; do
  if [ -f "$file" ] && [ ! -L "$file" ] && grep -Fq "$sha" "$file"; then review=$file; break; fi
done
[ -n "$review" ] || { echo "No review file pr-$pr*.md names $sha; not queued" >&2; exit 1; }
mkdir -p "$shared/reviews"
chmod 755 "$shared" "$shared/reviews"
# The approver user cannot read Dorian's home, so it reads this copy. A hint, not proof.
cp "$review" "$shared/reviews/$(basename "$review")"
chmod 644 "$shared/reviews/$(basename "$review")"
touch "$shared/queue"
chmod 644 "$shared/queue"
if entries | grep -Fqx "$pr $sha"; then
  echo "Already queued: #$pr $sha"
elif [ "$(entries | wc -l | tr -d ' ')" -ge "$max" ]; then
  echo "Queue is full ($max). Wait for Dorian's batch, then --clear." >&2
  exit 1
else
  printf '%s %s\n' "$pr" "$sha" >>"$shared/queue"
  echo "Queued: #$pr $sha"
fi
echo "List digest: $(digest) ($(entries | wc -l | tr -d ' ') queued)"
