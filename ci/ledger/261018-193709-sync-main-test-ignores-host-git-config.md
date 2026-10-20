---
id: 261018-193709
title: The sync-main-checkout test ignores git config the host injects
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.scripts-test.harness
prs: [3067]
ratchet-release: []
field-changes: []
---

`scripts/test-sync-main-checkout.sh` failed when run from a Claude Code shell:
the host sets `GIT_CONFIG_COUNT` with `safe.bareRepository=explicit`, which
refuses the bare repo the test builds. The script now sets `GIT_CONFIG_COUNT=0`
so only its own settings apply. CI never injects that config, so nothing
measurable should move there; this keeps the test honest on agent machines.
Revert if the harness gate starts failing on this script in CI.
