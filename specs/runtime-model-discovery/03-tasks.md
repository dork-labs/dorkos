# Task Breakdown: Runtime Model Discovery & Caching

Generated: 2026-04-10
Source: specs/runtime-model-discovery/02-specification.md
Last Decompose: 2026-04-10

## Overview

Replace hardcoded model defaults with SDK-driven model discovery, file-backed caching with 24h TTL, warm-up queries at server startup, and a redesigned model selector UI. The work spans the shared package (schema expansion), server (disk cache, warm-up, session state), and client (remove hardcoded defaults, new ModelConfigPopover component).

## Phase 1: Schema & Types

### Task 1.1: Expand EffortLevelSchema and ModelOptionSchema in shared package

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

**Technical Requirements**:

- Expand `EffortLevelSchema` from 4 to 7 values: `'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'xhigh'`
- Expand `ModelOptionSchema` with 14 new optional fields: `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`, `contextWindow`, `maxOutputTokens`, `provider`, `family`, `tier`, `supportsVision`, `supportsToolUse`, `supportsStreaming`, `supportsCodeExecution`, `isDeprecated`, `isDefault`
- All new fields are optional for backward compatibility

**Implementation Steps**:

1. Update `EffortLevelSchema` in `packages/shared/src/schemas.ts` (line ~96)
2. Replace `ModelOptionSchema` in `packages/shared/src/schemas.ts` (line ~1134) with the expanded version
3. Run `pnpm typecheck` to find downstream breakages from the expanded `EffortLevel` type
4. Update the inline type in `message-sender.ts` `onModelsReceived` callback to use `EffortLevel` import

**Acceptance Criteria**:

- [ ] `EffortLevelSchema` has 7 values
- [ ] `ModelOptionSchema` has all 14 new fields, all optional
- [ ] Existing `ModelOption[]` values still validate
- [ ] `pnpm typecheck` passes

---

### Task 1.2: Add fastMode and autoMode to session schemas

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

**Technical Requirements**:

- Add `fastMode: z.boolean().optional()` and `autoMode: z.boolean().optional()` to `SessionSchema`
- Add same fields to `UpdateSessionRequestSchema`

**Implementation Steps**:

1. Update `SessionSchema` in `packages/shared/src/schemas.ts` (line ~99)
2. Update `UpdateSessionRequestSchema` in `packages/shared/src/schemas.ts` (line ~125)
3. Verify inferred types include new fields

**Acceptance Criteria**:

- [ ] `Session` type includes `fastMode?: boolean` and `autoMode?: boolean`
- [ ] `UpdateSessionRequest` type includes `fastMode?: boolean` and `autoMode?: boolean`
- [ ] `pnpm typecheck` passes

---

## Phase 2: Server -- Disk Cache & Warm-up

### Task 2.1: Add disk cache persistence to RuntimeCache

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- Cache path: `${dorkHome}/cache/runtimes/claude-code/models.json`
- TTL: 24 hours (86,400,000ms)
- `RuntimeCache` constructor accepts `dorkHome` and `runtimeType` parameters
- Fallback chain: memory -> disk -> warm-up -> empty array

**Implementation Steps**:

1. Add `cachePath`, `TTL_MS`, `warmupPromise`, `defaultCwd` fields to `RuntimeCache`
2. Update constructor to accept `dorkHome` and `runtimeType`
3. Implement `loadFromDisk()`, `writeToDisk()`, `isDiskCacheStale()` private methods
4. Change `getSupportedModels()` from sync to async with the fallback chain
5. Remove `DEFAULT_MODELS` import

**Acceptance Criteria**:

- [ ] Disk cache reads/writes correctly
- [ ] Stale cache (>24h) is ignored
- [ ] Corrupt JSON is handled gracefully
- [ ] getSupportedModels() follows memory -> disk -> warm-up -> empty chain

---

### Task 2.2: Implement warm-up query and SDK model mapper

**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: None

**Technical Requirements**:

- `warmup()` creates a never-yielding async iterable, calls `query()`, fetches `supportedModels()`, maps to `ModelOption`, writes to disk, closes query
- Warm-up deduplicates concurrent calls via `warmupPromise`
- `mapSdkModelToModelOption()` maps SDK `ModelInfo` to `ModelOption` with inferred `provider`, `family`, `tier`
- `buildSendCallbacks` always refreshes models (remove first-call guard)

**Implementation Steps**:

1. Create `mapSdkModelToModelOption()` with `extractFamily()` and `inferTier()` helpers
2. Implement `warmup()` with never-yielding iterable and deduplication
3. Update `buildSendCallbacks` to always refresh and use the mapper
4. Update `onModelsReceived` type in `MessageSenderOpts`

**Acceptance Criteria**:

- [ ] Mapper correctly infers tier (flagship/balanced/fast) from model ID
- [ ] Warm-up deduplicates concurrent calls
- [ ] Warm-up clears promise on failure
- [ ] buildSendCallbacks always refreshes and writes to disk

---

### Task 2.3: Update ClaudeCodeRuntime and server startup for warm-up

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.2
**Can run parallel with**: None

**Technical Requirements**:

- `ClaudeCodeRuntime` constructor accepts optional `dorkHome` parameter
- `RuntimeCache` receives `dorkHome` via constructor
- `warmup()` exposed as public method on `ClaudeCodeRuntime`
- `DEFAULT_MODELS` deleted from `runtime-constants.ts`
- Non-blocking `warmup()` call after runtime registration in `index.ts`

**Implementation Steps**:

1. Update `ClaudeCodeRuntime` constructor to accept and pass `dorkHome`
2. Add public `warmup()` method delegating to `cache.warmup()`
3. Delete `DEFAULT_MODELS` from `runtime-constants.ts`
4. Update `index.ts` to pass `dorkHome` and call `warmup()` after registration
5. Update test constructors

**Acceptance Criteria**:

- [ ] Server startup calls `warmup()` non-blocking
- [ ] `DEFAULT_MODELS` is removed from the codebase
- [ ] `pnpm typecheck` passes

---

## Phase 3: Server -- Session State

### Task 3.1: Add fastMode and autoMode to server session state

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

**Technical Requirements**:

- `AgentSession` interface gets `fastMode?: boolean` and `autoMode?: boolean`
- `AgentSession.effort` changes from inline literal union to `EffortLevel` import
- `SessionStore.updateSession()` handles `fastMode`/`autoMode` with `!== undefined` checks
- `message-sender.ts` passes `fastMode`/`autoMode` to SDK options

**Implementation Steps**:

1. Update `AgentSession` interface in `agent-types.ts`
2. Update `SessionStore.updateSession()` in `session-store.ts`
3. Update `message-sender.ts` SDK options building
4. Verify session routes pass through new fields

**Acceptance Criteria**:

- [ ] `fastMode`/`autoMode` persisted in session state
- [ ] `false` is a valid value (not treated as falsy no-op)
- [ ] SDK receives fastMode/autoMode in options
- [ ] PATCH /api/sessions/:id accepts and returns the new fields

---

## Phase 4: Client -- Remove Hardcoded Defaults

### Task 4.1: Remove hardcoded model defaults and derive from useModels

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2, Task 3.1
**Can run parallel with**: None

**Technical Requirements**:

- Delete `DEFAULT_MODEL`, `MODEL_CONTEXT_WINDOWS`, and `getContextWindowForModel` from `use-session-status.ts`
- Default model derived from `useModels()` (first `isDefault`, then first model, then empty string)
- Context window from `ModelOption.contextWindow`
- `SessionStatusData` expanded with `fastMode: boolean` and `autoMode: boolean`
- Full optimistic state handling for new fields

**Implementation Steps**:

1. Delete hardcoded constants and helper function
2. Import `useModels` from same module
3. Derive default model and context window from model data
4. Add `fastMode`/`autoMode` to `SessionStatusData` and optimistic state
5. Update convergence effect for new fields

**Acceptance Criteria**:

- [ ] No hardcoded model constants remain
- [ ] Default model derived from useModels() data
- [ ] Context window from ModelOption.contextWindow
- [ ] fastMode/autoMode in SessionStatusData with full optimistic handling

---

## Phase 5: Client -- Model Config Popover

### Task 5.1: Create ModelConfigPopover component with model cards and effort pills

**Size**: Large
**Priority**: High
**Dependencies**: Task 4.1
**Can run parallel with**: None

**Technical Requirements**:

- Popover-based (not DropdownMenu) -- stays open until dismissed
- Model cards with radio selection, accent left border on selected, context window badge
- Dynamic effort pills from `selectedModel.supportedEffortLevels` + "Default" option
- Mode toggle section (Fast/Auto) only shown when model supports them
- Loading skeleton (3 shimmer rows) and error state with retry button
- Motion animations for dynamic sections (150ms ease-out)

**Implementation Steps**:

1. Create `ModelConfigPopover.tsx` in `features/status/ui/`
2. Implement `ModelCard`, `EffortPills`, `ModeToggles`, `ModelCardSkeleton`, `ModelCardError` sub-components
3. Compose main `ModelConfigPopover` with Popover, AnimatePresence, and dynamic sections
4. Update barrel export in `features/status/index.ts`

**Acceptance Criteria**:

- [ ] Popover stays open until dismissed
- [ ] Dynamic effort pills animate in/out
- [ ] Mode section hidden when model doesn't support fast/auto
- [ ] Loading and error states implemented
- [ ] Barrel export updated

---

### Task 5.2: Integrate ModelConfigPopover into ChatStatusSection and delete ModelItem

**Size**: Small
**Priority**: High
**Dependencies**: Task 5.1
**Can run parallel with**: None

**Technical Requirements**:

- Replace `ModelItem` usage in `ChatStatusSection` with `ModelConfigPopover`
- Wire `fastMode`/`autoMode` props from `status` object
- Delete `ModelItem.tsx`
- Update tests referencing `ModelItem`

**Implementation Steps**:

1. Update import in `ChatStatusSection.tsx`
2. Replace `<ModelItem>` with `<ModelConfigPopover>` passing new props
3. Delete `ModelItem.tsx`
4. Update barrel export
5. Update test references

**Acceptance Criteria**:

- [ ] ChatStatusSection uses ModelConfigPopover
- [ ] ModelItem.tsx is deleted
- [ ] No references to ModelItem remain
- [ ] pnpm typecheck passes

---

## Phase 6: Tests

### Task 6.1: Add server tests for disk cache, warm-up, and model mapper

**Size**: Large
**Priority**: Medium
**Dependencies**: Task 2.3
**Can run parallel with**: Task 6.2

**Technical Requirements**:

- Unit tests for `loadFromDisk`: valid cache, missing file, corrupt JSON, stale TTL
- Unit tests for `writeToDisk`: directory creation, valid JSON output
- Unit tests for `warmup`: SDK call, deduplication, failure handling
- Unit tests for `getSupportedModels` fallback chain
- Unit tests for `mapSdkModelToModelOption`: field mapping, tier inference, family extraction
- Update `claude-code-runtime-models.test.ts` for new behavior (no DEFAULT_MODELS)

**Acceptance Criteria**:

- [ ] All cache lifecycle tests pass
- [ ] Warm-up deduplication tested
- [ ] Mapper tested with various model IDs
- [ ] Existing model test updated
- [ ] Tests use temp directories, cleaned up in afterEach

---

### Task 6.2: Add client tests for ModelConfigPopover and useSessionStatus updates

**Size**: Large
**Priority**: Medium
**Dependencies**: Task 5.2
**Can run parallel with**: Task 6.1

**Technical Requirements**:

- Component tests for `ModelConfigPopover`: trigger render, popover opening, model cards, selection callbacks, effort pills, mode toggles, disabled state, context window badges, loading/error states
- Update tests referencing `ModelItem` or `DEFAULT_MODEL`
- Mock Transport with `getModels` returning test data
- Mock `matchMedia` for responsive support

**Acceptance Criteria**:

- [ ] ModelConfigPopover tested for all states and interactions
- [ ] All old references to ModelItem/DEFAULT_MODEL updated
- [ ] Tests use userEvent for interactions
- [ ] All tests pass with `pnpm vitest run`

---

## Dependency Graph

```
Phase 1 (parallel):
  1.1 ────┐
  1.2 ──┐ │
        │ │
Phase 2 (sequential):
        │ └── 2.1 ── 2.2 ── 2.3
        │
Phase 3:│
        └──── 3.1 (also depends on 1.1)
              │
Phase 4:      │
              └── 4.1
                  │
Phase 5:        │
                  └── 5.1 ── 5.2
                              │
Phase 6 (parallel):           │
              2.3 ── 6.1      │
                       ┘      │
              5.2 ──── 6.2    │
```

## Critical Path

1.1 -> 2.1 -> 2.2 -> 2.3 -> (wait for 3.1) -> 4.1 -> 5.1 -> 5.2 -> 6.2

## Parallel Opportunities

- Tasks 1.1 and 1.2 can run in parallel (independent schema changes)
- Tasks 6.1 and 6.2 can run in parallel (server tests vs client tests)
- Task 3.1 can run in parallel with Phase 2 tasks (only depends on 1.1 + 1.2)
