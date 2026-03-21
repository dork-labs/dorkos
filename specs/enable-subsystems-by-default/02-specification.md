---
slug: enable-subsystems-by-default
number: 159
created: 2026-03-21
status: specified
ideation: specs/enable-subsystems-by-default/01-ideation.md
---

# Enable Relay and Pulse by Default

**Status:** Specified
**Authors:** Claude Code
**Date:** 2026-03-21

---

## Overview

Relay and Pulse are core DorkOS subsystems. A fresh install should have full functionality out of the box without any config changes or onboarding steps. This spec fixes the initialization logic in `index.ts` that silently makes both subsystems opt-in despite the config schema already defaulting them to `true`.

Mesh is the reference: it is always-on per ADR-0062. Relay and Pulse will become default-on with an env var escape hatch (`DORKOS_RELAY_ENABLED=false`, `DORKOS_PULSE_ENABLED=false`).

---

## Background / Problem Statement

Two bugs in `apps/server/src/index.ts` prevent Relay and Pulse from starting on fresh installs:

**Bug 1 — Pulse (line 102):** OR logic cannot honor an explicit `DORKOS_PULSE_ENABLED=false`:

```typescript
// Current: if env var is false (boolFlag default), falls through to config
const pulseEnabled = env.DORKOS_PULSE_ENABLED || schedulerConfig.enabled;
// → true (config default wins even when user sets =false)
```

**Bug 2 — Relay (line 125):** `?? false` makes the config schema default unreachable on fresh installs:

```typescript
// Current: if DORKOS_RELAY_ENABLED not in env, uses relayConfig?.enabled ?? false
const relayEnabled =
  'DORKOS_RELAY_ENABLED' in process.env
    ? env.DORKOS_RELAY_ENABLED
    : (relayConfig?.enabled ?? false); // ?? false overrides schema default of true
```

**Root cause:** `boolFlag` in `env.ts` defaults to `false` when the env var is absent. The Pulse init reads this `false` value directly; the Relay init correctly checks `'KEY' in process.env` but then falls back through `?? false` instead of trusting the config schema.

**The config schema already has the right values** — `packages/shared/src/config-schema.ts` defaults both `relay.enabled` and `scheduler.enabled` to `true`. No schema changes are needed; just fix how `index.ts` consumes them.

Additionally, `packages/cli/src/cli.ts` has a Pulse propagation block (lines 188–193) that forwards `--pulse`/`--no-pulse` CLI flags and config values to the env var. Relay has no equivalent block — an asymmetry that should be fixed.

---

## Goals

- Fresh installs start both Relay and Pulse automatically — zero configuration required.
- `DORKOS_RELAY_ENABLED=false` and `DORKOS_PULSE_ENABLED=false` continue to function as opt-out escape hatches.
- Config file `relay.enabled: false` / `scheduler.enabled: false` continue to disable the respective subsystem when no env var override is present.
- The `--pulse` / `--no-pulse` CLI flags continue to work as before.
- Relay gains a symmetric config-propagation block in the CLI matching the Pulse pattern.
- All existing tests pass without modification.
- A new ADR (#171) is created documenting this decision as accepted (implementing ADR-0054).

---

## Non-Goals

- Removing the env var escape hatch entirely (Approach A from research — rejected).
- Any changes to Mesh (already always-on per ADR-0062).
- UI changes or onboarding flow removal.
- Adding `--relay`/`--no-relay` CLI flags (not in scope; CLI propagation block is config-only).
- Relay or Pulse feature development.

---

## Technical Dependencies

| Dependency                                    | Role                                                              | Notes                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/shared/src/config-schema.ts`        | Already defaults `relay.enabled: true`, `scheduler.enabled: true` | No changes needed                                                              |
| `apps/server/src/env.ts`                      | `boolFlag` defaults to `'false'`                                  | No changes needed — we use `'KEY' in process.env` to avoid reading the default |
| `apps/server/src/lib/feature-flag.ts`         | Factory already initializes `{ enabled: true }` per ADR-0054      | No changes needed                                                              |
| `apps/server/src/services/mesh/mesh-state.ts` | Reference: `isMeshEnabled = () => true`                           | No changes needed                                                              |

---

## Detailed Design

### 1. Fix `apps/server/src/index.ts`

#### Pulse (line 102)

Replace the OR logic with the `'KEY' in process.env` pattern, consistent with how Relay already guards its env var read:

```typescript
// BEFORE (broken)
const pulseEnabled = env.DORKOS_PULSE_ENABLED || schedulerConfig.enabled;

// AFTER — env var wins only when explicitly present in the environment
// eslint-disable-next-line no-restricted-syntax -- checks key existence (not value); env.ts boolFlag can't distinguish "unset" from "set to false"
const pulseEnabled =
  'DORKOS_PULSE_ENABLED' in process.env ? env.DORKOS_PULSE_ENABLED : schedulerConfig.enabled;
```

The existing `eslint-disable-next-line` comment pattern from the Relay block (line 121) should be applied here for consistency, since the same reasoning applies.

#### Relay (line 125)

Remove the `?? false` fallback so the config schema default of `true` is reachable:

```typescript
// BEFORE (broken — ?? false overrides schema default)
const relayEnabled =
  'DORKOS_RELAY_ENABLED' in process.env
    ? env.DORKOS_RELAY_ENABLED
    : (relayConfig?.enabled ?? false);

// AFTER — relayConfig.enabled comes from UserConfigSchema which defaults to true
const relayEnabled =
  'DORKOS_RELAY_ENABLED' in process.env ? env.DORKOS_RELAY_ENABLED : relayConfig.enabled;
```

Remove the optional chaining (`?.`) as well — `configManager.get('relay')` always returns a validated object (never undefined) thanks to the Zod schema with defaults.

Update the comment block above this (lines 119–121) to reflect the corrected behavior:

```typescript
// Env var wins when explicitly set; fall back to config when not set.
// boolFlag defaults to false even when unset, so check process.env directly.
// eslint-disable-next-line no-restricted-syntax -- checks key existence (not value); env.ts boolFlag can't distinguish "unset" from "set to false"
```

#### Behavior after fix

| Scenario                                          | Pulse      | Relay      |
| ------------------------------------------------- | ---------- | ---------- |
| Fresh install (no env vars, no config)            | ✅ starts  | ✅ starts  |
| `DORKOS_PULSE_ENABLED=false`                      | ❌ skipped | ✅ starts  |
| `DORKOS_RELAY_ENABLED=false`                      | ✅ starts  | ❌ skipped |
| Config `scheduler.enabled: false`, no env var     | ❌ skipped | ✅ starts  |
| Config `relay.enabled: false`, no env var         | ✅ starts  | ❌ skipped |
| `DORKOS_RELAY_ENABLED=true` (redundant, explicit) | ✅ starts  | ✅ starts  |
| `--pulse` CLI flag                                | ✅ starts  | ✅ starts  |
| `--no-pulse` CLI flag                             | ❌ skipped | ✅ starts  |

### 2. Fix `packages/cli/src/cli.ts`

The CLI currently has a Pulse propagation block (lines 188–193) that forwards the `--pulse`/`--no-pulse` flag or config value to `DORKOS_PULSE_ENABLED`. Relay has no equivalent.

The CLI does **not** have `--relay`/`--no-relay` flags (confirmed in `parseArgs` options). The Relay block therefore only propagates from config:

```typescript
// EXISTING Pulse block (retain as-is):
// Pulse scheduler: CLI flag > env var > config
if (values.pulse !== undefined) {
  process.env.DORKOS_PULSE_ENABLED = values.pulse ? 'true' : 'false';
} else if (!process.env.DORKOS_PULSE_ENABLED && cfgMgr.getDot('scheduler.enabled')) {
  process.env.DORKOS_PULSE_ENABLED = 'true';
}

// ADD: symmetric Relay block immediately after:
// Relay: env var > config (no CLI flag for relay)
if (!process.env.DORKOS_RELAY_ENABLED && cfgMgr.getDot('relay.enabled')) {
  process.env.DORKOS_RELAY_ENABLED = 'true';
}
```

This block only sets the env var when it is absent — it never overrides an explicit user env var, preserving the escape hatch.

### 3. Create ADR #171

A new ADR at `decisions/0171-enable-relay-and-pulse-by-default.md` documents this decision as accepted, implementing the proposal from ADR-0054. Update `decisions/manifest.json` with `nextNumber: 172`.

The ADR records:

- Context: subsystems were opt-in; config schema already defaulted to `true`; the bug was in `index.ts`
- Decision: use `'KEY' in process.env ? env.KEY : config.enabled` for both Pulse and Relay
- Consequences: fresh installs get full functionality; escape hatch preserved; mirrors ADR-0062 intent

---

## System Integration Mapping

```
Data flow (fresh install):
  process.env has no DORKOS_PULSE_ENABLED / DORKOS_RELAY_ENABLED
      ↓
  cli.ts propagation blocks
      → DORKOS_PULSE_ENABLED not set → cfgMgr.getDot('scheduler.enabled') = true → set 'true'
      → DORKOS_RELAY_ENABLED not set → cfgMgr.getDot('relay.enabled') = true → set 'true'
      ↓
  index.ts init
      → 'DORKOS_PULSE_ENABLED' in process.env → true (cli.ts set it) → env.DORKOS_PULSE_ENABLED = true
      → 'DORKOS_RELAY_ENABLED' in process.env → true (cli.ts set it) → env.DORKOS_RELAY_ENABLED = true
      ↓
  if (pulseEnabled) → PulseStore init → setPulseEnabled(true)
  if (relayEnabled) → RelayCore init → setRelayEnabled(true)
      ↓
  Config route: isPulseEnabled() = true, isRelayEnabled() = true
      ↓
  Client: usePulseEnabled(), useRelayEnabled() → show subsystem panels

Data flow (escape hatch — DORKOS_RELAY_ENABLED=false in shell):
  process.env.DORKOS_RELAY_ENABLED = 'false'
      ↓
  cli.ts: DORKOS_RELAY_ENABLED already set → propagation block skips
      ↓
  index.ts: 'DORKOS_RELAY_ENABLED' in process.env → env.DORKOS_RELAY_ENABLED = false
  → if (false) → Relay init skipped → setRelayEnabled not called
      ↓
  isRelayEnabled() = false → config route reports disabled
```

---

## User Experience

No visible UX change for the majority of users — Relay and Pulse panels will simply appear on first install without any setup step.

Users who want to opt out can set `DORKOS_RELAY_ENABLED=false` or `DORKOS_PULSE_ENABLED=false` in their environment before starting DorkOS, or set the values in their `~/.dork/config.json`.

The `--pulse` / `--no-pulse` CLI flags continue to work exactly as before.

---

## Testing Strategy

No new test files are required — the existing test suite covers all paths. The goal is to verify that:

1. Existing tests pass without modification after the `index.ts` changes.
2. The Pulse propagation block behavior is unchanged.

### Manual verification checklist

Run these before merging:

```bash
# 1. Fresh install — both should start
dorkos
# Expect in logs: "[Pulse] PulseStore initialized" and "[Relay] RelayCore initialized"

# 2. Relay opt-out
DORKOS_RELAY_ENABLED=false dorkos
# Expect: "[Pulse] PulseStore initialized" but NO "[Relay] RelayCore initialized"

# 3. Pulse opt-out
DORKOS_PULSE_ENABLED=false dorkos
# Expect: "[Relay] RelayCore initialized" but NO "[Pulse] PulseStore initialized"

# 4. --no-pulse flag
dorkos --no-pulse
# Expect: Relay starts, Pulse skipped

# 5. --pulse flag (explicit enable)
dorkos --pulse
# Expect: Both start
```

### Automated tests (no changes needed)

```bash
pnpm vitest run apps/server/src/__tests__/env.test.ts
pnpm vitest run packages/shared/src/__tests__/config-schema.test.ts
pnpm test -- --run
```

These pass today and must continue to pass. The `env.test.ts` test that asserts feature flags "default to false" refers to the `boolFlag` Zod schema default — `env.ts` is unchanged, so this test remains valid.

---

## Performance Considerations

Both Relay and Pulse are lightweight in-process services sharing the existing Express server and SQLite database. Combined startup overhead is sub-100ms and under 10MB RSS. No impact on per-session start time or request handling.

---

## Security Considerations

Neither Relay nor Pulse opens new network ports. They're in-process services served over the existing Express server:

- Relay's `relay.system.console` endpoint is registered internally but not exposed externally.
- Pulse only fires schedules that users explicitly created.

No new attack surface is introduced by enabling them by default. Users who want to reduce surface area can still opt out via env vars.

---

## Documentation

- Update any documentation that says Relay or Pulse are "disabled by default" or require manual enablement.
- Update `CHANGELOG.md` to note that Relay and Pulse are now enabled by default as of this version.
- The ADR (#171) serves as the canonical record of this architectural decision.

---

## Implementation Phases

### Phase 1 (entire scope — single PR)

1. Edit `apps/server/src/index.ts`:
   - Line ~102: Replace Pulse OR logic with `'KEY' in process.env ? env.KEY : schedulerConfig.enabled`
   - Line ~125: Remove `?? false` from Relay fallback; remove optional chaining from `relayConfig?.enabled`
   - Add `eslint-disable-next-line` comment to Pulse block (matches Relay pattern)

2. Edit `packages/cli/src/cli.ts`:
   - Add Relay config-propagation block after the existing Pulse block (lines 188–193)
   - Comment: `// Relay: env var > config (no CLI flag for relay)`

3. Create `decisions/0171-enable-relay-and-pulse-by-default.md`
4. Update `decisions/manifest.json`: `nextNumber: 172`
5. Update `specs/manifest.json`: status `enable-subsystems-by-default` → `"specified"`
6. Run full test suite; confirm all pass

---

## Open Questions

No open questions — all decisions were resolved during ideation. See `specs/enable-subsystems-by-default/01-ideation.md` Section 6.

---

## Related ADRs

- **ADR-0054** (`decisions/0054-invert-feature-flags-to-enabled-by-default.md`): Proposed inverting feature flag defaults. This spec implements it. Status was "proposed"; ADR-0171 supersedes it with "accepted" status.
- **ADR-0062** (`decisions/0062-remove-mesh-feature-flag-always-on.md`): Mesh is always-on — the reference implementation for this change.

---

## References

- Ideation document: `specs/enable-subsystems-by-default/01-ideation.md`
- Research report: `research/20260321_enable_subsystems_by_default.md`
- Primary code file: `apps/server/src/index.ts` lines 100–151
- CLI code file: `packages/cli/src/cli.ts` lines 188–193
- Config schema: `packages/shared/src/config-schema.ts` lines 58–76
