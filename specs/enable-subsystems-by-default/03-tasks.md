# Task Breakdown: Enable Relay and Pulse by Default

**Spec:** `specs/enable-subsystems-by-default/02-specification.md`
**Generated:** 2026-03-21
**Mode:** Full

---

## Summary

4 tasks across 2 phases. This is a focused bug-fix: 3 files change, no new tests required, ADR pre-created.

| Phase                    | Tasks | Parallelism                  |
| ------------------------ | ----- | ---------------------------- |
| Phase 1 — Implementation | 3     | All 3 run in parallel        |
| Phase 2 — Verification   | 1     | Runs after all Phase 1 tasks |

**Critical path:** 1.1 → 2.1 (or 1.2 → 2.1 or 1.3 → 2.1 — all converge at 2.1)

**Note:** ADR-0171 (`decisions/0171-enable-relay-and-pulse-by-default.md`) and `decisions/manifest.json` (`nextNumber: 172`) are already in place — no ADR task needed.

---

## Phase 1 — Implementation

### Task 1.1 — Fix Pulse initialization logic in index.ts

**Size:** Small | **Priority:** High | **Parallel with:** 1.2, 1.3

**File:** `apps/server/src/index.ts`

The current OR logic at line 102 cannot honor an explicit `DORKOS_PULSE_ENABLED=false`. Because `boolFlag` in `env.ts` defaults to `false` when the env var is absent, `env.DORKOS_PULSE_ENABLED || schedulerConfig.enabled` always resolves `true` (config default wins regardless of the env var).

**Before (lines 100–102):**

```typescript
// Initialize Pulse scheduler if enabled
const schedulerConfig = configManager.get('scheduler');
const pulseEnabled = env.DORKOS_PULSE_ENABLED || schedulerConfig.enabled;
```

**After:**

```typescript
// Initialize Pulse scheduler if enabled
const schedulerConfig = configManager.get('scheduler');
// Env var wins when explicitly set; fall back to config when not set.
// boolFlag defaults to false even when unset, so check process.env directly.
// eslint-disable-next-line no-restricted-syntax -- checks key existence (not value); env.ts boolFlag can't distinguish "unset" from "set to false"
const pulseEnabled =
  'DORKOS_PULSE_ENABLED' in process.env ? env.DORKOS_PULSE_ENABLED : schedulerConfig.enabled;
```

The `eslint-disable-next-line` comment is required and must match the exact pattern already used in the Relay block below. `schedulerConfig.enabled` (no optional chaining) is safe — `configManager.get('scheduler')` always returns a validated Zod object.

**Acceptance criteria:**

- `'DORKOS_PULSE_ENABLED' in process.env` pattern replaces `env.DORKOS_PULSE_ENABLED ||`
- `eslint-disable-next-line no-restricted-syntax` comment with explanation is present
- `schedulerConfig.enabled` (no `?.`) used as fallback
- `pnpm typecheck` and `pnpm lint` pass

---

### Task 1.2 — Fix Relay initialization logic in index.ts

**Size:** Small | **Priority:** High | **Parallel with:** 1.1, 1.3

**File:** `apps/server/src/index.ts`

The current code at line 125 has `relayConfig?.enabled ?? false`. The `?? false` overrides the config schema default of `true` on fresh installs. The optional chaining `?.` is also unnecessary since `configManager.get('relay')` always returns a validated object. The `relayDataDir` line (130) also has unnecessary optional chaining for the same reason.

**Before (lines 117–130):**

```typescript
// Initialize Relay if enabled
const relayConfig = configManager.get('relay');
// Env var wins when explicitly set; fall back to config when not set.
// boolFlag defaults to false even when unset, so check process.env directly.
// eslint-disable-next-line no-restricted-syntax -- checks key existence (not value); env.ts boolFlag can't distinguish "unset" from "set to false"
const relayEnabled =
  'DORKOS_RELAY_ENABLED' in process.env
    ? env.DORKOS_RELAY_ENABLED
    : (relayConfig?.enabled ?? false);

// Phase A: core relay infrastructure (RelayCore + TraceStore)
// AdapterManager construction is deferred to Phase C (after meshCore init)
// so that meshCore is available for CWD resolution via buildContext().
const relayDataDir = relayConfig?.dataDir ?? path.join(dorkHome, 'relay');
```

**After:**

```typescript
// Initialize Relay if enabled
const relayConfig = configManager.get('relay');
// Env var wins when explicitly set; fall back to config when not set.
// boolFlag defaults to false even when unset, so check process.env directly.
// eslint-disable-next-line no-restricted-syntax -- checks key existence (not value); env.ts boolFlag can't distinguish "unset" from "set to false"
const relayEnabled =
  'DORKOS_RELAY_ENABLED' in process.env ? env.DORKOS_RELAY_ENABLED : relayConfig.enabled;

// Phase A: core relay infrastructure (RelayCore + TraceStore)
// AdapterManager construction is deferred to Phase C (after meshCore init)
// so that meshCore is available for CWD resolution via buildContext().
const relayDataDir = relayConfig.dataDir ?? path.join(dorkHome, 'relay');
```

Two distinct changes: remove `?? false` and `?.` from the `relayEnabled` line; remove `?.` from the `relayDataDir` line.

**Acceptance criteria:**

- `relayConfig?.enabled ?? false` replaced with `relayConfig.enabled`
- `relayConfig?.dataDir` replaced with `relayConfig.dataDir`
- The comment block above `relayEnabled` is intact
- `pnpm typecheck` and `pnpm lint` pass

---

### Task 1.3 — Add Relay config-propagation block in cli.ts

**Size:** Small | **Priority:** High | **Parallel with:** 1.1, 1.2

**File:** `packages/cli/src/cli.ts`

The CLI propagates `--pulse`/`--no-pulse` flags and config into `DORKOS_PULSE_ENABLED` (lines 188–193) but has no equivalent block for Relay. This asymmetry means the Relay escape hatch works but the default-on path from config does not flow through the CLI process. There are no `--relay`/`--no-relay` CLI flags (not in scope), so the Relay block is config-only.

**Before (lines 188–195):**

```typescript
// Pulse scheduler: CLI flag > env var > config
if (values.pulse !== undefined) {
  process.env.DORKOS_PULSE_ENABLED = values.pulse ? 'true' : 'false';
} else if (!process.env.DORKOS_PULSE_ENABLED && cfgMgr.getDot('scheduler.enabled')) {
  process.env.DORKOS_PULSE_ENABLED = 'true';
}

// Working directory: CLI flag > env var > config > cwd
```

**After (insert 4 lines between the Pulse block and the Working directory comment):**

```typescript
// Pulse scheduler: CLI flag > env var > config
if (values.pulse !== undefined) {
  process.env.DORKOS_PULSE_ENABLED = values.pulse ? 'true' : 'false';
} else if (!process.env.DORKOS_PULSE_ENABLED && cfgMgr.getDot('scheduler.enabled')) {
  process.env.DORKOS_PULSE_ENABLED = 'true';
}

// Relay: env var > config (no CLI flag for relay)
if (!process.env.DORKOS_RELAY_ENABLED && cfgMgr.getDot('relay.enabled')) {
  process.env.DORKOS_RELAY_ENABLED = 'true';
}

// Working directory: CLI flag > env var > config > cwd
```

The guard `!process.env.DORKOS_RELAY_ENABLED` ensures an explicit `DORKOS_RELAY_ENABLED=false` in the user's shell is never overwritten.

**Acceptance criteria:**

- Block inserted between the Pulse block and the Working directory comment
- Comment reads `// Relay: env var > config (no CLI flag for relay)`
- Block does not set `DORKOS_RELAY_ENABLED` when it is already present in the environment
- Uses `cfgMgr.getDot('relay.enabled')` consistent with the Pulse pattern
- `pnpm typecheck` and `pnpm lint` pass

---

## Phase 2 — Verification

### Task 2.1 — Run full test suite and verify all tests pass

**Size:** Small | **Priority:** High | **Dependencies:** 1.1, 1.2, 1.3

No new test files are required. The existing test suite covers all affected paths. The goal is to confirm none of the edits broke any existing assertions.

**Commands:**

```bash
# Full test suite
pnpm test -- --run

# Targeted runs for the most relevant test files
pnpm vitest run apps/server/src/__tests__/env.test.ts
pnpm vitest run packages/shared/src/__tests__/config-schema.test.ts

# Type checking and lint
pnpm typecheck
pnpm lint
```

**Key invariants:**

- `env.test.ts` asserts feature flags "default to false" — this refers to `boolFlag` in `env.ts`, which is unchanged. The test must still pass.
- `config-schema.test.ts` confirms `relay.enabled` and `scheduler.enabled` default to `true` — unchanged, must still pass.

**Acceptance criteria:**

- `pnpm test -- --run` exits with code 0
- `pnpm typecheck` exits with code 0
- `pnpm lint` exits with code 0
- Zero test files were modified during implementation
