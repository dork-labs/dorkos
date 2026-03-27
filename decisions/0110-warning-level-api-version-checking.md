---
number: 110
title: Warning-Level API Version Checking for Adapter Plugins
status: accepted
created: 2026-03-11
spec: relay-adapter-dx
superseded-by: null
---

# 110. Warning-Level API Version Checking for Adapter Plugins

## Status

Accepted

## Context

The relay adapter system has no API versioning mechanism. When `@dorkos/relay` evolves and an adapter is built against an older version, the adapter may fail at runtime with cryptic errors. Research across VS Code (`engines.vscode`), Figma (`api` version), and Obsidian (`minAppVersion`) confirmed that version checking at load time is standard practice for plugin systems.

The question is whether to hard-block loading on version mismatch or issue a warning.

## Decision

Export `RELAY_ADAPTER_API_VERSION` from `@dorkos/relay`. Add an optional `apiVersion` field to `AdapterManifest`. The plugin loader checks `major.minor` compatibility at load time with a warning-level log on mismatch — not a hard block.

Use a simple manual `major.minor` comparison rather than adding `semver` as a dependency (the monorepo does not use `semver` anywhere). Pre-1.0: no stability guarantees. Post-1.0: follow SemVer conventions.

## Consequences

### Positive

- Prevents cryptic runtime errors by surfacing version mismatches early
- Warning-level approach doesn't break working adapters unnecessarily
- Gives adapter authors time to update without forced breakage
- Optional `apiVersion` field is backward compatible with existing manifests

### Negative

- Warning-only means users might ignore version mismatches and hit runtime errors anyway
- Simple `major.minor` comparison may not handle all SemVer edge cases (acceptable pre-1.0)
- Requires maintaining a version constant and bumping it on interface changes
