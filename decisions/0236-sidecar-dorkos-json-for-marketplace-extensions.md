---
number: 236
title: Sidecar dorkos.json for DorkOS Marketplace Extensions
status: draft
created: 2026-04-07
spec: marketplace-05-claude-code-format-superset
superseded-by: null
---

# 236. Sidecar dorkos.json for DorkOS Marketplace Extensions

## Status

Draft (auto-extracted from spec: marketplace-05-claude-code-format-superset)

## Context

DorkOS's marketplace format must be a strict superset of Claude Code's marketplace format, meaning any DorkOS-produced `marketplace.json` must pass `claude plugin validate` and any CC-produced marketplace must install via DorkOS. The verification pass against the live CC spec and the unofficial schema (`hesreallyhim/claude-code-json-schema`) confirmed that CC's validator uses **`additionalProperties: false`** on plugin entries. GitHub Issue #26555 is definitive: adding unknown keys (even well-known ones like `category`) causes `Unrecognized keys` errors that block the entire marketplace from loading.

This rules out every inline extension strategy we considered: `x-dorkos-*` prefixed fields, a single `x-dorkos: {...}` namespace object, and top-level passthrough. RFC 6648 deprecated the `X-` prefix convention anyway, and CC's strict validator makes the prefix provide zero benefit. DorkOS-specific fields (`type`, `layers`, `requires`, `featured`, `icon`, `dorkosMinVersion`, `pricing`) need a different home.

## Decision

Place DorkOS extensions in a **sidecar file** at `.claude-plugin/dorkos.json`, alongside `marketplace.json` in the same directory. The sidecar is indexed by plugin name and contains only DorkOS-specific fields. DorkOS reads both files and merges by plugin name; CC reads only `marketplace.json` and is completely unaware of the sidecar.

Drift handling: plugins present in `marketplace.json` but not in `dorkos.json` are treated as having default extensions (not an error). Plugins present in `dorkos.json` but not in `marketplace.json` produce a warning and are silently dropped from merged output. The sidecar is always optional — if it doesn't exist, merged entries have `dorkos: undefined`.

## Consequences

### Positive

- Bulletproof from CC's validator perspective — no risk of CC schema changes breaking DorkOS
- Clean separation of concerns: CC semantics in `marketplace.json`, DorkOS semantics in `dorkos.json`
- Allows DorkOS to add new extension fields at any time without coordinating with Anthropic
- Backward compatible when upstream CC evolves (even if CC adds new fields that conflict with DorkOS names, the two files are isolated)

### Negative

- Requires a second HTTP fetch at runtime (parallelizable, still one round-trip because of HTTP/2 multiplexing)
- Merge logic needs explicit drift handling (orphans, missing sidecars)
- Authors maintaining a DorkOS marketplace need to keep two files in sync instead of one
- Slightly more complex tooling: the `dorkos package validate-marketplace` CLI reads both files and validates them together
