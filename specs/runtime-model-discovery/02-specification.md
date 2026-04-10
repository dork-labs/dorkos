---
slug: runtime-model-discovery
number: 230
created: 2026-04-10
status: specified
ideation: specs/runtime-model-discovery/01-ideation.md
design-session: .dork/visual-companion/83310-1775832929
---

# Runtime Model Discovery & Caching — Specification

## Overview

Replace hardcoded model defaults with SDK-driven model discovery, file-backed caching with TTL, and warm-up queries. Create a universal model capability schema that works across runtimes. Redesign the model selector UI as a grouped card popover that surfaces effort levels, fast mode, auto mode, and adaptive thinking.

**Why:** On initial load (before any message is sent), users see a hardcoded list of 3 models that can become outdated. The Claude Agent SDK reports the authoritative model list, but we only fetch it on first message send. Model metadata (fast mode, auto mode, adaptive thinking) is discarded. There is no disk persistence — every server restart resets to stale defaults.

**What changes for users:** The model selector becomes a richer tuning panel. Models are always accurate and up-to-date. New capabilities (fast mode, auto mode) are visible and controllable per-session.

## Goals

1. Models are always accurate — sourced from SDK, never hardcoded
2. Models are available fast — disk cache makes most server starts instant (<10ms)
3. Self-healing — startup failure + lazy fallback + message-send backstop = no single failure point
4. Universal schema — designed for multi-runtime future, implemented for Claude Code now
5. Full SDK passthrough — all `ModelInfo` fields cached and exposed
6. Redesigned model popover — grouped cards, effort pills, mode toggles, stays open until dismissed

## Non-Goals

- Adding non-Claude runtimes (OpenAI, Gemini) — schema supports it, implementation doesn't
- Pricing/cost display in the model selector
- Token budget control (Gemini-style numeric thinking budgets)
- Provider-specific capability extensions in the UI
- Redesigning the status bar itself

---

## Technical Design

### 1. Universal Model Schema

Expand `ModelOptionSchema` in `packages/shared/src/schemas.ts` to a universal schema. The current schema is a strict subset — all new fields are optional, maintaining backward compatibility.

**Effort level expansion:**

```typescript
// Current: z.enum(['low', 'medium', 'high', 'max'])
// New: superset covering Claude, OpenAI, Gemini, Grok
export const EffortLevelSchema = z
  .enum(['none', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh'])
  .openapi('EffortLevel');
```

**Expanded ModelOptionSchema:**

```typescript
export const ModelOptionSchema = z
  .object({
    // --- Identity (existing, unchanged) ---
    value: z.string().openapi({ description: 'Model identifier (e.g. claude-opus-4-6)' }),
    displayName: z.string().openapi({ description: 'Human-readable model name' }),
    description: z.string().openapi({ description: 'Short model description' }),

    // --- Reasoning (existing + expanded) ---
    supportsEffort: z.boolean().optional(),
    supportedEffortLevels: z.array(EffortLevelSchema).optional(),
    supportsAdaptiveThinking: z
      .boolean()
      .optional()
      .openapi({ description: 'Claude decides when and how much to think' }),

    // --- Speed variants (new) ---
    supportsFastMode: z
      .boolean()
      .optional()
      .openapi({ description: 'Whether this model supports fast output mode' }),
    supportsAutoMode: z
      .boolean()
      .optional()
      .openapi({ description: 'Whether this model supports auto mode' }),

    // --- Context (new) ---
    contextWindow: z.number().int().optional().openapi({ description: 'Maximum input tokens' }),
    maxOutputTokens: z.number().int().optional().openapi({ description: 'Maximum output tokens' }),

    // --- Provider metadata (new, for future multi-runtime) ---
    provider: z
      .string()
      .optional()
      .openapi({ description: 'Provider identifier (e.g. anthropic, openai)' }),
    family: z.string().optional().openapi({ description: 'Model family (e.g. claude-4, gpt-5)' }),
    tier: z
      .enum(['flagship', 'balanced', 'fast', 'specialized', 'legacy'])
      .optional()
      .openapi({ description: 'Model tier for UI grouping' }),

    // --- Capability flags (new, for future use) ---
    supportsVision: z.boolean().optional(),
    supportsToolUse: z.boolean().optional(),
    supportsStreaming: z.boolean().optional(),
    supportsCodeExecution: z.boolean().optional(),

    // --- Lifecycle (new) ---
    isDeprecated: z.boolean().optional(),
    isDefault: z.boolean().optional().openapi({ description: 'Suggested as default selection' }),
  })
  .openapi('ModelOption');
```

The type `ModelOption` is inferred from this schema. No separate type definition needed.

### 2. Session State Expansion

Add `fastMode` and `autoMode` to session state, session schema, and update request.

**AgentSession** (`agent-types.ts`):

```typescript
export interface AgentSession {
  // ... existing fields ...
  model?: string;
  effort?: EffortLevel;
  fastMode?: boolean; // NEW
  autoMode?: boolean; // NEW
}
```

**SessionSchema** (`schemas.ts`):

```typescript
export const SessionSchema = z.object({
  // ... existing fields ...
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
  fastMode: z.boolean().optional(), // NEW
  autoMode: z.boolean().optional(), // NEW
});
```

**UpdateSessionRequestSchema** (`schemas.ts`):

```typescript
export const UpdateSessionRequestSchema = z.object({
  // ... existing fields ...
  effort: EffortLevelSchema.optional(),
  fastMode: z.boolean().optional(), // NEW
  autoMode: z.boolean().optional(), // NEW
});
```

**SessionStore.updateSession** (`session-store.ts`) — add:

```typescript
if (opts.fastMode !== undefined) session.fastMode = opts.fastMode;
if (opts.autoMode !== undefined) session.autoMode = opts.autoMode;
```

**message-sender.ts** — pass to SDK options:

```typescript
if (session.fastMode) sdkOptions.fastMode = true;
if (session.autoMode) sdkOptions.autoMode = true;
```

### 3. Disk Cache

**Path:** `${dorkHome}/cache/runtimes/claude-code/models.json`

**Format:**

```typescript
interface ModelDiskCache {
  /** Cached model list from SDK */
  models: ModelOption[];
  /** ISO timestamp of when models were fetched */
  fetchedAt: string;
  /** SDK version that reported these models */
  sdkVersion: string;
  /** Cache format version for future migrations */
  version: 1;
}
```

**TTL:** 24 hours. `Date.now() - Date.parse(fetchedAt) > 86_400_000` → stale.

**Convention:** `${dorkHome}/cache/runtimes/{runtime-type}/models.json` — each runtime manages its own cache. The `dorkHome` path is passed as a constructor parameter (per `dork-home.md` convention).

### 4. RuntimeCache Expansion

Expand `RuntimeCache` (`runtime-cache.ts`) with disk persistence and warm-up:

```typescript
export class RuntimeCache {
  private cachedModels: ModelOption[] | null = null;
  private warmupPromise: Promise<void> | null = null;
  private readonly cachePath: string;
  private readonly TTL_MS = 86_400_000; // 24 hours

  constructor(dorkHome: string, runtimeType: string = 'claude-code') {
    this.cachePath = path.join(dorkHome, 'cache', 'runtimes', runtimeType, 'models.json');
  }
```

**New methods:**

```typescript
/** Load models from disk cache if fresh. Returns true if loaded. */
private loadFromDisk(): boolean

/** Write current in-memory models to disk. */
private writeToDisk(): void

/** Check if disk cache is stale (> TTL or missing). */
private isDiskCacheStale(): boolean

/**
 * Warm up the model cache. Creates a temporary SDK query
 * (never-yielding async iterable), fetches models, closes query.
 * Non-blocking — returns a promise. Safe to call multiple times
 * (deduplicates via warmupPromise).
 */
async warmup(cwd: string): Promise<void>

/**
 * Get models with lazy fallback. If memory cache is empty,
 * checks disk. If disk is stale/missing, triggers warm-up
 * with a short timeout.
 */
async getSupportedModels(): Promise<ModelOption[]>
```

**Warm-up implementation:**

```typescript
async warmup(cwd: string): Promise<void> {
  // Deduplicate concurrent warm-up calls
  if (this.warmupPromise) return this.warmupPromise;

  this.warmupPromise = (async () => {
    try {
      // Create a query with a never-yielding async iterable
      const neverYield = async function* () { /* never yields */ };
      const agentQuery = query({ prompt: neverYield(), options: { cwd } });

      const models = await agentQuery.supportedModels();
      this.cachedModels = models.map(mapSdkModelToModelOption);
      this.writeToDisk();

      agentQuery.close();
    } catch (err) {
      logger.warn('[RuntimeCache] warm-up failed', { err });
    } finally {
      this.warmupPromise = null;
    }
  })();

  return this.warmupPromise;
}
```

**getSupportedModels with lazy fallback:**

```typescript
async getSupportedModels(): Promise<ModelOption[]> {
  // 1. Memory cache (fastest)
  if (this.cachedModels) return this.cachedModels;

  // 2. Disk cache
  if (this.loadFromDisk()) return this.cachedModels!;

  // 3. Lazy warm-up with timeout
  try {
    await Promise.race([
      this.warmup(this.defaultCwd),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('warmup timeout')), 3000)
      ),
    ]);
    if (this.cachedModels) return this.cachedModels;
  } catch {
    logger.debug('[RuntimeCache] lazy warm-up timed out or failed');
  }

  // 4. Empty — client shows loading state
  return [];
}
```

**Note:** `getSupportedModels()` changes from sync to async. The `AgentRuntime` interface already declares it as `Promise<ModelOption[]>`, so this is compatible.

### 5. SDK ModelInfo → ModelOption Mapper

New function in `runtime-cache.ts` or a dedicated `model-mapper.ts`:

```typescript
function mapSdkModelToModelOption(m: ModelInfo): ModelOption {
  return {
    value: m.value,
    displayName: m.displayName,
    description: m.description,
    supportsEffort: m.supportsEffort,
    supportedEffortLevels: m.supportedEffortLevels,
    supportsAdaptiveThinking: m.supportsAdaptiveThinking,
    supportsFastMode: m.supportsFastMode,
    supportsAutoMode: m.supportsAutoMode,
    // Provider metadata (hardcoded for Claude Code runtime)
    provider: 'anthropic',
    family: extractFamily(m.value), // e.g., 'claude-opus-4' from 'claude-opus-4-6'
    tier: inferTier(m.value), // flagship/balanced/fast from model ID
  };
}
```

### 6. Cache Refresh on Message Send

The existing `buildSendCallbacks` pattern remains but now always refreshes (not just on first call):

```typescript
buildSendCallbacks(cwdKey: string): CacheCallbacks {
  return {
    onModelsReceived: (models) => {
      this.cachedModels = models.map(mapSdkModelToModelOption);
      this.writeToDisk();
      logger.debug('[sendMessage] refreshed model cache', { count: models.length });
    },
    // ... other callbacks unchanged
  };
}
```

Remove the `!this.cachedModels ?` guard — always refresh on message send to keep the cache warm.

### 7. Server Startup Integration

In `apps/server/src/index.ts`, after runtime registration:

```typescript
// Non-blocking warm-up — doesn't delay server listen
if (claudeRuntime) {
  claudeRuntime.warmup(dorkHome).catch((err) => {
    logger.warn('[Startup] Model warm-up failed (will retry on first API call)', { err });
  });
}
```

`ClaudeCodeRuntime` exposes `warmup(dorkHome: string)` which delegates to `this.cache.warmup(this.cwd)`.

### 8. API Response Changes

**`GET /api/models`** — response shape unchanged: `{ models: ModelOption[] }`. The `ModelOption` type is expanded but all new fields are optional, so existing clients are not broken.

On failure: `{ models: [], error: 'unable_to_fetch' }`.

**`GET /api/sessions/:id`** — response includes new `fastMode` and `autoMode` fields.

**`PATCH /api/sessions/:id`** — accepts new `fastMode` and `autoMode` in request body.

### 9. Client Transport

Add `fastMode` and `autoMode` to the `UpdateSessionRequest` type in `session-methods.ts`. No new transport methods needed — `getModels()` and `updateSession()` already exist.

### 10. Remove Hardcoded Defaults

**Delete:**

- `DEFAULT_MODELS` from `runtime-constants.ts`
- `DEFAULT_MODEL` constant from `use-session-status.ts`
- `MODEL_CONTEXT_WINDOWS` map from `use-session-status.ts`

**Replace:**

- `use-session-status.ts` derives default model from `useModels()` data: first model in the list, or the one marked `isDefault: true`
- Context window comes from `ModelOption.contextWindow` (populated by SDK via `initializationResult()` or `ModelUsage.contextWindow`)

### 11. Client Hook Changes

**`useModels()`** — add `isLoading` and `isError` to return value. Already provided by TanStack Query, just needs to be exposed:

```typescript
export function useModels() {
  const transport = useTransport();
  const query = useQuery<ModelOption[]>({
    queryKey: ['models'],
    queryFn: () => transport.getModels(),
    staleTime: 30 * 60 * 1000,
  });
  return query; // includes data, isLoading, isError
}
```

**`useSessionStatus()`** — add `fastMode` and `autoMode` to `SessionStatusData`:

```typescript
export interface SessionStatusData {
  permissionMode: PermissionMode;
  model: string;
  effort: EffortLevel | null;
  fastMode: boolean; // NEW
  autoMode: boolean; // NEW
  costUsd: number | null;
  contextPercent: number | null;
  isStreaming: boolean;
  cwd: string | null;
}
```

Derive default model from `useModels()`:

```typescript
const { data: models } = useModels();
const defaultModel = models?.find((m) => m.isDefault)?.value ?? models?.[0]?.value ?? '';
const model =
  localModel ?? (isStreaming ? streamingStatus?.model : null) ?? session?.model ?? defaultModel;
```

---

## UI Design: Model Configuration Popover

### Component: `ModelConfigPopover`

Replaces current `ModelItem.tsx`. Lives at `features/status/ui/ModelConfigPopover.tsx`.

**Architecture:** Uses `Popover` (not `DropdownMenu`) so it stays open until dismissed. Selecting a model or toggling effort does NOT auto-close the panel.

### Layout (Design B — Grouped Card Panel)

```
┌────────────────────────────────┐
│ ┌────────────────────────────┐ │
│ │ ● Opus 4.6          200K  │ │  ← selected: accent left border + bg tint
│ │   Most capable for complex │ │
│ │   tasks                    │ │
│ └────────────────────────────┘ │
│ ┌────────────────────────────┐ │
│ │ ○ Sonnet 4.5         200K │ │  ← unselected: subtle border, muted
│ │   Fast, intelligent model  │ │
│ └────────────────────────────┘ │
│ ┌────────────────────────────┐ │
│ │ ○ Haiku 4.5          200K │ │
│ │   Fastest, most compact    │ │
│ └────────────────────────────┘ │
│                                │
│ ─── Configuration ──────────── │
│                                │
│ Effort                         │
│ [Default] [Low] [Med] [High] [Max] │  ← pill/segment buttons
│                                │
│ Mode                           │
│ [■ Fast] [□ Auto]             │  ← pill toggles
│                                │
└────────────────────────────────┘
```

### Props

```typescript
interface ModelConfigPopoverProps {
  model: string;
  onChangeModel: (model: string) => void;
  effort: EffortLevel | null;
  onChangeEffort: (effort: EffortLevel | null) => void;
  fastMode: boolean;
  onChangeFastMode: (enabled: boolean) => void;
  autoMode: boolean;
  onChangeAutoMode: (enabled: boolean) => void;
  disabled?: boolean;
}
```

### Trigger (status bar button)

```
[Bot icon] Opus 4.6 · High
```

Shows: model display name + current effort badge. When fast mode is active, append a "Fast" badge.

### Dynamic Behavior

1. **Model selection** — clicking a model card updates the selected model. The Configuration section below updates to show only the capabilities of the newly selected model.
2. **Effort pills** — only the levels in `selectedModel.supportedEffortLevels` are shown. "Default" option always present (sends `null`). When switching from Opus (supports `max`) to Sonnet (doesn't), the `max` pill animates out (150ms motion).
3. **Mode section** — only shown when the selected model has `supportsFastMode || supportsAutoMode`. Individual toggles only appear if the corresponding `supports*` flag is true. If neither mode is supported, the entire section (including the "Mode" label and divider) is hidden.
4. **Context window badge** — shown as a subtle monospace chip (e.g., "200K") on each model card, sourced from `ModelOption.contextWindow`.
5. **Loading state** — when `useModels()` is loading, show skeleton cards (3 shimmer rows) inside the popover.
6. **Error state** — when `useModels()` returns an error (unable_to_fetch), show a compact error message inside the popover with a retry button.

### Animation

- Sections appear/disappear with `motion` layout animations (150ms ease-out)
- Model card selection: border color transition (150ms)
- Pill button active state: background transition (100ms)

### FSD Layer Placement

- `ModelConfigPopover` → `features/status/ui/ModelConfigPopover.tsx` (replaces `ModelItem.tsx`)
- `useModels` → `entities/session/model/use-models.ts` (unchanged)
- `useSessionStatus` → `entities/session/model/use-session-status.ts` (expanded)

---

## Implementation Phases

### Phase 1: Schema & Types (shared package)

1. Expand `EffortLevelSchema` to superset enum
2. Expand `ModelOptionSchema` with new fields
3. Add `fastMode`, `autoMode` to `SessionSchema` and `UpdateSessionRequestSchema`
4. Run `pnpm typecheck` to find downstream breakages

### Phase 2: Server — Disk Cache & Warm-up

1. Add `cachePath`, `loadFromDisk()`, `writeToDisk()`, `isDiskCacheStale()` to `RuntimeCache`
2. Change `RuntimeCache` constructor to accept `dorkHome` + `runtimeType`
3. Update `getSupportedModels()` to async with memory → disk → warm-up chain
4. Implement `warmup()` with never-yielding iterable pattern
5. Create `mapSdkModelToModelOption()` mapper (pass through all SDK fields)
6. Update `buildSendCallbacks()` to always refresh (remove first-call guard)
7. Remove `DEFAULT_MODELS` from `runtime-constants.ts`
8. Update `ClaudeCodeRuntime` constructor to pass `dorkHome` to `RuntimeCache`
9. Add `warmup()` to `ClaudeCodeRuntime` public API
10. Add non-blocking `claudeRuntime.warmup()` call in `index.ts` after registration

### Phase 3: Server — Session State

1. Add `fastMode`, `autoMode` to `AgentSession` interface
2. Update `SessionStore.updateSession()` to handle `fastMode`, `autoMode`
3. Update `message-sender.ts` to pass `fastMode`, `autoMode` to SDK options
4. Update session routes to include new fields in response

### Phase 4: Client — Remove Hardcoded Defaults

1. Remove `DEFAULT_MODEL` constant from `use-session-status.ts`
2. Remove `MODEL_CONTEXT_WINDOWS` map from `use-session-status.ts`
3. Derive default model from `useModels()` data
4. Add `fastMode`, `autoMode` to `SessionStatusData` and `updateSession()`
5. Update `useSessionStatus` optimistic state handling for new fields

### Phase 5: Client — Model Config Popover

1. Create `ModelConfigPopover.tsx` (Popover-based, not DropdownMenu)
2. Implement model card list with radio selection
3. Implement effort pill selector with dynamic levels
4. Implement mode toggle section with dynamic visibility
5. Implement loading skeleton and error state
6. Add motion animations for dynamic sections
7. Update `ChatStatusSection.tsx` to use `ModelConfigPopover`
8. Delete old `ModelItem.tsx`

### Phase 6: Tests

1. Update `claude-code-runtime-models.test.ts` for new cache behavior
2. Add tests for disk cache read/write/TTL
3. Add tests for warm-up query (mock SDK)
4. Add tests for lazy fallback chain
5. Add tests for `mapSdkModelToModelOption`
6. Update any tests referencing `DEFAULT_MODELS`
7. Add component tests for `ModelConfigPopover` (loading, error, dynamic sections)

---

## Testing Strategy

### Unit Tests (Server)

- **RuntimeCache.loadFromDisk** — reads valid cache, handles missing file, handles corrupt JSON, respects TTL
- **RuntimeCache.writeToDisk** — creates directory if missing, writes valid JSON
- **RuntimeCache.warmup** — calls SDK, caches result, handles SDK failure, deduplicates concurrent calls
- **RuntimeCache.getSupportedModels** — memory → disk → warmup chain, timeout on warmup, returns empty on total failure
- **mapSdkModelToModelOption** — maps all SDK fields, infers provider/family/tier

### Unit Tests (Client)

- **ModelConfigPopover** — renders model cards, shows/hides effort levels based on model, shows/hides mode toggles, loading skeleton, error state with retry
- **useSessionStatus** — derives default from `useModels()`, handles fastMode/autoMode optimistic updates

### Integration Tests

- **GET /api/models** — returns cached models, returns empty on failure, refreshes after warm-up
- **PATCH /api/sessions/:id** — accepts and persists fastMode/autoMode

---

## Migration & Backward Compatibility

- All new `ModelOption` fields are optional → existing code continues to work
- `EffortLevelSchema` expands from 4 to 7 values → existing `'low'|'medium'|'high'|'max'` values are all still valid
- `GET /api/models` response shape unchanged — same `{ models: ModelOption[] }`
- `UpdateSessionRequest` adds optional fields — existing clients sending only `model`/`effort` are unaffected
- The Obsidian plugin's `DirectTransport` returns models from the same `AgentRuntime.getSupportedModels()` contract — no separate change needed
- Old disk cache files (pre-migration) are simply missing — `loadFromDisk()` returns false, triggers warm-up

---

## File Change Summary

| File                                                                   | Change                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/shared/src/schemas.ts`                                       | Expand `EffortLevelSchema`, `ModelOptionSchema`, `SessionSchema`, `UpdateSessionRequestSchema` |
| `packages/shared/src/types.ts`                                         | Type inference updates automatically from schema changes                                       |
| `packages/shared/src/agent-runtime.ts`                                 | No change (already `Promise<ModelOption[]>`)                                                   |
| `apps/server/src/services/runtimes/claude-code/runtime-cache.ts`       | Major: add disk cache, warm-up, async getSupportedModels, mapper                               |
| `apps/server/src/services/runtimes/claude-code/runtime-constants.ts`   | Delete `DEFAULT_MODELS`                                                                        |
| `apps/server/src/services/runtimes/claude-code/message-sender.ts`      | Always refresh models on send; pass fastMode/autoMode to SDK                                   |
| `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` | Pass dorkHome to RuntimeCache, expose warmup()                                                 |
| `apps/server/src/services/runtimes/claude-code/agent-types.ts`         | Add `fastMode`, `autoMode` to AgentSession                                                     |
| `apps/server/src/services/runtimes/claude-code/session-store.ts`       | Handle fastMode/autoMode in updateSession                                                      |
| `apps/server/src/routes/models.ts`                                     | No change (already delegates to runtime)                                                       |
| `apps/server/src/index.ts`                                             | Add non-blocking warmup() call after runtime registration                                      |
| `apps/client/src/layers/features/status/ui/ModelConfigPopover.tsx`     | New: replaces ModelItem.tsx                                                                    |
| `apps/client/src/layers/features/status/ui/ModelItem.tsx`              | Delete                                                                                         |
| `apps/client/src/layers/features/status/ui/ChatStatusSection.tsx`      | Use ModelConfigPopover instead of ModelItem                                                    |
| `apps/client/src/layers/entities/session/model/use-models.ts`          | Expose isLoading/isError from TanStack Query                                                   |
| `apps/client/src/layers/entities/session/model/use-session-status.ts`  | Remove hardcoded defaults; add fastMode/autoMode; derive default from useModels                |
| `apps/client/src/layers/features/status/index.ts`                      | Update barrel export                                                                           |
| `apps/client/src/layers/entities/session/index.ts`                     | No change needed                                                                               |
