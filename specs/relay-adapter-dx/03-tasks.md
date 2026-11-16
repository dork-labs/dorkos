# Task Breakdown: Relay Adapter DX Improvements

Generated: 2026-03-11
Source: specs/relay-adapter-dx/02-specification.md
Last Decompose: 2026-03-11

## Overview

Resolve six DX gaps in the relay adapter system: eliminate adapter boilerplate via an optional `BaseRelayAdapter` abstract class, fix the plugin factory signature bug, add API versioning, provide a compliance test suite, standardize directory structure, and create an adapter template. Zero breaking changes to existing imports.

## Phase 1: Foundation

### Task 1.1: Create BaseRelayAdapter abstract class

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3

**Technical Requirements**:

- Create `packages/relay/src/base-adapter.ts` with an abstract class implementing `RelayAdapter`
- Handles: status initialization, start/stop idempotency guards, error recording, relay ref lifecycle, message count tracking
- Subclasses implement `_start()`, `_stop()`, and `deliver()`
- `start()` transitions through `starting` -> `connected` states, re-throws errors after `recordError()`
- `stop()` transitions through `stopping` -> `disconnected` in a `finally` block
- `getStatus()` returns a shallow copy
- `trackOutbound()` / `trackInbound()` increment respective message counts
- `recordError(err)` sets state to `'error'`, increments `errorCount`, records `lastError` and `lastErrorAt`

**Implementation Steps**:

1. Create `packages/relay/src/base-adapter.ts` with the full abstract class
2. Export `BaseRelayAdapter` from `packages/relay/src/index.ts`
3. Write 12 unit tests in `packages/relay/src/__tests__/base-adapter.test.ts` using a concrete `TestAdapter` subclass

**Acceptance Criteria**:

- [ ] `BaseRelayAdapter` exported from `@dorkos/relay`
- [ ] All 12 unit tests pass (initial status, start lifecycle, stop lifecycle, idempotency, error handling, tracking, getStatus copy, relay ref lifecycle)
- [ ] `pnpm typecheck` passes
- [ ] Existing adapter implementations continue to work unchanged

---

### Task 1.2: Fix plugin factory signature to pass adapter id

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3

**Technical Requirements**:

- Update `AdapterPluginModule.default` type from `(config) => RelayAdapter` to `(id, config) => RelayAdapter`
- Update `builtinMap` parameter type in `loadAdapters()` to match
- Pass `entry.id` as first argument at both built-in and plugin factory call sites
- Update existing tests to expect the new call signature

**Implementation Steps**:

1. Update `AdapterPluginModule` interface in `adapter-plugin-loader.ts`
2. Update `builtinMap` type in `loadAdapters()` function signature
3. Update `factory(entry.config)` -> `factory(entry.id, entry.config)` at both call sites
4. Update `validateAndCreate()` internal function
5. Update existing tests and add new test validating id is passed
6. Check and update any `builtinMap` construction in `apps/server/`

**Acceptance Criteria**:

- [ ] Factory signature is `(id: string, config: Record<string, unknown>) => RelayAdapter`
- [ ] `loadAdapters()` passes `entry.id` to factories
- [ ] All existing + new tests pass
- [ ] `pnpm typecheck` passes across the monorepo

---

### Task 1.3: Add RELAY_ADAPTER_API_VERSION constant

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2

**Technical Requirements**:

- Create `packages/relay/src/version.ts` with `RELAY_ADAPTER_API_VERSION = '0.1.0'`
- Export from `packages/relay/src/index.ts`
- Simple manual `major.minor` comparison (no `semver` dependency)

**Implementation Steps**:

1. Create `packages/relay/src/version.ts`
2. Add export to `packages/relay/src/index.ts`
3. Write 3 tests in `packages/relay/src/__tests__/version.test.ts`

**Acceptance Criteria**:

- [ ] `RELAY_ADAPTER_API_VERSION` exported from `@dorkos/relay`
- [ ] Value is `'0.1.0'`
- [ ] Tests validate export, format, and value

---

## Phase 2: Quality Infrastructure

### Task 2.1: Add apiVersion field to AdapterManifest schema

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Add `apiVersion: z.string().optional()` to `AdapterManifestSchema` in `packages/shared/src/relay-adapter-schemas.ts`
- Non-breaking additive change (field is optional)

**Implementation Steps**:

1. Add the field to `AdapterManifestSchema`
2. Verify existing tests pass without changes

**Acceptance Criteria**:

- [ ] `AdapterManifest` type includes `apiVersion?: string`
- [ ] All existing manifest validation tests pass
- [ ] `pnpm typecheck` passes

---

### Task 2.2: Create mock relay utilities for adapter testing

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- Create `packages/relay/src/testing/` directory with mock utilities
- `createMockRelayPublisher()` returns a mock `RelayPublisher` with `vi.fn()` stubs
- `createMockRelayEnvelope(overrides?)` returns a valid `RelayEnvelope` with defaults
- Add `./testing` subpath export to `packages/relay/package.json`

**Implementation Steps**:

1. Create `packages/relay/src/testing/mock-relay-publisher.ts`
2. Create `packages/relay/src/testing/mock-relay-envelope.ts`
3. Create `packages/relay/src/testing/index.ts` barrel
4. Add `./testing` export to `package.json`

**Acceptance Criteria**:

- [ ] Mock utilities importable from `@dorkos/relay/testing`
- [ ] `createMockRelayEnvelope()` supports overrides
- [ ] `pnpm typecheck` passes

---

### Task 2.3: Create compliance test suite for adapter validation

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 2.2
**Can run parallel with**: Task 2.4

**Technical Requirements**:

- Create `packages/relay/src/testing/compliance-suite.ts` with `runAdapterComplianceSuite()`
- Suite validates: shape compliance (id, subjectPrefix, displayName, methods), status lifecycle, getStatus shape and copy semantics, start/stop idempotency, deliver returns a result, testConnection shape
- 11 test cases in total
- Export from `@dorkos/relay/testing`

**Implementation Steps**:

1. Create `compliance-suite.ts` with the `ComplianceSuiteOptions` interface and `runAdapterComplianceSuite()` function
2. Update `testing/index.ts` barrel with compliance suite exports
3. Write self-test in `packages/relay/src/testing/__tests__/compliance-suite.test.ts`

**Acceptance Criteria**:

- [ ] `runAdapterComplianceSuite()` exported from `@dorkos/relay/testing`
- [ ] Self-test with `MinimalTestAdapter` passes all 11 compliance checks
- [ ] Mock utility tests pass
- [ ] `pnpm typecheck` passes

---

### Task 2.4: Add API version check to plugin loader

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.3

**Technical Requirements**:

- Add `checkApiVersion()` function to `adapter-plugin-loader.ts`
- Warning-level log only, never blocks loading
- Check runs after `extractManifest()` for plugin-loaded adapters
- Major version mismatch: warn
- Adapter minor > host minor: warn (adapter expects newer features)
- No apiVersion declared: skip check
- Adapter minor <= host minor: no warning

**Implementation Steps**:

1. Import `RELAY_ADAPTER_API_VERSION` in `adapter-plugin-loader.ts`
2. Add `checkApiVersion()` function (export with `@internal` for testing)
3. Call after `extractManifest()` in both npm package and local file paths
4. Write 5 unit tests for version check logic

**Acceptance Criteria**:

- [ ] Version check runs after manifest extraction
- [ ] Correct warning behavior for all version comparison cases
- [ ] Never blocks adapter loading
- [ ] All tests pass

---

## Phase 3: Consistency

### Task 3.1: Move webhook adapter into subdirectory

**Size**: Small
**Priority**: Medium
**Dependencies**: None
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- Move `webhook-adapter.ts` from `src/adapters/` to `src/adapters/webhook/`
- Create barrel `src/adapters/webhook/index.ts`
- Move test file into `src/adapters/webhook/__tests__/`
- Update import in `src/index.ts` barrel
- Update internal import paths (`../types.js` -> `../../types.js`)

**Implementation Steps**:

1. Create `packages/relay/src/adapters/webhook/` directory
2. Move `webhook-adapter.ts` and update its internal imports
3. Create `index.ts` barrel
4. Move test file and update its imports
5. Update `src/index.ts` barrel export path
6. Delete old file

**Acceptance Criteria**:

- [ ] WebhookAdapter at `src/adapters/webhook/webhook-adapter.ts`
- [ ] Barrel export at `src/adapters/webhook/index.ts`
- [ ] Test at `src/adapters/webhook/__tests__/webhook-adapter.test.ts`
- [ ] All imports via `@dorkos/relay` unchanged
- [ ] `pnpm test` and `pnpm typecheck` pass

---

### Task 3.2: Co-locate adapter tests into per-adapter **tests** directories

**Size**: Small
**Priority**: Medium
**Dependencies**: None
**Can run parallel with**: Task 3.1

**Technical Requirements**:

- Move Telegram test from `src/__tests__/adapters/` into `src/adapters/telegram/__tests__/`
- Move Claude Code tests from `src/adapters/__tests__/` into `src/adapters/claude-code/__tests__/`
- Update all import paths in moved test files
- Delete empty parent `__tests__/` directories

**Implementation Steps**:

1. Move and update Telegram test
2. Move and update Claude Code tests (2 files)
3. Clean up empty directories
4. Verify no broken references

**Acceptance Criteria**:

- [ ] All adapter tests co-located in per-adapter `__tests__/` directories
- [ ] Empty parent directories removed
- [ ] All tests pass with updated paths
- [ ] Consistent directory structure across all adapters

---

### Task 3.3: Run compliance suite on built-in adapters

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 2.3, Task 3.1, Task 3.2
**Can run parallel with**: None

**Technical Requirements**:

- Add `runAdapterComplianceSuite()` to WebhookAdapter's test file
- Document why Telegram and Claude Code adapters skip the compliance suite (external API dependencies)
- Validates both the suite and the adapters

**Implementation Steps**:

1. Add compliance suite call to webhook adapter test file
2. Add explanatory comments to Telegram and Claude Code test files

**Acceptance Criteria**:

- [ ] Compliance suite passes for WebhookAdapter
- [ ] Comments explain Telegram/Claude Code skipping
- [ ] `pnpm test` passes

---

## Phase 4: Ecosystem

### Task 4.1: Create adapter template directory

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.1, Task 1.3, Task 2.3
**Can run parallel with**: Task 4.2

**Technical Requirements**:

- Create `templates/relay-adapter/` with: package.json, tsconfig.json, src/index.ts, src/my-adapter.ts, src/**tests**/my-adapter.test.ts, README.md
- Template adapter extends `BaseRelayAdapter`
- Factory function uses correct `(id, config)` signature
- Manifest includes `apiVersion: RELAY_ADAPTER_API_VERSION`
- Test file uses `runAdapterComplianceSuite()`
- README provides actionable 6-step quick-start

**Implementation Steps**:

1. Create directory structure
2. Write all template files with complete, valid TypeScript
3. Write README with step-by-step guide

**Acceptance Criteria**:

- [ ] Template at `templates/relay-adapter/`
- [ ] All TypeScript files syntactically valid
- [ ] Factory signature matches updated plugin loader
- [ ] Manifest includes apiVersion
- [ ] Test uses compliance suite
- [ ] README is concise and actionable

---

### Task 4.2: Update contributing guide and ADR documentation

**Size**: Medium
**Priority**: Low
**Dependencies**: Task 1.1, 1.2, 1.3, 2.3, 2.4, 4.1
**Can run parallel with**: None

**Technical Requirements**:

- Update (or create) `contributing/relay-adapters.md` with sections for: BaseRelayAdapter, factory signature, compliance suite, API versioning, template quick-start
- Update ADR 0030 to document the `id` parameter addition
- All code examples must be syntactically valid TypeScript

**Implementation Steps**:

1. Add/update sections in `contributing/relay-adapters.md`
2. Update `decisions/0030-dynamic-import-for-adapter-plugins.md`
3. Verify all links and code examples

**Acceptance Criteria**:

- [ ] Contributing guide covers all new DX features
- [ ] ADR 0030 documents factory signature change
- [ ] All code examples are valid TypeScript
- [ ] No broken links

---

## Dependency Graph

```
Phase 1 (all parallel):
  1.1 BaseRelayAdapter ─────────────────────┐
  1.2 Fix factory signature ────────────────┤
  1.3 API version constant ─────┐           │
                                │           │
Phase 2:                        │           │
  2.1 apiVersion schema field ──┤ (parallel)│
  2.2 Mock utilities ───────────┤           │
                                │           │
  2.3 Compliance suite ─────────┤ (needs 1.1, 2.2)
  2.4 Version check ────────────┘ (needs 1.3)
                                │
Phase 3:                        │
  3.1 Move webhook ─────────────┤ (parallel)
  3.2 Co-locate tests ──────────┤
  3.3 Run suite on builtins ────┘ (needs 2.3, 3.1, 3.2)
                                │
Phase 4:                        │
  4.1 Adapter template ─────────┤ (needs 1.1, 1.3, 2.3)
  4.2 Documentation ────────────┘ (needs all above)
```

## Critical Path

1.1 -> 2.3 -> 3.3 -> 4.2 (longest chain through compliance suite integration)

## Parallel Opportunities

- **Phase 1**: All three tasks (1.1, 1.2, 1.3) are independent
- **Phase 2**: Tasks 2.1 and 2.2 are independent; 2.3 and 2.4 can run in parallel
- **Phase 3**: Tasks 3.1 and 3.2 are independent file moves
- **Phase 4**: Task 4.1 can run parallel with 4.2 if 4.2's dependencies are met
