---
id: 261125-120250
title: knip counts the scripts workflows, hooks and package scripts run as production entries
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The knip ratchet (ledger 261111-181542, DOR-4186) runs `knip --production`, which drops the
entries knip finds in workflow steps, lefthook and package scripts. So every root script that CI
runs by path (`node scripts/x.mjs`, `node .github/scripts/x.mjs`) was reported as an unused file,
and the four hand-listed entries without `!` (release-commit.ts, stamp-release-notes.ts and the two
Composio scripts) counted for nothing. knip.config.ts now reads the tracked workflows, lefthook.yml,
package.json files, shell scripts and Dockerfiles, and makes every root `scripts/` or
`.github/scripts/` file they name by path a production entry. Helpers still count only through their
importers, and a script no runner names is still reported. Two runners that name scripts through
a variable (mac-browser-reading.yml, scripts/harness-smoke/run.sh) are listed by hand.

The baseline loses the 61 allowances this resolves (55 root files now reached, and 6 server exports
those scripts import). Nothing is added or raised.

Baseline: 38 new unused-file violations under scripts/ and .github/scripts/ on main (1c291896fd),
of 1,124 ratchet violations in all. The rest is drift in apps/ and packages/ since the Nov 17
baseline, because the ratchet still runs in no workflow.
Target: 3 unused-file violations there. Each is a file only a test imports. Files that are now
reached show their exports that only tests import (84 symbol findings, previously hidden by the
file-level finding).
Evaluate: Dec 9, or when the ratchet is wired into CI.
