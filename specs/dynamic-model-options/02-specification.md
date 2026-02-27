---
slug: dynamic-model-options
number: 69
created: 2026-02-27
status: draft
---

# Specification: Dynamic Model Options

**Status:** Draft
**Authors:** Claude Code, 2026-02-27
**Ideation:** `specs/dynamic-model-options/01-ideation.md`

## Overview

Replace the hardcoded `MODEL_OPTIONS` array in `ModelItem.tsx` with a dynamic list fetched from the Claude Agent SDK's `supportedModels()` method. The server caches models in-memory after the first SDK query and exposes them via `GET /api/models`. The client fetches via Transport + TanStack Query, showing model descriptions in the dropdown.

## Background / Problem Statement

`ModelItem.tsx` (line 11-15) contains a static array of three models:

```typescript
const MODEL_OPTIONS = [
  { value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
];
```

When Anthropic releases new models, the UI is stale until someone manually updates this array. The Claude Agent SDK already provides `Query.supportedModels()` which returns the authoritative list of available models with display names and descriptions.

## Goals

- Fetch available models dynamically from the SDK
- Cache server-side to avoid repeated SDK calls
- Provide sensible defaults before any SDK query has run
- Show model descriptions in the dropdown UI
- Follow existing Transport/hexagonal architecture patterns (ADR-0001)
- Follow TanStack Query data-fetching patterns (ADR-0005)

## Non-Goals

- Model filtering or favoriting
- Per-user model restrictions
- Model pricing display
- Exposing `supportsEffort` or `supportedEffortLevels` from the SDK (future enhancement)

## Technical Dependencies

- `@anthropic-ai/claude-agent-sdk` (currently `latest`, resolves ~0.2.58) — `Query.supportedModels()` method
- `@tanstack/react-query` (`^5.62.0`) — Client data fetching
- `zod` (`^4.3.6`) — Schema definition

## Detailed Design

### Data Flow

```
SDK query() call
    ↓
agentQuery.supportedModels()  (fire-and-forget, non-blocking)
    ↓
AgentManager.cachedModels  (in-memory cache)
    ↓
GET /api/models  (Express route)
    ↓
HttpTransport.getModels()  (fetchJSON pattern)
    ↓
useModels()  (TanStack Query, 30-min staleTime)
    ↓
ModelItem  (dropdown with displayName + description)
```

### 1. Shared Schema (`packages/shared/src/schemas.ts`)

Add after the `ServerConfig` block (~line 542):

```typescript
// === Model Options ===

export const ModelOptionSchema = z
  .object({
    value: z.string().openapi({ description: 'Model identifier (e.g. claude-opus-4-6)' }),
    displayName: z.string().openapi({ description: 'Human-readable model name' }),
    description: z.string().openapi({ description: 'Short model description' }),
  })
  .openapi('ModelOption');

export type ModelOption = z.infer<typeof ModelOptionSchema>;
```

Export from `packages/shared/src/types.ts`:

```typescript
  ModelOption,
```

**Why a Zod schema instead of importing SDK's `ModelInfo` directly?** The SDK type includes additional fields (`supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`) that we don't need yet. A focused schema keeps the API surface clean, provides OpenAPI metadata, and avoids coupling the shared package to the server-only SDK dependency.

### 2. Server: AgentManager Caching (`apps/server/src/services/core/agent-manager.ts`)

Add to the class:

```typescript
import type { ModelOption } from '@dorkos/shared/types';

const DEFAULT_MODELS: ModelOption[] = [
  { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast, intelligent model for everyday tasks' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest, most compact model' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Most capable model for complex tasks' },
];
```

Private field:

```typescript
private cachedModels: ModelOption[] | null = null;
```

In `sendMessage()`, after `session.activeQuery = agentQuery;` (line 147), add non-blocking model fetch:

```typescript
if (!this.cachedModels) {
  agentQuery.supportedModels().then((models) => {
    this.cachedModels = models.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      description: m.description,
    }));
    logger.debug('[sendMessage] cached supported models', { count: this.cachedModels.length });
  }).catch((err) => {
    logger.debug('[sendMessage] failed to fetch supported models', { err });
  });
}
```

Public method:

```typescript
/** Get available models — returns SDK-reported models if cached, otherwise defaults. */
async getSupportedModels(): Promise<ModelOption[]> {
  return this.cachedModels ?? DEFAULT_MODELS;
}
```

### 3. Server: GET /api/models Route (`apps/server/src/routes/models.ts`)

New file, following the simple GET pattern from `routes/config.ts`:

```typescript
import { Router } from 'express';
import { agentManager } from '../services/core/agent-manager.js';

const router = Router();

/** GET /api/models — list available Claude models. */
router.get('/', async (_req, res) => {
  const models = await agentManager.getSupportedModels();
  res.json({ models });
});

export default router;
```

Mount in `apps/server/src/app.ts` alongside other routes:

```typescript
import modelRoutes from './routes/models.js';
// ...
app.use('/api/models', modelRoutes);
```

### 4. Transport Interface (`packages/shared/src/transport.ts`)

Add `ModelOption` to imports from `./types.js` and add the method after `getConfig()`:

```typescript
/** List available Claude models (dynamic from SDK, with defaults). */
getModels(): Promise<ModelOption[]>;
```

### 5. HttpTransport (`apps/client/src/layers/shared/lib/http-transport.ts`)

Following the `getConfig()` pattern:

```typescript
getModels(): Promise<ModelOption[]> {
  return fetchJSON<{ models: ModelOption[] }>(this.baseUrl, '/models').then((r) => r.models);
}
```

### 6. DirectTransport (`apps/client/src/layers/shared/lib/direct-transport.ts`)

Hardcoded fallback for Obsidian embedded mode:

```typescript
async getModels(): Promise<ModelOption[]> {
  return [
    { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast, intelligent model for everyday tasks' },
    { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest, most compact model' },
    { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Most capable model for complex tasks' },
  ];
}
```

### 7. Mock Transport (`packages/test-utils/src/mock-factories.ts`)

Add before `...overrides`:

```typescript
// Models
getModels: vi.fn().mockResolvedValue([
  { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast model' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Capable model' },
]),
```

### 8. Client Hook: useModels (`apps/client/src/layers/entities/session/model/use-models.ts`)

Following the `useGitStatus` pattern:

```typescript
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { ModelOption } from '@dorkos/shared/types';

/** Fetch available models from the server. Long staleTime since models rarely change. */
export function useModels() {
  const transport = useTransport();

  return useQuery<ModelOption[]>({
    queryKey: ['models'],
    queryFn: () => transport.getModels(),
    staleTime: 30 * 60 * 1000,
  });
}
```

Export from `apps/client/src/layers/entities/session/index.ts`:

```typescript
export { useModels } from './model/use-models';
```

### 9. Updated ModelItem (`apps/client/src/layers/features/status/ui/ModelItem.tsx`)

Complete replacement:

```typescript
import { Bot } from 'lucide-react';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
} from '@/layers/shared/ui';
import { useModels } from '@/layers/entities/session';
import type { ModelOption } from '@dorkos/shared/types';

function getModelLabel(model: string, models: ModelOption[]): string {
  const option = models.find((o) => o.value === model);
  if (option) return option.displayName;
  const match = model.match(/claude-(\w+)-/);
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) : model;
}

interface ModelItemProps {
  model: string;
  onChangeModel: (model: string) => void;
}

export function ModelItem({ model, onChangeModel }: ModelItemProps) {
  const { data: models = [] } = useModels();

  return (
    <ResponsiveDropdownMenu>
      <ResponsiveDropdownMenuTrigger asChild>
        <button className="hover:text-foreground inline-flex items-center gap-1 transition-colors duration-150">
          <Bot className="size-(--size-icon-xs)" />
          <span>{getModelLabel(model, models)}</span>
        </button>
      </ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent side="top" align="start" className="w-56">
        <ResponsiveDropdownMenuLabel>Model</ResponsiveDropdownMenuLabel>
        <ResponsiveDropdownMenuRadioGroup value={model} onValueChange={onChangeModel}>
          {models.map((m) => (
            <ResponsiveDropdownMenuRadioItem key={m.value} value={m.value}>
              <div>
                <div>{m.displayName}</div>
                <div className="text-muted-foreground text-[10px] leading-tight">
                  {m.description}
                </div>
              </div>
            </ResponsiveDropdownMenuRadioItem>
          ))}
        </ResponsiveDropdownMenuRadioGroup>
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}
```

Key changes from current:
- Removed hardcoded `MODEL_OPTIONS`
- `getModelLabel()` takes `models` array as second parameter
- Dropdown widened from `w-44` to `w-56` to fit descriptions
- Each radio item shows `displayName` + `description` on two lines

## User Experience

- **Before first query:** Dropdown shows 3 default models (Sonnet, Haiku, Opus) — same as today
- **After first query:** Dropdown updates to show all models available to the user's account, with descriptions
- **Model selection:** Works identically to current behavior — clicking a model calls `onChangeModel`
- **Dropdown appearance:** Each model shows its name on one line and a small description below it in muted text

## Testing Strategy

### Unit Tests

**1. AgentManager.getSupportedModels** (`apps/server/src/services/core/__tests__/agent-manager-models.test.ts`)

```typescript
describe('AgentManager.getSupportedModels', () => {
  // Purpose: Verify default fallback when no SDK query has run
  it('returns default models when no query has run');

  // Purpose: Verify cached models are returned after population
  it('returns cached models after they are populated');
});
```

**2. useModels hook** (`apps/client/src/layers/entities/session/__tests__/use-models.test.tsx`)

```typescript
describe('useModels', () => {
  // Purpose: Verify hook fetches and returns models from transport
  it('returns model options from transport');
});
```

**3. ModelItem component** (`apps/client/src/layers/features/status/__tests__/ModelItem.test.tsx`)

```typescript
describe('ModelItem', () => {
  // Purpose: Verify the current model's display name renders
  it('renders the current model display name');

  // Purpose: Verify fallback label extraction for unknown model IDs
  it('falls back to extracted name for unknown models');
});
```

### Mocking Strategy

- Server tests: Mock `@anthropic-ai/claude-agent-sdk` via `vi.mock()`
- Client tests: Use `createMockTransport({ getModels: vi.fn().mockResolvedValue([...]) })` with `TransportProvider` wrapper
- Component tests: Mock `motion/react` for animation-free rendering

## Performance Considerations

- **Server:** `supportedModels()` is called once per server lifetime (fire-and-forget, non-blocking). Subsequent requests serve from in-memory cache with zero overhead.
- **Client:** TanStack Query with 30-minute `staleTime` means at most 1 request per 30 minutes. The response is tiny (~500 bytes).
- **Cold start:** No performance impact — defaults are returned synchronously.

## Security Considerations

- No new authentication or authorization required — model list is not sensitive data
- The endpoint inherits existing CORS and middleware protections from Express
- No user input is processed (GET-only, no request body)

## Documentation

- OpenAPI spec auto-updates via `ModelOptionSchema.openapi('ModelOption')` — visible at `/api/docs`
- No external documentation changes needed (this is an internal UX improvement)

## Implementation Phases

### Phase 1: Full Implementation (Single Phase)

This feature is small enough to implement in one pass:

1. Add `ModelOptionSchema` to shared schemas + types
2. Add `getSupportedModels()` + caching to AgentManager
3. Add `GET /api/models` route + mount in app.ts
4. Add `getModels()` to Transport interface + all implementations
5. Create `useModels()` hook + barrel export
6. Update `ModelItem` to use dynamic models with descriptions
7. Write tests for all new code

## Open Questions

None — all decisions were resolved during ideation.

## Related ADRs

- **ADR-0001:** Use Hexagonal Architecture with Transport Interface — governs the pattern for adding `getModels()` across Transport + adapters
- **ADR-0005:** Use Zustand for UI State and TanStack Query for Server State — governs the `useModels()` hook pattern

## References

- Claude Agent SDK `Query` interface: `supportedModels(): Promise<ModelInfo[]>`
- SDK `ModelInfo` type: `{ value, displayName, description, supportsEffort?, supportedEffortLevels?, supportsAdaptiveThinking? }`
- Ideation: `specs/dynamic-model-options/01-ideation.md`
