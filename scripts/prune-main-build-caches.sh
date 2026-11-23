#!/usr/bin/env bash
# Deletes main's older turbo build caches, keeping the newest few of each
# family (DOR-4627, ledger 261123-194610-build-cache-per-merge).
#
# WHY. build-cache.yml saves `turbo-test-builds-*` and `turbo-browser-builds-*`
# on `refs/heads/main` after every merge, each key ending in that merge's SHA,
# so every merge adds a new entry. GitHub never replaces an entry and keeps one
# for 7 days unread, and the repository is already near its 10 GB budget. Left
# alone, about 45 merges a day would push LRU eviction onto main's pnpm stores.
# A restore takes the newest entry its key prefix matches (the same lockfile
# first, then any), so once newer entries exist the older ones are dead weight.
# KEEP (3) leaves a margin for a run still downloading the one before.
#
# WHAT IT TOUCHES. Only caches on `refs/heads/main` whose key starts with one of
# the two families named below, and only entries older than the newest KEEP of
# that family by creation time. Never a pnpm store, a Playwright cache, another
# ref, or a family it does not name: the list is fixed here, not an argument,
# so a caller cannot point it at anything else. The API's `key` filter is a
# prefix match; each key is checked again here before anything is deleted.
#
# EXIT. 1 when a listing fails (nothing is deleted for that family). A failed
# delete is a warning: another run may have deleted the same entry first.
#
# Usage:
#   GH_REPO=owner/repo [KEEP=3] scripts/prune-main-build-caches.sh
#
# GH stays overridable so scripts/test-prune-main-build-caches.sh can stub gh.

set -uo pipefail

gh=${GH:-gh}
keep=${KEEP:-3}
ref=refs/heads/main
families=(turbo-test-builds- turbo-browser-builds-)

case "$keep" in
  '' | *[!0-9]* | 0)
    echo "prune-main-build-caches: KEEP must be a whole number of at least 1, not '$keep'." >&2
    exit 1
    ;;
esac
[ -n "${GH_REPO:-}" ] || {
  echo 'prune-main-build-caches: GH_REPO is not set.' >&2
  exit 1
}

status=0
deleted=0
bytes=0
for family in "${families[@]}"; do
  # Newest first, every page, read in full before the first delete so a delete
  # cannot shift a page under the listing.
  if ! entries=$($gh api --paginate \
    "repos/$GH_REPO/actions/caches?per_page=100&ref=$ref&key=$family&sort=created_at&direction=desc" \
    --jq '.actions_caches[] | "\(.id)\t\(.size_in_bytes)\t\(.ref)\t\(.created_at)\t\(.key)"'); then
    echo "::error title=Build caches not listed::$family on $ref could not be listed, so none of it was pruned."
    status=1
    continue
  fi
  # The API sorts, but the order this keeps is decided here, by created_at,
  # so a page boundary or an ignored sort parameter cannot make it keep the
  # wrong ones. ISO-8601 UTC sorts as text.
  entries=$(printf '%s\n' "$entries" | sed '/^$/d' | sort -t $'\t' -k4,4r)
  seen=0
  while IFS=$'\t' read -r id size entry_ref created key; do
    [ -n "${id:-}" ] || continue
    if [ "$entry_ref" != "$ref" ] || [ "${key#"$family"}" = "$key" ]; then
      echo "skip $key on $entry_ref (not a $family entry on $ref)"
      continue
    fi
    seen=$((seen + 1))
    if [ "$seen" -le "$keep" ]; then
      echo "keep $key ($created)"
      continue
    fi
    if $gh api -X DELETE "repos/$GH_REPO/actions/caches/$id" >/dev/null </dev/null; then
      echo "deleted $key ($created, $((size / 1048576)) MB)"
      deleted=$((deleted + 1))
      bytes=$((bytes + size))
    else
      echo "::warning title=Build cache not deleted::$key (id $id) could not be deleted; another run may have deleted it first."
    fi
  done <<<"$entries"
done

echo "Pruned $deleted older build cache(s) on $ref, $((bytes / 1048576)) MB; kept the newest $keep of each family."
exit "$status"
