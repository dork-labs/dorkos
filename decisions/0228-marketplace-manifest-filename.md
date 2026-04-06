---
number: 228
title: Use `.dork/manifest.json` for Marketplace Package Manifests
status: draft
created: 2026-04-06
spec: marketplace-01-foundation
extractedFrom: marketplace-01-foundation
superseded-by: null
---

# 228. Use `.dork/manifest.json` for Marketplace Package Manifests

## Status

Draft (auto-extracted from spec: marketplace-01-foundation)

## Context

The DorkOS Marketplace introduces a per-package manifest file that declares package type, version, dependencies, and metadata. The filename must be distinctive (so tooling can find it), avoid collision with existing conventions, and feel native to the DorkOS file layout.

Three candidates were considered:

- `.dork/package.json` — Causes confusion with npm's `package.json`. Tooling, IDE icons, and developer mental models will conflate them. The `.dork/` prefix helps but doesn't eliminate confusion.
- `.dork/dorkos.json` — Redundant ("dork" appears twice in the path). Reads as "dot-dork-slash-dorkos-dot-json".
- `dork.json` (project root) — Pollutes the root directory and conflicts with template's project files.

## Decision

Use `.dork/manifest.json` as the canonical marketplace package manifest filename.

This is consistent with other `.dork/` files in DorkOS (`agent.json`, eventually `adapters.json`), avoids any npm confusion, and clearly communicates "this is a manifest for the package contained in this directory" without needing a project-name prefix.

## Consequences

### Positive

- No mental-model collision with npm `package.json`
- Consistent with existing DorkOS file naming conventions inside `.dork/`
- Clear signal: a directory containing `.dork/manifest.json` is a marketplace package
- Tooling can rely on a single, unambiguous filename

### Negative

- The brief originally proposed `.dork/package.json` — existing references in the parent ideation document use that name and need to be read with this decision in mind
- The term "package" still appears throughout the spec (since "marketplace package" is the user-facing concept) but the filename itself is `manifest.json`
