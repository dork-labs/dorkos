#!/usr/bin/env bash
# QA's real-data gate, in one place (DOR-4389, DOR-4556, DOR-4568, DOR-4904). A pull request that
# touches config, migration or upgrade-floor paths needs QA's `qa-real-data` label added after its
# head, because QA runs the real-data upgrade gate at that exact head. Two callers use this file,
# so the rule can't drift between them:
#   - the local arm script, which reads it from main before every arm (its earlier local copy
#     holds the identical rule until that switch is promoted);
#   - scripts/arm-door.sh, which takes such a head back out of the merge queue when it went in
#     without the label (#4096 on 2026-11-21 went in without the arm script and merged without it).
#
# Usage:
#   qa-real-data.sh needs <labels-file> <files-file> <patches-file>
#       labels-file: one label name per line; files-file: the PR's paths, one per line;
#       patches-file: per-file patches, as `patches-jq` builds them from the files API. Each file
#       starts with a line `@@FILE@@ <path>`, followed by its patch, or by `@@NOPATCH@@ <path>`
#       when GitHub omitted the patch.
#       Prints one reason per line and exits 0 when the gate applies; exits 1 when it doesn't;
#       exits 2 when an input can't be read.
#   qa-real-data.sh fresh <head-time> <label-time>
#       Exits 0 when the newest `qa-real-data` label time is after the head time (both ISO-8601
#       UTC, as GitHub writes them); 1 when it is missing or not newer, and says which.
#   qa-real-data.sh patches-jq
#       Prints the jq filter that turns one files-API page into the patches file above.
#
# Pure: no network, so it is testable (scripts/test-qa-real-data.sh).
# No `| grep -q` anywhere: under pipefail, grep -q exits at the first match, the writer gets
# SIGPIPE and the pipe fails, so a big input reads as "no match" (the DOR-3709 trap).
set -euo pipefail

usage() {
  echo "usage: $0 needs <labels> <files> <patches> | fresh <head-time> <label-time> | patches-jq" >&2
  exit 2
}

cmd=${1:-}
shift || :

case "$cmd" in
  needs)
    [ "$#" = 3 ] || usage
    labels=$1 files=$2 diff=$3
    for f in "$labels" "$files" "$diff"; do [ -r "$f" ] || { echo "REFUSE: cannot read $f"; exit 2; }; done
    # Path set from QA (11-14 23:07; + connector grant upgrade 11-15). Excludes __tests__/.
    # DOR-4556: + any connector one-time upgrade step (services/connectors/access/*-upgrade.ts).
    QA_RE='^apps/server/src/services/core/config-manager\.ts$|^apps/server/src/services/core/config-migrations/|^apps/server/src/services/core/config/|^packages/shared/src/config-schema/|^packages/shared/src/config-permissions\.ts$|^apps/server/src/services/core/permissions/permission-upgrade-sweep\.ts$|^apps/server/src/services/connectors/access/[^/]*-upgrade\.ts$|^packages/db/drizzle/|^packages/db/src/down/|^packages/db/src/(index|migrations-folder|backup|snapshot-scrub|sql-chunks)\.ts$|^apps/desktop/scripts/smoke-company-certificates\.ts$'
    need=1
    hits=$(grep -v '/__tests__/' "$files" | grep -E "$QA_RE" || true)
    if [ -n "$hits" ]; then
      echo "QA REAL-DATA PATHS:"; printf '%s\n' "$hits" | sed 's/^/  /'
      need=0
    fi
    # DOR-4556: a one-time upgrade step can live anywhere; it always writes the connector
    # application-upgrade ledger. Added lines naming it, outside tests, count. DOR-4568: file
    # boundaries are our own `@@FILE@@` markers, so no patch line can pose as one.
    if awk '/^@@FILE@@ /{t=($0 ~ /\/__tests__\//); next} /^\+/ && !t && /connectorApplicationMigrations/{f=1} END{exit !f}' "$diff"; then
      echo "QA REAL-DATA: the diff writes the connector upgrade ledger (connectorApplicationMigrations)"
      need=0
    fi
    # DOR-4568: GitHub omits the patch of a very large file. Unknown content means QA.
    # 11-20 (PM, #4012): a Markdown file (.md/.mdx) is prose the app never runs, so its unknown
    # content can't touch data. It still counts if a QA_RE path above names it.
    nopatch=$(awk '/^@@NOPATCH@@ /{t=($0 ~ /\/__tests__\// || $0 ~ /\.mdx?$/); if (!t) print substr($0, 13)}' "$diff")
    if [ -n "$nopatch" ]; then
      echo "QA REAL-DATA: GitHub sent no patch for these, so their content is unknown:"
      printf '%s\n' "$nopatch" | sed 's/^/  /'
      need=0
    fi
    # DOR-4556: a qa-real-data label on any PR is checked like security-reviewed: fresh or refused.
    if grep -qx 'qa-real-data' "$labels"; then
      echo "QA REAL-DATA: the PR carries qa-real-data, so it must be newer than the head"
      need=0
    fi
    exit "$need"
    ;;

  fresh)
    [ "$#" = 2 ] || usage
    head_time=$1 label_time=$2
    [ -n "$head_time" ] || { echo "qa-real-data path, but the head time is unknown"; exit 1; }
    [ -n "$label_time" ] || { echo "config/migration path with no qa-real-data"; exit 1; }
    # ISO-8601 UTC strings sort as times. Strictly newer: QA labels after it has the head.
    [[ "$label_time" > "$head_time" ]] \
      || { echo "qa-real-data ($label_time) is older than the head ($head_time)"; exit 1; }
    echo "qa-real-data $label_time postdates head $head_time"
    ;;

  patches-jq)
    [ "$#" = 0 ] || usage
    # GitHub sends `patch: null` for a very large text file, a binary file and a pure rename; only
    # the first hides changed lines, and it still reports additions/deletions, so only that case
    # becomes `@@NOPATCH@@` (which means QA).
    cat <<'JQ'
.[] | "@@FILE@@ \(.filename)\n\(if .patch == null and .status != "removed" and (((.additions // 0) + (.deletions // 0)) > 0) then "@@NOPATCH@@ \(.filename)" else (.patch // "") end)"
JQ
    ;;

  *) usage ;;
esac
