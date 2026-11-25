---
id: 261125-175705
title: The daily-release fixtures' fake gh prints --jq results the way gh does
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.scripts-test.fixtures
prs: []
ratchet-release: []
field-changes: []
---

Follow-up to #4429 and #4434. #4434 gave eleven fixture suites a `gh_jq` helper that prints a `--jq` result exactly as
gh does (a string raw, null as an empty line, anything else as compact JSON); `test-daily-release.sh` was left out to
avoid a conflict with #4429, which had patched its stub with `grep -vx null` (drops the line instead of printing an
empty one). It now uses the same helper; 148/148.
