#!/bin/sh
# Agent side: queue one PR head for Dorian's next `security-approve --batch`.
# This approves nothing. The approver rebuilds every line it shows from GitHub,
# and drops anything moved, unreviewed or sensitive. No Keychain, no GitHub write.
set -eu
pr=${1:-}
sha=${2:-}
shared=${DORKOS_APPROVE_SHARED:-/Users/Shared/dorkos-approve}
reviews=${DORKOS_SECURITY_REVIEWS:-$HOME/.dork/agents/security-auditor/reviews}
usage() { echo 'Usage: enqueue.sh <pr> <40-hex-sha>' >&2; exit 2; }
[ $# -eq 2 ] || usage
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
# The approver user cannot read Dorian's home, so it reads this copy.
cp "$review" "$shared/reviews/$(basename "$review")"
chmod 644 "$shared/reviews/$(basename "$review")"
touch "$shared/queue"
chmod 644 "$shared/queue"
if grep -Fqx "$pr $sha" "$shared/queue"; then
  echo "Already queued: #$pr $sha"
else
  printf '%s %s\n' "$pr" "$sha" >>"$shared/queue"
  echo "Queued: #$pr $sha"
fi
