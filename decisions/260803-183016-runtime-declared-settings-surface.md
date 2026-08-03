---
id: 260803-183016
title: Runtimes declare their settings surface via RuntimeCapabilities.settings
status: draft
created: 2026-08-03
spec: runtimes-settings-redesign
superseded-by: null
---

# 260803-183016. Runtimes declare their settings surface via RuntimeCapabilities.settings

## Status

Draft (auto-extracted from spec: runtimes-settings-redesign)

## Context

What a runtime contributes to the settings UI was encoded in three hand-kept
maps that only comments held together: the server's `CONFIG_SECTION_BY_RUNTIME`
(resolve-session-defaults.ts), its admitted client mirror
`configSectionForRuntime` (entities/config), and the shared
`RUNTIMES_WITHOUT_EFFORT` list behind `runtimeSupportsEffort()`. The Claude
accounts card was likewise hardcoded onto the Runtimes settings tab rather than
being anything the runtime declared. A new runtime's author had to find and
update all of these in files far from the adapter's own `runtime-constants.ts`.
ADR-0256 already sets the capability-shape bar: flat booleans for boolean
facts, structured fields for capabilities that differ materially per runtime,
the `features` bag only for what does not merit first-class shape.

## Decision

Add a required structured capability, `RuntimeCapabilities.settings`
(`RuntimeSettingsCapability`): `configSection` (the runtime's key under
`runtimes.*` in user config, or null), `supportsEffort` (the runtime-level
static fact; per-model support stays on `ModelOption`), and `sections` — an
ordered list of bespoke settings-section descriptors (`{ kind }`) that the
client renders through feature-injected renderers keyed on `kind`, the same
slot pattern the connect flows already use (`login` / `provider-picker`). The
declaration is static-only: dynamic state (account lists, current provider,
readiness) stays on the refetched surfaces (`/api/config`,
`/api/system/requirements`), so capabilities remain cacheable with
`staleTime: Infinity`. The three hand-kept maps are retired; conformance
(`runtimeConformance`) asserts the declaration's shape for every runtime.
Rejected: `features`-bag entries (untyped, and ADR-0256 warns against
absorbing first-class concerns) and a separate `/api/runtime-settings`
endpoint (a parallel channel for what is naturally a capability).

## Consequences

### Positive

- One authoring surface: a new runtime declares its settings next to its other
  capabilities, enforced at compile time (required field) and by conformance.
- Kills two silently-divergeable duplicate maps and a third hardcoded list.
- Unknown section kinds render nothing, so third-party/future runtimes degrade
  gracefully everywhere at once.

### Negative

- Interface change touches all four adapters, the shared Zod schema, and the
  conformance suite in one move.
- A declared section still needs a client renderer to appear — the capability
  can promise UI the client does not ship (mitigated by documenting the
  renderer requirement in contributing/adding-a-runtime.md).
- `configSection` is `string | null` in shared while the real key set is
  host-config-defined, so the server needs a validating type guard rather than
  a compile-time exhaustive union.
