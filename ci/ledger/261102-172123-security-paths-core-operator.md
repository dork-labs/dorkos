---
id: 261102-172123
title: core/operator, where agents' permissions are written, is a security path and a P0 path
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

`core/operator/` joins `SECURITY_PATH_PATTERN` and `SECURITY_DEEP_PATH_PATTERN` in `security-gate.yml`, and the two other copies of the main list (the fixture regex and `tools/security-approve/Policy.swift`). A diff there now needs `security-reviewed` and `security-deep-reviewed` newer than its last push. The other unmatched folders are listed in the PR for Security to rule on.

## Hypothesis

PRs that change `apps/server/src/services/core/operator/` and merge without `security-deep-reviewed` at their head go from unchecked to 0 over the 14 days after merge. QA counts it by hand from merged PRs' labels; no collector metric covers it yet.

Revert if a PR outside `core/operator/` starts needing the deep label because of this change.
