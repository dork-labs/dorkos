#!/usr/bin/env bash
# Fixture suite for scripts/qa-real-data.sh, QA's real-data gate, shared by the local arm script
# and scripts/arm-door.sh (DOR-4904). Both ways it can be wrong are pinned: a config or migration
# change that slips past QA, and an ordinary change held for a check it doesn't need.
#
#   bash scripts/test-qa-real-data.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
qa_sh=$repo_root/scripts/qa-real-data.sh

if ! command -v jq >/dev/null 2>&1; then
  echo "qa-real-data fixtures: needs jq on PATH" >&2
  exit 2
fi

t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
pass=0
fail=0
ok()  { pass=$(( pass + 1 )); }
bad() { fail=$(( fail + 1 )); echo "FAIL  $1"; }

qa() { # name expect-exit labels files patches
  printf '%b' "$3" > "$t/l"; printf '%b' "$4" > "$t/f"; printf '%b' "$5" > "$t/d"
  out=$(bash "$qa_sh" needs "$t/l" "$t/f" "$t/d"); rc=$?
  [ "$rc" = "$2" ] && ok || bad "$1 (exit $rc, want $2): $out"
}
plain='@@FILE@@ apps/client/src/x.ts\n@@ -1 +1 @@\n+const a = 1;\n'
# DOR-4556: a label alone triggers the freshness check.
qa "label alone triggers the check"            0 'hold\nqa-real-data\n' 'apps/client/src/x.ts\n' "$plain"
qa "no label, no path, no ledger: not needed"   1 'hold\n'               'apps/client/src/x.ts\n' "$plain"
# DOR-4556: the connector upgrade ledger needs qa-real-data.
qa "connector *-upgrade.ts path needs QA"       0 '' 'apps/server/src/services/connectors/access/composio-write-upgrade.ts\n' "$plain"
qa "a new connector upgrade file needs QA"      0 '' 'apps/server/src/services/connectors/access/gmail-scope-upgrade.ts\n' "$plain"
qa "ledger write in any file needs QA"          0 '' 'apps/server/src/services/connectors/boot.ts\n' '@@FILE@@ apps/server/src/services/connectors/boot.ts\n+  tx.insert(connectorApplicationMigrations)\n'
qa "ledger named only in a test: not needed"    1 '' 'apps/server/src/services/connectors/__tests__/a.test.ts\n' '@@FILE@@ apps/server/src/services/connectors/__tests__/a.test.ts\n+  connectorApplicationMigrations\n'
qa "ledger named on a removed line: not needed" 1 '' 'apps/server/src/x.ts\n' '@@FILE@@ apps/server/src/x.ts\n-  connectorApplicationMigrations\n'
# DOR-4568: a file GitHub sent no patch for means QA, unless it is a test or Markdown.
qa "no patch for a big file means QA"           0 '' 'apps/server/src/big.ts\n' '@@FILE@@ apps/server/src/big.ts\n@@NOPATCH@@ apps/server/src/big.ts\n'
qa "no patch for a test file: not needed"       1 '' 'apps/server/src/__tests__/big.test.ts\n' '@@FILE@@ apps/server/src/__tests__/big.test.ts\n@@NOPATCH@@ apps/server/src/__tests__/big.test.ts\n'
qa "no patch for a .md doc: not needed"         1 '' 'contributing/configuration.md\n' '@@FILE@@ contributing/configuration.md\n@@NOPATCH@@ contributing/configuration.md\n'
qa "no patch for a .mdx doc: not needed"        1 '' 'docs/guides/configuration.mdx\n' '@@FILE@@ docs/guides/configuration.mdx\n@@NOPATCH@@ docs/guides/configuration.mdx\n'
qa "no patch: .md beside a big .ts still QA"    0 '' 'contributing/configuration.md\napps/server/src/big.ts\n' '@@FILE@@ contributing/configuration.md\n@@NOPATCH@@ contributing/configuration.md\n@@FILE@@ apps/server/src/big.ts\n@@NOPATCH@@ apps/server/src/big.ts\n'
qa "no patch: .md.ts is code, still QA"         0 '' 'apps/server/src/notes.md.ts\n' '@@FILE@@ apps/server/src/notes.md.ts\n@@NOPATCH@@ apps/server/src/notes.md.ts\n'
qa "no patch: .mdc is not markdown, still QA"   0 '' 'apps/server/src/rules.mdc\n' '@@FILE@@ apps/server/src/rules.mdc\n@@NOPATCH@@ apps/server/src/rules.mdc\n'
# DOR-4568: a patch line can't pose as a file header and hide a later ledger write.
qa "a +++ content line can't flip tests-only"   0 '' 'apps/server/src/__tests__/a.test.ts\napps/server/src/b.ts\n' '@@FILE@@ apps/server/src/b.ts\n+++ b/apps/server/src/__tests__/fake.test.ts\n+  connectorApplicationMigrations\n'

# patches-jq on files-API JSON, then needs (binary adds and pure renames also come with patch
# null, but no additions/deletions; only a large text file means QA).
pj() { # name expect-exit files-api-json
  printf '%s' "$3" > "$t/api.json"
  bash "$qa_sh" patches-jq > "$t/patches.jq" || { bad "$1: patches-jq failed"; return; }
  jq -r -f "$t/patches.jq" "$t/api.json" > "$t/d" || { bad "$1: jq failed"; return; }
  jq -r '.[].filename' "$t/api.json" > "$t/f"; : > "$t/l"
  out=$(bash "$qa_sh" needs "$t/l" "$t/f" "$t/d"); rc=$?
  [ "$rc" = "$2" ] && ok || bad "$1 (exit $rc, want $2): $out"
}
pj "large text file, no patch: QA"        0 '[{"filename":"apps/server/src/big.ts","status":"modified","additions":4000,"deletions":10}]'
pj "binary file added, no patch: no QA"   1 '[{"filename":"docs/img/shot.png","status":"added","additions":0,"deletions":0}]'
pj "pure rename, no patch: no QA"         1 '[{"filename":"apps/client/src/b.ts","status":"renamed","previous_filename":"apps/client/src/a.ts","additions":0,"deletions":0}]'
pj "removed file, no patch: no QA"        1 '[{"filename":"apps/client/src/gone.ts","status":"removed","additions":0,"deletions":30}]'
pj "ledger in a real patch: QA"           0 '[{"filename":"apps/server/src/x.ts","status":"modified","additions":1,"deletions":0,"patch":"@@ -1 +1,2 @@\n+  tx.insert(connectorApplicationMigrations)"}]'

# Big inputs (the pipefail + grep -q trap only shows on big input).
big=$(printf '@@FILE@@ apps/server/src/services/connectors/boot.ts\n+  tx.insert(connectorApplicationMigrations)\n'; for i in $(seq 1 20000); do printf '+const filler%s = "%s";\n' "$i" "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done)
qa "big patch, ledger near the top, needs QA"   0 '' 'apps/server/src/services/connectors/boot.ts\n' "$big"
bigfiles=$(printf 'packages/db/drizzle/0198_x.sql\n'; for i in $(seq 1 6000); do printf 'apps/client/src/a-fairly-long-folder-name/component-number-%s.tsx\n' "$i"; done)
qa "big file list, QA path near the top"        0 '' "$bigfiles" "$plain"

# The path set.
qa "drizzle migration needs QA"                 0 '' 'packages/db/drizzle/0198_x.sql\n' "$plain"
qa "config-manager needs QA"                    0 '' 'apps/server/src/services/core/config-manager.ts\n' "$plain"
qa "a config migration needs QA"                0 '' 'apps/server/src/services/core/config-migrations/0-140-0.ts\n' "$plain"
qa "the config schema needs QA"                 0 '' 'packages/shared/src/config-schema/user.ts\n' "$plain"
qa "a db down migration needs QA"               0 '' 'packages/db/src/down/0198.ts\n' "$plain"
qa "the db backup needs QA"                     0 '' 'packages/db/src/backup.ts\n' "$plain"
qa "core/config/ needs QA"                      0 '' 'apps/server/src/services/core/config/paths.ts\n' "$plain"
qa "config-permissions.ts needs QA"             0 '' 'packages/shared/src/config-permissions.ts\n' "$plain"
qa "the permission upgrade sweep needs QA"      0 '' 'apps/server/src/services/core/permissions/permission-upgrade-sweep.ts\n' "$plain"
qa "db index.ts needs QA"                       0 '' 'packages/db/src/index.ts\n' "$plain"
qa "db migrations-folder.ts needs QA"           0 '' 'packages/db/src/migrations-folder.ts\n' "$plain"
qa "db snapshot-scrub.ts needs QA"              0 '' 'packages/db/src/snapshot-scrub.ts\n' "$plain"
qa "db sql-chunks.ts needs QA"                  0 '' 'packages/db/src/sql-chunks.ts\n' "$plain"
qa "the certificate smoke needs QA"             0 '' 'apps/desktop/scripts/smoke-company-certificates.ts\n' "$plain"
qa "QA path only under __tests__: not needed"   1 '' 'packages/shared/src/config-schema/__tests__/a.test.ts\n' "$plain"
qa "a look-alike path: not needed"              1 '' 'apps/server/src/services/core/config-manager.ts.bak\npackages/db/src/schema/x.ts\n' "$plain"

bash "$qa_sh" needs "$t/missing" "$t/f" "$t/d" >/dev/null; rc=$?
[ "$rc" = 2 ] && ok || bad "unreadable input exits 2 (exit $rc)"
bash "$qa_sh" needs "$t/l" "$t/f" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok || bad "missing argument exits 2 (exit $rc)"

# fresh: strictly newer than the head, as the arm script has always required.
fr() { # name expect-exit head-time label-time
  out=$(bash "$qa_sh" fresh "$3" "$4"); rc=$?
  [ "$rc" = "$2" ] && ok || bad "$1 (exit $rc, want $2): $out"
}
fr "label after the head: fresh"          0 2026-11-21T18:00:00Z 2026-11-21T18:05:00Z
fr "label before the head: stale"         1 2026-11-21T18:00:00Z 2026-11-21T17:55:00Z
fr "label at the head's second: stale"    1 2026-11-21T18:00:00Z 2026-11-21T18:00:00Z
fr "no label: stale"                      1 2026-11-21T18:00:00Z ''
fr "no head time: stale"                  1 ''                   2026-11-21T18:05:00Z
bash "$qa_sh" fresh 2026-11-21T18:00:00Z >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok || bad "fresh with one argument exits 2 (exit $rc)"
bash "$qa_sh" nonsense >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok || bad "unknown subcommand exits 2 (exit $rc)"

echo "qa-real-data fixtures: $pass passed, $fail failed"
[[ "$fail" == 0 ]]
