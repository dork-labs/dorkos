#!/bin/sh
# Agent side (Security). Approves nothing. The approver rebuilds every line it shows
# from GitHub and drops anything moved, off main, unhinted or sensitive.
#   enqueue.sh <pr> <40-hex-sha>   add a reviewed head to Security's own list
#   enqueue.sh --digest            print what Security posts: one `#pr sha12` per line
#                                  plus the list digest; refuses if the shared queue
#                                  differs from Security's own list
#   enqueue.sh --clear             empty both after Dorian's batch run
# The digest is computed from Security's OWN list, never from the shared queue, so a
# line an agent slips into the shared queue changes the helper's digest and not this one.
# No Keychain, no GitHub write.
set -eu
shared=${DORKOS_APPROVE_SHARED:-/Users/Shared/dorkos-approve}
reviews=${DORKOS_SECURITY_REVIEWS:-$HOME/.dork/agents/security-auditor/reviews}
own=${DORKOS_SECURITY_QUEUE:-$HOME/.dork/agents/security-auditor/approve-queue}
max=8

# Same rules as the helper: well-formed lines only, first 8 distinct, sorted bytewise,
# each ending in a newline, SHA-256, first 16 hex in four groups of four.
entries() {
  [ -f "$own" ] || return 0
  grep -E '^[1-9][0-9]{0,6} [0-9a-f]{40}$' "$own" | awk '!seen[$0]++' | head -n "$max"
}
digest() { entries | LC_ALL=C sort | /usr/bin/shasum -a 256 | cut -c1-16 | sed 's/..../& /g; s/ $//'; }
count() { entries | wc -l | tr -d ' '; }

# Rewrite the shared queue from Security's list in one step (temp file, then mv).
publish() {
  mkdir -p "$shared"
  chmod 755 "$shared"
  tmp=$(mktemp "$shared/.queue.XXXXXX")
  entries >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$shared/queue"
}

case ${1:-} in
--digest)
  [ $# -eq 1 ] || exit 2
  if ! entries | cmp -s - "$shared/queue"; then
    echo "Shared queue has lines Security did not queue (or is missing lines). Not posting a digest." >&2
    echo "Run enqueue.sh <pr> <sha> again to republish Security's list, then --digest." >&2
    exit 1
  fi
  entries | while read -r pr sha; do printf '#%s %s\n' "$pr" "$(printf %s "$sha" | cut -c1-12)"; done
  echo "List digest: $(digest) ($(count) queued)"
  exit 0
  ;;
--clear)
  [ $# -eq 1 ] || exit 2
  mkdir -p "$(dirname "$own")"
  : >"$own"
  publish
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
mkdir -p "$shared/reviews" "$(dirname "$own")"
chmod 755 "$shared" "$shared/reviews"
# The approver user cannot read Dorian's home, so it reads this copy. A hint, not proof.
cp "$review" "$shared/reviews/$(basename "$review")"
chmod 644 "$shared/reviews/$(basename "$review")"
touch "$own"
if entries | grep -Fqx "$pr $sha"; then
  echo "Already queued: #$pr $sha"
elif [ "$(count)" -ge "$max" ]; then
  echo "Queue is full ($max). Wait for Dorian's batch, then --clear." >&2
  exit 1
else
  printf '%s %s\n' "$pr" "$sha" >>"$own"
  echo "Queued: #$pr $sha"
fi
publish
echo "Post the output of: enqueue.sh --digest"
