---
id: 261102-172123
title: core/operator and the other unmatched server folders join the security lists, as Security ruled
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-gate.security-gate
prs: []
ratchet-release: []
field-changes: []
---

## Why

Security's re-run of the gate patterns (2026-11-02, DOR-3678) found server folders that match no security pattern. The most important is `apps/server/src/services/core/operator/`. It holds `config_patch`, `update_agent_boundaries`, the config and agent write policies, the guarded paths and the operator-only rules, which is where agents' permissions get written. A PR there needed no Security label.

## What changes

`core/operator/` joins `SECURITY_PATH_PATTERN` and `SECURITY_DEEP_PATH_PATTERN` in `security-gate.yml`, and the two other copies of the main list (the fixture regex and `tools/security-approve/Policy.swift`). A diff there now needs `security-reviewed` and `security-deep-reviewed` newer than its last push.

The other unmatched folders join as Security ruled (#dorkos, 2026-11-02 17:25Z). Main and deep: `core/lan-access/`, `core/hub/`, `core/server-role/`, `core/safe-defaults/`, `core/remote/`, `terminal/`, `core/config/` and `core/secret-file-scan/`. Main only: `core/hub-relay/`, `core/cloud/`, `core/sign-in-landing/`, `memory/`, `marketplace/`, `marketplace-mcp/`, `core-extensions/` and `mcp-apps/`.

## Hypothesis

PRs that change `apps/server/src/services/core/operator/` or another newly listed folder and merge without the labels their list needs at their head go from unchecked to 0 over the 14 days after merge. QA counts it by hand from merged PRs' labels; no collector metric covers it yet.

Revert if a PR outside the listed folders starts needing a Security label because of this change.
