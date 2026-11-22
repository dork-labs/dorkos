#!/usr/bin/env bash
# Fixture suite for scripts/design-ok.sh, the designer's sign-off gate, shared by the local arm
# script and scripts/arm-door.sh (DOR-4904). Both ways it can be wrong are pinned: a screen change
# that slips past the designer, and a non-visual change held for shots it doesn't have.
#
#   bash scripts/test-design-ok.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
gate=$repo_root/scripts/design-ok.sh

t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
pass=0
fail=0
ok()  { pass=$(( pass + 1 )); }
bad() { fail=$(( fail + 1 )); echo "FAIL  $1"; }

dz() { # name expect-exit labels files [title]
  printf '%b' "$3" > "$t/l"; printf '%b' "$4" > "$t/f"
  out=$(bash "$gate" needs "$t/l" "$t/f" "${5:-fix(x): a made-up change}"); rc=$?
  [ "$rc" = "$2" ] && ok || bad "$1 (exit $rc, want $2): $out"
}
# Every path in the set.
dz "client source needs design"              0 '' 'apps/client/src/layers/features/x/ui/X.tsx\n'
dz "site src needs design"                   0 '' 'apps/site/src/lib/x.ts\n'
dz "site app needs design"                   0 '' 'apps/site/app/page.tsx\n'
dz "site components need design"             0 '' 'apps/site/components/hero.tsx\n'
dz "desktop renderer needs design"           0 '' 'apps/desktop/src/renderer/index.tsx\n'
dz "packages/ui needs design"                0 '' 'packages/ui/src/button.tsx\n'
dz "packages/icons needs design"             0 '' 'packages/icons/svg/x.svg\n'
# What is not user-visible.
dz "server code: not needed"                 1 '' 'apps/server/src/x.ts\n'
dz "a client test: not needed"               1 '' 'apps/client/src/layers/features/x/__tests__/X.test.tsx\n'
dz "a .spec file: not needed"                1 '' 'packages/ui/src/button.spec.tsx\n'
dz "a snapshot: not needed"                  1 '' 'apps/client/src/x/__snapshots__/X.snap\n'
dz "the Dev Playground: not needed"          1 '' 'apps/client/src/dev/sections/X.tsx\n'
dz "a test beside a screen still needs it"   0 '' 'apps/client/src/x/__tests__/X.test.tsx\napps/client/src/x/X.tsx\n'
dz "a look-alike path: not needed"           1 '' 'docs/apps/client/src/x.md\napps/client-tools/src/x.ts\n'
# The label and the release exemption.
dz "needs-design on server code"             0 'hold\nneeds-design\n' 'apps/server/src/x.ts\n'
dz "a release PR touching UI: exempt"        1 '' 'apps/client/src/x.tsx\n' 'chore(release): v0.140.0'
dz "a chore that isn't a release: needed"    0 '' 'apps/client/src/x.tsx\n' 'chore(client): tidy'
# Big input (the pipefail + grep -q trap only shows on big input).
big=$(printf 'apps/client/src/x.tsx\n'; for i in $(seq 1 6000); do printf 'apps/server/src/a-fairly-long-folder-name/file-number-%s.ts\n' "$i"; done)
dz "big file list, UI path near the top"     0 '' "$big"

bash "$gate" needs "$t/missing" "$t/f" x >/dev/null; rc=$?
[ "$rc" = 2 ] && ok || bad "unreadable input exits 2 (exit $rc)"
bash "$gate" needs "$t/l" "$t/f" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok || bad "missing title exits 2 (exit $rc)"

fr() { # name expect-exit head-time label-time
  out=$(bash "$gate" fresh "$3" "$4"); rc=$?
  [ "$rc" = "$2" ] && ok || bad "$1 (exit $rc, want $2): $out"
}
fr "label after the head: fresh"          0 2026-11-21T18:00:00Z 2026-11-21T18:05:00Z
fr "label before the head: stale"         1 2026-11-21T18:00:00Z 2026-11-21T17:55:00Z
fr "label at the head's second: stale"    1 2026-11-21T18:00:00Z 2026-11-21T18:00:00Z
fr "no label: stale"                      1 2026-11-21T18:00:00Z ''
fr "no head time: stale"                  1 ''                   2026-11-21T18:05:00Z
bash "$gate" nonsense >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok || bad "unknown subcommand exits 2 (exit $rc)"

echo "design-ok fixtures: $pass passed, $fail failed"
[[ "$fail" == 0 ]]
