#!/usr/bin/env bash
# The designer's sign-off gate, in one place (PM 2026-11-13 after #3682; DOR-4904). A pull
# request that changes something a person sees needs @designer's `design-ok` label added after its
# head, because the designer checks shots (light, dark, 390) at that exact head. Two callers use
# this file, so the rule can't drift between them:
#   - the local arm script, which reads it from main before every arm (its earlier local copy,
#     design-gate.sh, holds the identical rule until that switch is promoted);
#   - scripts/arm-door.sh, which takes such a head back out of the merge queue when it went in
#     without the label.
#
# Usage:
#   design-ok.sh needs <labels-file> <files-file> <title>
#       labels-file: one label name per line; files-file: the PR's paths, one per line; title:
#       the PR's title. Prints the reason and exits 0 when the gate applies: a user-visible path
#       outside tests and the Dev Playground, or the `needs-design` label (authors add it for
#       server copy the client shows). Exits 1 when it doesn't, including a release PR (title
#       `chore(release)…`: notes and version only, no shots to check). Exits 2 when an input
#       can't be read.
#   design-ok.sh fresh <head-time> <label-time>
#       Exits 0 when the newest `design-ok` label time is after the head time (both ISO-8601
#       UTC, as GitHub writes them); 1 when it is missing or not newer, and says which.
#
# Pure: no network, so it is testable (scripts/test-design-ok.sh).
set -euo pipefail

usage() {
  echo "usage: $0 needs <labels> <files> <title> | fresh <head-time> <label-time>" >&2
  exit 2
}

cmd=${1:-}
shift || :

case "$cmd" in
  needs)
    [ "$#" = 3 ] || usage
    labels=$1 files=$2 title=$3
    for f in "$labels" "$files"; do [ -r "$f" ] || { echo "REFUSE: cannot read $f"; exit 2; }; done
    case "$title" in "chore(release)"*) exit 1 ;; esac
    # Screens and visuals a person sees. Docs prose and server copy aren't matched by path; an
    # author adds `needs-design` for those.
    UI_RE='^(apps/client/src/|apps/site/src/|apps/site/app/|apps/site/components/|apps/desktop/src/renderer/|packages/ui/src/|packages/icons/)'
    # Not user-visible: tests, stories/showcases in the Dev Playground, snapshots.
    SKIP_RE='(/__tests__/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|/__snapshots__/|^apps/client/src/dev/)'
    need=1
    ui=$(grep -E "$UI_RE" "$files" | grep -vE "$SKIP_RE" || true)
    if [ -n "$ui" ]; then
      echo "DESIGN PATHS:"; printf '%s\n' "$ui" | sed 's/^/  /'
      need=0
    fi
    if grep -qx 'needs-design' "$labels"; then
      echo "DESIGN: the PR carries needs-design"
      need=0
    fi
    exit "$need"
    ;;

  fresh)
    [ "$#" = 2 ] || usage
    head_time=$1 label_time=$2
    [ -n "$head_time" ] || { echo "design path, but the head time is unknown"; exit 1; }
    [ -n "$label_time" ] || { echo "design path with no design-ok"; exit 1; }
    # ISO-8601 UTC strings sort as times. Strictly newer: the designer labels after it has the head.
    [[ "$label_time" > "$head_time" ]] \
      || { echo "design-ok ($label_time) is older than the head ($head_time)"; exit 1; }
    echo "design-ok $label_time postdates head $head_time"
    ;;

  *) usage ;;
esac
