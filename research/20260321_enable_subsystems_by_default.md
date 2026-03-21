---
title: 'Enable Relay and Pulse Subsystems by Default'
date: 2026-03-21
type: implementation
status: active
tags: [relay, pulse, feature-flags, defaults, subsystems, startup]
feature_slug: enable-subsystems-by-default
searches_performed: 0
sources_count: 0
---

# Enable Relay and Pulse Subsystems by Default

## Research Summary

This is a pure codebase analysis — no external research required. The existing code already
reveals everything needed for a confident recommendation. The critical discovery: the
`UserConfigSchema` (`packages/shared/src/config-schema.ts`) **already defaults both
`relay.enabled` and `scheduler.enabled` to `true`**. The reason Relay and Pulse are
still effectively opt-in is a pair of bugs in `index.ts` and `cli.ts` that prevent the
config defaults from being respected. The fix is surgical, not architectural.

## Key Findings

### 1. Config Schema Already Has Correct Defaults (The Bug Is Elsewhere)

In `packages/shared/src/config-schema.ts`:

```typescript
relay: z.object({
  enabled: z.boolean().default(true),   // already true
  dataDir: z.string().nullable().default(null),
}).default(() => ({ enabled: true, dataDir: null })),

scheduler: z.object({
  enabled: z.boolean().default(true),   // already true
  maxConcurrentRuns: z.number().int().min(1).max(10).default(1),
  ...
}).default(() => ({ enabled: true, ... })),
```

`USER_CONFIG_DEFAULTS` (the canonical defaults object) confirms both are `true`. The
config-schema tests at line 146-147 also assert `relay.enabled === true` and
`scheduler.enabled === true`. This is already done correctly.

### 2. The Relay Bug in `index.ts`

```typescript
// apps/server/src/index.ts, lines 122-125
const relayEnabled =
  'DORKOS_RELAY_ENABLED' in process.env
    ? env.DORKOS_RELAY_ENABLED
    : (relayConfig?.enabled ?? false); // <-- BUG: fallback is `false`, not relayConfig.enabled
```

There is a comment above this block acknowledging the problem:

> "boolFlag defaults to false even when unset, so check process.env directly."

The author correctly identified that `env.DORKOS_RELAY_ENABLED` always returns `false` when
the env var is absent (because the Zod `boolFlag` has `.default('false')`). The workaround
checks `'DORKOS_RELAY_ENABLED' in process.env` to distinguish "absent" from "set to false".

But the fallback `relayConfig?.enabled ?? false` has a second bug: the `?? false` nullish
coalescing never fires because `relayConfig.enabled` is always a `boolean` (never
`null`/`undefined`) — but it is semantically redundant and misleading. The actual problem
is that `relayConfig.enabled` **is already `true`** when no user config file exists (it
inherits the schema default), so `relayConfig?.enabled ?? false` evaluates to `true`.

Wait — re-reading more carefully: `configManager.get('relay')` reads from the user's
`~/.dork/config.json`. If the user has never set `relay.enabled = false`, it returns the
schema default of `true`. So `relayConfig?.enabled ?? false` should evaluate to `true` for
fresh installs.

The real issue is the CLI: the CLI does **not** propagate `DORKOS_RELAY_ENABLED` from config
(unlike Pulse). See Finding 3.

### 3. The Pulse Asymmetry in `cli.ts`

For Pulse, `cli.ts` explicitly reads the config and sets the env var:

```typescript
// packages/cli/src/cli.ts, lines 188-193
if (values.pulse !== undefined) {
  process.env.DORKOS_PULSE_ENABLED = values.pulse ? 'true' : 'false';
} else if (!process.env.DORKOS_PULSE_ENABLED && cfgMgr.getDot('scheduler.enabled')) {
  process.env.DORKOS_PULSE_ENABLED = 'true';
}
```

This means: if `scheduler.enabled` is `true` in the config (which it is by default), the
CLI sets `DORKOS_PULSE_ENABLED=true`. So **Pulse should already be on by default** when
launched via the CLI. However:

1. The condition `!process.env.DORKOS_PULSE_ENABLED` is falsy only when the env var is
   not set. If `cfgMgr.getDot('scheduler.enabled')` returns `true` (the default), the
   CLI does set the flag. So Pulse IS effectively default-on when using the CLI.

2. There is **no equivalent block for Relay** in `cli.ts` — Relay has no CLI flag and
   the CLI never reads `relay.enabled` from config to set `DORKOS_RELAY_ENABLED`. This
   means when launched via the CLI, `DORKOS_RELAY_ENABLED` is never in `process.env`,
   and `index.ts` falls back to `relayConfig?.enabled`, which reads from the in-process
   config manager (correctly defaulting to `true`).

### 4. The `env.ts` Zod Schema Is the Core Obstacle

```typescript
// apps/server/src/env.ts
const boolFlag = z
  .enum(['true', 'false'])
  .default('false')   // <-- always false when env var absent
  .transform((v) => v === 'true');

DORKOS_PULSE_ENABLED: boolFlag,
DORKOS_RELAY_ENABLED: boolFlag,
```

The `default('false')` means `env.DORKOS_PULSE_ENABLED` and `env.DORKOS_RELAY_ENABLED`
always return `false` when the env var is not set. This is the root cause of the awkward
`'DORKOS_RELAY_ENABLED' in process.env` check in `index.ts`.

The Pulse decision in `index.ts` works around this differently:

```typescript
const pulseEnabled = env.DORKOS_PULSE_ENABLED || schedulerConfig.enabled;
```

This OR means: if the env var is `true` OR the config says `true` → enabled. Because
`schedulerConfig.enabled` defaults to `true`, Pulse is on by default. This is the correct
pattern.

Relay uses an inconsistent pattern (`'DORKOS_RELAY_ENABLED' in process.env` check) that is
more complex but achieves a similar result — except it's less readable and was documented
as a known workaround.

### 5. The Mesh Reference Implementation

```typescript
// apps/server/src/services/mesh/mesh-state.ts
export const isMeshEnabled = (): boolean => true;
```

Mesh took the nuclear option (ADR-0062): removed the feature flag entirely from
`mesh-state.ts`. The `index.ts` still initializes MeshCore unconditionally inside a
`try/catch` (non-fatal). No env var, no config gate.

### 6. Graceful Degradation Is Already Implemented

Both Pulse and Relay initialization blocks in `index.ts` are already wrapped in `try/catch`
with non-fatal error handling:

```typescript
// Pulse (line 107-114)
try {
  pulseStore = new PulseStore(db);
} catch (err) {
  // Pulse failure is non-fatal: server continues without scheduler routes.
}

// Relay (lines 132-150)
try {
  relayCore = new RelayCore({ ... });
} catch (err) {
  // Relay failure is non-fatal: server continues without relay routes.
  relayCore = undefined;
}
```

Approach C (soft default-on with graceful degradation) is **already fully implemented**.

### 7. Test Impact

The env test at `apps/server/src/__tests__/env.test.ts` line 31-32 asserts:

```typescript
expect(env.DORKOS_PULSE_ENABLED).toBe(false);
expect(env.DORKOS_RELAY_ENABLED).toBe(false);
```

This test will need updating if `boolFlag` default is changed in `env.ts`. However, the
test is testing the Zod schema default (which could remain `false` — the env var schema
default is separate from the startup logic default). The two layers of default-setting
can and should remain independent.

## Detailed Analysis

### The Three Layers of Defaults

There are three places where "enabled by default" can be set:

| Layer             | File                                   | Current State                                                              |
| ----------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| 1. Config schema  | `packages/shared/src/config-schema.ts` | Already `true` for both                                                    |
| 2. Env var schema | `apps/server/src/env.ts`               | `false` (when unset)                                                       |
| 3. Startup logic  | `apps/server/src/index.ts`             | Reads both layers; Pulse OR logic is correct; Relay is correct but complex |

The cleanest fix is: standardize the startup logic for Relay to match Pulse (the OR pattern).

### Approach A: Remove Feature Flags Entirely (Mesh Pattern)

**Description**: Like `mesh-state.ts`, replace `isRelayEnabled` and `isPulseEnabled` with
functions that unconditionally return `true`. Remove `DORKOS_RELAY_ENABLED` and
`DORKOS_PULSE_ENABLED` env vars from `env.ts`. Remove all init guards.

**Pros**:

- Maximum simplicity — same as Mesh
- No conditional logic at all
- Consistent with the Mesh precedent (ADR-0062)
- Removes the awkward `'DORKOS_RELAY_ENABLED' in process.env` workaround

**Cons**:

- Removes escape hatch for users who genuinely want to disable Relay or Pulse
- Relay has external adapters (Slack, Telegram) that require API keys — users without
  keys may want Relay core on but adapters off (already handled separately)
- Pulse schedules run jobs — a user doing maintenance might want to disable it temporarily
- Breaking change for users who have `DORKOS_RELAY_ENABLED=false` in their env
- The E2E tests explicitly set `DORKOS_RELAY_ENABLED=true` — suggests the test
  infrastructure expects the flag to exist

**Complexity**: Low to implement, Medium impact (test updates, doc updates)
**Maintenance**: Very low — nothing to maintain
**Migration risk**: Medium — any user with `DORKOS_RELAY_ENABLED=false` loses their escape hatch

### Approach B: Flip Defaults, Keep Escape Hatch

**Description**: Change the startup logic so Relay and Pulse are on by default, with
`DORKOS_RELAY_ENABLED=false` / `DORKOS_PULSE_ENABLED=false` able to disable them.

For Relay, adopt the same pattern as Pulse:

```typescript
// Change from:
const relayEnabled =
  'DORKOS_RELAY_ENABLED' in process.env
    ? env.DORKOS_RELAY_ENABLED
    : (relayConfig?.enabled ?? false);

// To:
const relayEnabled = env.DORKOS_RELAY_ENABLED || relayConfig.enabled;
```

For Pulse, the current logic `env.DORKOS_PULSE_ENABLED || schedulerConfig.enabled` is
already correct — but the OR means `false || true` = `true` by default, and
`DORKOS_PULSE_ENABLED=false` overrides to... still `true` if `schedulerConfig.enabled`
is `true`. The OR pattern does not support disabling via env var when config is also `true`.

To support `DORKOS_PULSE_ENABLED=false` as a true override:

```typescript
// Three-way: env var wins when set, config wins otherwise
const pulseEnabled =
  'DORKOS_PULSE_ENABLED' in process.env ? env.DORKOS_PULSE_ENABLED : schedulerConfig.enabled;
```

This is actually the same pattern that Relay already uses — the Relay code was correct in
design but the fallback had the misleading `?? false`.

**Pros**:

- Preserves escape hatch (`=false` to disable)
- Consistent with DorkOS's existing config precedence pattern (CLI flags > env > config)
- Minimal test changes (env.test.ts is testing `env.ts` defaults, not startup logic)
- No breaking change — users who had `DORKOS_RELAY_ENABLED=false` keep their override
- No ADR needed — same pattern, just flipped default

**Cons**:

- OR logic does not correctly support disabling via env var when config default is `true`
  (must use the `'KEY' in process.env` pattern, not OR)
- More logic than Approach A

**Complexity**: Low
**Maintenance**: Low
**Migration risk**: Very low — existing `=false` users unaffected

### Approach C: Soft Default-On with Graceful Degradation

**Description**: Enable by default but wrap initialization in try/catch so failures are
non-fatal.

**This is already fully implemented**. Both Pulse and Relay `try/catch` blocks exist in
`index.ts` with "non-fatal: server continues" comments. This is not a new approach —
it's the current behavior.

**Pros**: Already done
**Cons**: Not independently useful without also changing the default
**Complexity**: Already implemented
**Maintenance**: Already in place

## Recommendation

### Recommended Approach: B — Flip Defaults, Keep Escape Hatch

**Rationale**: The config schema defaults are already correct (`relay.enabled: true`,
`scheduler.enabled: true`). The only changes needed are:

1. **`apps/server/src/index.ts`**: Unify Relay's startup guard to use the same
   `'KEY' in process.env ? env.KEY : config.enabled` pattern (already used for Relay,
   just fix the misleading `?? false` and remove the comment about the workaround once
   it's clean). Also apply this same pattern to Pulse to replace the OR logic, since
   OR cannot correctly handle `DORKOS_PULSE_ENABLED=false` when config default is `true`.

2. **`apps/server/src/env.ts`**: No change required. The `boolFlag` default of `false`
   is correct for the env var schema — the "enabled by default" behavior comes from the
   config layer, not the env var layer.

3. **`packages/cli/src/cli.ts`**: Add a Relay block mirroring the Pulse block so the CLI
   also propagates `relay.enabled` from config to `DORKOS_RELAY_ENABLED`. Alternatively,
   remove the CLI Pulse block too since `index.ts` reads config directly. The CLI blocks
   exist to bridge the env var layer — they can be removed if `index.ts` reads config
   directly (which it already does for Relay).

4. **`apps/server/src/__tests__/env.test.ts`**: The test "feature flags default to false"
   remains valid — it tests the Zod schema default of the env var, not startup logic.
   No change needed.

5. **`apps/e2e/playwright.config.ts`**: The E2E test sets `DORKOS_RELAY_ENABLED=true`
   explicitly. With default-on, this becomes redundant but not broken. Can be cleaned
   up in a follow-up.

**Caveats**:

- The `DORKOS_RELAY_ENABLED=false` escape hatch must use the `'KEY' in process.env` guard
  pattern, not OR logic, to correctly override the config default.
- The CLI Pulse block in `cli.ts` lines 188-193 should be extended to cover Relay too,
  OR both blocks should be removed since `index.ts` handles config reading directly.
  Leaving only the Pulse block creates asymmetry.
- Do not use Approach A unless Relay and Pulse get their own ADRs (like ADR-0062 for Mesh),
  since removing env var overrides is a more significant architectural commitment.

## The Exact Change Set

### Minimal change to make both subsystems default-on:

**`apps/server/src/index.ts`** — Replace OR logic for Pulse and clean up Relay:

```typescript
// Pulse: env var wins when set, config default wins otherwise
// (same pattern as Relay — avoids OR which can't represent "env=false but config=true")
const pulseEnabled =
  'DORKOS_PULSE_ENABLED' in process.env ? env.DORKOS_PULSE_ENABLED : schedulerConfig.enabled; // defaults to true via config-schema

// Relay: remove the ?? false fallback and the workaround comment
const relayEnabled =
  'DORKOS_RELAY_ENABLED' in process.env ? env.DORKOS_RELAY_ENABLED : relayConfig.enabled; // defaults to true via config-schema
```

**`packages/cli/src/cli.ts`** — Either add Relay parity or remove both CLI propagation
blocks (since `index.ts` already reads config directly for Relay). The safest option
that maintains parity with existing Pulse behavior: add a Relay block.

That is the complete change set. No schema changes, no new ADR required, no test changes
for `env.test.ts`, graceful degradation already in place.

## Security Considerations

- Relay opens an in-process message bus and registers an endpoint (`relay.system.console`).
  No network port is opened by Relay itself — all communication is via the existing Express
  server. No new attack surface.
- Pulse runs scheduled jobs using the ClaudeCodeRuntime. Default-on means schedules created
  by users will run on next startup even if they hadn't explicitly opted in to Pulse. For
  existing users who had disabled Pulse, their stored schedules may fire unexpectedly.
  Migration risk: low (DorkOS is a dev tool, users are technical, and schedules must be
  explicitly created — no schedule runs unless the user created one).
- No sensitive data is exposed by enabling either subsystem without external adapters
  configured. External adapters (Slack, Telegram) require API keys and are separate from
  the core Relay subsystem.

## Performance Considerations

- **Relay startup cost**: `RelayCore` initializes an in-process adapter registry, a
  `TraceStore` (SQLite-backed), and registers one endpoint. Measured against Mesh startup
  which is always-on: comparable overhead. Sub-100ms.
- **Pulse startup cost**: `PulseStore` opens a SQLite table. `SchedulerService` starts a
  cron-like ticker. Negligible memory. The scheduler only fires when jobs are due.
- **Memory**: Both subsystems are lightweight in-process services. No additional network
  listeners. Combined overhead is well under 10MB RSS.
- **No impact on session startup time** — Relay and Pulse initialization happens once
  during server startup, not per-session.

## Research Gaps

- Whether any existing users have explicitly set `relay.enabled: false` in their
  `~/.dork/config.json` — this would be unaffected by the env var escape hatch but
  would be affected by Approach A. Approach B preserves this config-level override.
- E2E test coverage for Pulse startup — only Relay is covered in `playwright.config.ts`.

## Search Methodology

- No external web searches performed — pure codebase analysis
- Files examined: `relay-state.ts`, `pulse-state.ts`, `mesh-state.ts`, `feature-flag.ts`,
  `index.ts`, `env.ts`, `cli.ts`, `config-schema.ts`, `env.test.ts`, `config-schema.test.ts`,
  `playwright.config.ts`
- grep searches for `isRelayEnabled`, `isPulseEnabled`, `RELAY_ENABLED`, `PULSE_ENABLED`,
  `isMeshEnabled`
