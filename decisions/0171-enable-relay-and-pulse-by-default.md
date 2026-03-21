---
number: 171
title: Enable Relay and Pulse by Default
status: accepted
created: 2026-03-21
spec: enable-subsystems-by-default
superseded-by: null
---

# 171. Enable Relay and Pulse by Default

## Status

Accepted (implements ADR-0054, which was proposed but not yet shipped)

## Context

DorkOS has three core subsystems: Mesh, Relay, and Pulse. These are not optional features — they are the coordination layer that makes DorkOS worth running. Mesh was made always-on per ADR-0062. Relay and Pulse remained opt-in because the initialization code in `apps/server/src/index.ts` silently made their config schema defaults unreachable:

- **Pulse** used OR logic (`env.DORKOS_PULSE_ENABLED || schedulerConfig.enabled`) that could not honor an explicit `DORKOS_PULSE_ENABLED=false` env var — the config value would win regardless.
- **Relay** used `?? false` as a fallback (`relayConfig?.enabled ?? false`) that overrode the schema's default of `true` whenever the env var was absent on a fresh install.

The config schema in `packages/shared/src/config-schema.ts` already declared both `relay.enabled: true` and `scheduler.enabled: true` as defaults. The bug was entirely in how `index.ts` consumed those values, not in the schema itself.

ADR-0054 ("Invert Feature Flags to Enabled by Default") proposed this change. The `createFeatureFlag()` factory in `lib/feature-flag.ts` was updated to initialize `{ enabled: true }` (that part was already implemented). The env var layer was not corrected until this ADR.

## Decision

Use the `'KEY' in process.env ? env.KEY : config.enabled` pattern for both Pulse and Relay initialization in `index.ts`. This pattern:

1. Reads the env var value **only when the env var is explicitly present** in the environment.
2. Falls back to the config schema value (which defaults to `true`) when the env var is absent.
3. Preserves `boolFlag` in `env.ts` unchanged — no schema migration required.

Concretely:

```typescript
// Pulse — replaces OR logic
const pulseEnabled =
  'DORKOS_PULSE_ENABLED' in process.env ? env.DORKOS_PULSE_ENABLED : schedulerConfig.enabled; // true by default

// Relay — removes ?? false
const relayEnabled =
  'DORKOS_RELAY_ENABLED' in process.env ? env.DORKOS_RELAY_ENABLED : relayConfig.enabled; // true by default
```

Additionally, `packages/cli/src/cli.ts` gains a Relay config-propagation block matching the existing Pulse block, eliminating an asymmetry where `--pulse`/`--no-pulse` had a propagation path but Relay did not.

Env vars `DORKOS_RELAY_ENABLED=false` and `DORKOS_PULSE_ENABLED=false` remain fully supported as opt-out escape hatches. Config file values (`relay.enabled: false`, `scheduler.enabled: false`) also continue to work when no env var override is present.

## Consequences

### Positive

- Fresh installs get full DorkOS functionality — Relay, Pulse, and Mesh all start automatically with zero configuration.
- No breaking change for users who explicitly set the env vars to `false`; the escape hatch is preserved.
- The config schema defaults (`relay.enabled: true`, `scheduler.enabled: true`) are now actually reachable, making the schema the authoritative source of truth.
- `env.ts` is unchanged; `env.test.ts` tests remain valid.
- The fix is surgical — two logical lines in `index.ts`, one block in `cli.ts`.

### Negative

- Users who relied on the implicit-disabled behavior (no config, no env var) will now find Relay and Pulse running. This is the intended behavior, but may surprise operators who expected a minimal startup.
- The opt-out requires an explicit env var or config file edit rather than the previous implicit default.
