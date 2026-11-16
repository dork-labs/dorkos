---
slug: enable-subsystems-by-default
number: 159
created: 2026-03-21
status: ideation
---

# Enable Relay and Pulse by Default

**Slug:** enable-subsystems-by-default
**Author:** Claude Code
**Date:** 2026-03-21
**Branch:** preflight/enable-subsystems-by-default

---

## 1) Intent & Assumptions

- **Task brief:** Relay and Pulse are core DorkOS subsystems, not optional extras. New installations should have full functionality out of the box — no config changes or onboarding steps required. Mesh is already always-on per ADR-0062; Relay and Pulse should follow the same pattern.
- **Assumptions:**
  - Env vars (`DORKOS_RELAY_ENABLED=false`, `DORKOS_PULSE_ENABLED=false`) must still be able to opt out — escape hatch preserved.
  - Mesh is already correct — no changes needed there.
  - The config schema (`UserConfigSchema`) already defaults both to `true`; the bug is in `index.ts`, which overrides those defaults with `?? false` fallbacks.
  - Existing users who explicitly set the env vars to `false` must be unaffected.
- **Out of scope:**
  - UI changes or onboarding flow removal
  - Relay or Pulse feature development
  - Removing the env var escape hatch entirely (Approach A)
  - Any changes to the Mesh subsystem

---

## 2) Pre-reading Log

- `apps/server/src/index.ts`: Main entry point. Pulse init at lines ~100-115 uses OR logic (`env.DORKOS_PULSE_ENABLED || schedulerConfig.enabled`) which is broken — if the env var is `false` and config is `true`, config wins incorrectly. Relay init at lines ~122-125 correctly checks `'DORKOS_RELAY_ENABLED' in process.env` but falls back with `?? false` — which makes the config default of `true` unreachable for fresh installs.
- `apps/server/src/lib/feature-flag.ts`: Factory already initializes `{ enabled: true }` — per ADR-0054. This is already correct.
- `packages/shared/src/config-schema.ts` (lines 58-76): Config schema already defaults `relay.enabled: true` and `scheduler.enabled: true`. **No changes needed here.**
- `apps/server/src/env.ts`: `DORKOS_PULSE_ENABLED` and `DORKOS_RELAY_ENABLED` use `boolFlag` which defaults to `'false'`. The research agent recommends not changing this — instead, using `'KEY' in process.env` to avoid reading the env var unless explicitly set.
- `apps/server/src/services/mesh/mesh-state.ts`: Reference implementation — `isMeshEnabled = () => true`. For Relay and Pulse, we keep the flags (for reporting to the config route and client UI) but flip their initialization to default-on.
- `apps/server/src/services/pulse/pulse-state.ts`: Exports `setPulseEnabled`, `isPulseEnabled`, `setPulseInitError`, `getPulseInitError`. No changes needed — just ensure `setPulseEnabled(true)` is called after successful init for both enabled and (now default) cases.
- `apps/server/src/services/relay/relay-state.ts`: Parallel to pulse-state. Same pattern — no changes to the state module itself.
- `apps/server/src/__tests__/env.test.ts` (lines 27-33): Test asserts feature flags "default to false" — **will need updating** if we change `boolFlag` default. Research recommendation avoids needing to touch `env.ts`, which sidesteps this test entirely.
- `packages/shared/src/__tests__/config-schema.test.ts`: Already tests `relay.enabled: true` and `scheduler.enabled: true` as defaults. No changes needed.
- `decisions/0054-invert-feature-flags-to-enabled-by-default.md`: ADR is "proposed" (not yet implemented). Recommends `createFeatureFlag()` to initialize `enabled: true` (already done) and env vars to default enabled. This spec implements the second half.
- `decisions/0062-remove-mesh-feature-flag-always-on.md`: Mesh reference — `isMeshEnabled = () => true`. Relay and Pulse won't fully mirror this (they retain their state flags for UI reporting) but will be default-on.
- `packages/cli/src/cli.ts` (lines 188-193): Has a Pulse propagation block but no equivalent for Relay — an asymmetry. Should be fixed in the same change.
- `apps/e2e/playwright.config.ts`: References `DORKOS_RELAY_ENABLED=true` — suggests the E2E test suite explicitly enables Relay. Once it defaults to `true`, this explicit flag becomes redundant but harmless.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/server/src/index.ts` — Main entry point. Lines ~100-115 (Pulse init) and ~117-151 (Relay init). The `if (pulseEnabled)` and `if (relayEnabled)` guards control whether subsystems start. **This is the primary change location.**
- `apps/server/src/lib/feature-flag.ts` — Factory that creates `{ enabled: true }` state (already correct).
- `apps/server/src/services/pulse/pulse-state.ts` — Runtime state holder for Pulse; reports enabled status to config route.
- `apps/server/src/services/relay/relay-state.ts` — Runtime state holder for Relay; reports enabled status to config route.
- `apps/server/src/services/mesh/mesh-state.ts` — Reference: `isMeshEnabled = () => true`.
- `packages/shared/src/config-schema.ts` — `UserConfigSchema`. Already defaults `relay.enabled: true` and `scheduler.enabled: true`. No change needed.
- `apps/server/src/env.ts` — Env var schema. `boolFlag` default is `'false'` but we won't change this — we'll use `'KEY' in process.env` to distinguish unset from false.
- `packages/cli/src/cli.ts` — Has a Pulse CLI propagation block; needs a symmetric Relay block added (or both removed).

**Shared Dependencies:**

- `configManager.get('scheduler')` / `configManager.get('relay')` — Already return `enabled: true` by default from config-schema.
- `env.DORKOS_PULSE_ENABLED` / `env.DORKOS_RELAY_ENABLED` — Env var overrides; read only when present in env (via `'KEY' in process.env`).
- `isPulseEnabled()`, `isRelayEnabled()` — Consumed by config route (`apps/server/src/routes/config.ts`) and client hooks; no changes needed in consumers.

**Data Flow:**

```
Fresh install (no env vars set):
  'DORKOS_PULSE_ENABLED' not in process.env → use config.scheduler.enabled → true
  'DORKOS_RELAY_ENABLED' not in process.env → use config.relay.enabled → true
  → Both subsystems start

User with DORKOS_RELAY_ENABLED=false:
  'DORKOS_RELAY_ENABLED' in process.env → env.DORKOS_RELAY_ENABLED → false
  → Relay skipped, Pulse starts

Config file disabling Relay:
  'DORKOS_RELAY_ENABLED' not in process.env → use config.relay.enabled → false (user set)
  → Relay skipped
```

**Feature Flags/Config:**

- `config-schema.ts`: `relay.enabled: true`, `scheduler.enabled: true` — ALREADY CORRECT ✓
- `feature-flag.ts`: Factory defaults to `enabled: true` — ALREADY CORRECT ✓
- `index.ts` Pulse logic (NEEDS FIX): OR logic `||` → `'KEY' in process.env ? env.KEY : config.enabled`
- `index.ts` Relay logic (NEEDS FIX): `?? false` fallback → `'KEY' in process.env ? env.KEY : config.enabled`
- `cli.ts` Relay block (NEEDS ADDITION): Add symmetric Relay propagation matching Pulse pattern

**Potential Blast Radius:**

- **Direct changes (2 files):** `apps/server/src/index.ts`, `packages/cli/src/cli.ts`
- **Tests to verify (no changes expected):** `apps/server/src/__tests__/env.test.ts` (if env.ts unchanged, no update needed), `packages/shared/src/__tests__/config-schema.test.ts` (already passes)
- **E2E tests:** `apps/e2e/playwright.config.ts` — `DORKOS_RELAY_ENABLED=true` becomes redundant but harmless
- **Indirect / no-change:** Config route, client UI hooks, onboarding wizard (doesn't prompt for these settings)

---

## 4) Root Cause Analysis

Not a bug fix — skipped.

---

## 5) Research

**Potential Solutions:**

1. **Approach A: Remove Feature Flags Entirely (Mesh Pattern)**
   - Description: Replace `isRelayEnabled()` and `isPulseEnabled()` with unconditional `return true`, remove env vars from `env.ts`, remove init guards.
   - Pros: Maximum simplicity, consistent with ADR-0062 Mesh pattern, eliminates the awkward `'KEY' in process.env` workaround.
   - Cons: Breaking change for users with `=false` in their env; removes escape hatch entirely; E2E tests explicitly pass `DORKOS_RELAY_ENABLED=true` (suggesting env var infrastructure is expected).
   - Complexity: Low. Maintenance: Very low.

2. **Approach B: Flip Defaults, Keep Escape Hatch (Recommended)**
   - Description: Change `index.ts` so both subsystems use `'KEY' in process.env ? env.KEY : config.enabled`. Config schema already defaults to `true`, so fresh installs get both subsystems. Existing users with explicit env overrides are unaffected.
   - Pros: No breaking change. Escape hatch preserved. No `env.ts` changes (and thus no `env.test.ts` changes). Aligns with DorkOS config precedence (CLI > env > config). Minimal diff.
   - Cons: Slightly more code than Approach A. The `'KEY' in process.env` pattern is already used for Relay — just needs consistency with Pulse.
   - Complexity: Low. Maintenance: Low.

3. **Approach C: Soft Default-On with Graceful Degradation**
   - Description: Enable by default, wrap init in try/catch so failures are non-fatal.
   - Note: Already fully implemented. Both Relay and Pulse have try/catch blocks with "non-fatal: server continues" comments in index.ts. Does nothing by itself without also changing the default.
   - Complexity: Already done. Not a standalone option.

**Security Considerations:**

- Neither Relay nor Pulse opens new network ports — they're in-process services on the existing Express server.
- Relay's `relay.system.console` endpoint is registered but not externally exposed.
- Pulse only fires schedules users explicitly created.
- No new attack surface from enabling by default.
- Users with `=false` in env are unaffected by Approach B.

**Performance Considerations:**

- Both subsystems are lightweight in-process; combined startup overhead is sub-100ms, under 10MB RSS.
- No impact on per-session start time.

**Recommendation:** Approach B. The config schema already has the correct defaults — the only fix is two logical lines in `index.ts` plus adding a symmetric Relay propagation block to `cli.ts`. Minimal blast radius, no breaking change, escape hatch preserved.

---

## 6) Decisions

No ambiguities identified — task brief and findings were sufficiently clear. Approach B (flip defaults, keep escape hatch) is the unambiguous correct path:

| #   | Decision         | Choice                                        | Rationale                                                                                                                                                                                                                             |
| --- | ---------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Approach         | B — flip defaults, keep escape hatch          | Task brief explicitly requires env var disable support. Config schema already defaults to `true`. The only gap is `index.ts` using broken OR logic (Pulse) and `?? false` fallback (Relay) that make the config defaults unreachable. |
| 2   | `env.ts` changes | No change                                     | Using `'KEY' in process.env ? env.KEY : config.enabled` avoids reading the env var default entirely. `env.test.ts` tests remain valid.                                                                                                |
| 3   | CLI asymmetry    | Fix — add Relay propagation block to `cli.ts` | Pulse already has a CLI propagation block (lines 188-193). Relay needs the equivalent. Leaving the asymmetry would be a code quality issue inconsistent with DorkOS standards.                                                        |
| 4   | New ADR          | Create one                                    | ADR-0054 is "proposed" — this spec implements it. A new ADR documents the decision as accepted and points to this implementation.                                                                                                     |
