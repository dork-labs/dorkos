---
number: 314
title: The /flow plugin delegates identifier allocation to host tooling
status: draft
created: 2026-07-03
spec: merge-conflict-prevention
superseded-by: null
---

# 314. The /flow plugin delegates identifier allocation to host tooling

## Status

Draft (auto-extracted from spec: merge-conflict-prevention)

## Context

`/flow`'s canonical source is now a marketplace plugin (`dork-labs/marketplace/plugins/flow/`,
mid-extraction under spec #266 / DOR-133) that must stay harness-neutral because other installers
may keep sequential numbering. Today the plugin hard-codes the counter mechanic in
`skills/specifying-work/SKILL.md` (steps 7-8: "numbered from `nextNumber`, increment it") and
`templates/docs/adr.md` (`number: NNNN`). The DorkOS-specific timestamp scheme must not leak into
a shared plugin. `skills/executing-specs/SKILL.md` already shows the correct pattern: it delegates
manifest status updates to "your harness's manifest-maintenance command... skip if no manifest."

## Decision

The plugin stops describing counter allocation and delegates identifier allocation and manifest
maintenance to the host's tooling, extending the delegation pattern `executing-specs` already uses.
`specifying-work` steps 7-8 and `templates/docs/adr.md` change to reference host tooling and an
`id:` field. The DorkOS timestamp-id scheme lives entirely host-side. Changes land as a PR in
`dork-labs/marketplace`, coordinated with DOR-133, and are dogfooded via `--plugin-dir`.

## Consequences

### Positive

- The plugin stays generic and reusable; installers keep whatever id scheme they prefer.
- The DorkOS-specific fix lands host-side where it belongs; clean separation of concerns.

### Negative

- Requires a coordinated cross-repo PR against an in-flight extraction branch.
- The host must provide the manifest-maintenance tooling the plugin now delegates to.
