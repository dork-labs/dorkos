# Task Breakdown: Dynamic Model Options

**Spec:** `specs/dynamic-model-options/02-specification.md`
**Generated:** 2026-02-27
**Mode:** Full

---

## Phase 1: Foundation (Single Phase)

This feature is small enough to implement in one phase. Tasks 1.1 and 1.2 can run in parallel (shared schema + server are independent concerns). Task 1.3 depends on both. Task 1.4 is the final integration step.

### Task 1.1 — Add ModelOptionSchema to shared schemas and Transport interface

**Size:** Medium | **Priority:** High | **Parallel with:** 1.2

Add the `ModelOptionSchema` Zod schema to `packages/shared/src/schemas.ts` with three string fields (`value`, `displayName`, `description`) and OpenAPI metadata. Re-export the `ModelOption` type from `types.ts`. Extend the `Transport` interface with `getModels(): Promise<ModelOption[]>`. Implement in `HttpTransport` (fetches `GET /models`), `DirectTransport` (hardcoded 3-model fallback), and `createMockTransport` (mock with `vi.fn()`).

**Files touched:**
- `packages/shared/src/schemas.ts` — Add `ModelOptionSchema` + type
- `packages/shared/src/types.ts` — Re-export `ModelOption`
- `packages/shared/src/transport.ts` — Add `getModels()` method
- `apps/client/src/layers/shared/lib/http-transport.ts` — Implement `getModels()`
- `apps/client/src/layers/shared/lib/direct-transport.ts` — Implement `getModels()`
- `packages/test-utils/src/mock-factories.ts` — Add `getModels` mock

---

### Task 1.2 — Add model caching to AgentManager and GET /api/models route

**Size:** Medium | **Priority:** High | **Parallel with:** 1.1

Add `DEFAULT_MODELS` constant and `cachedModels` private field to `AgentManager`. In `sendMessage()`, fire-and-forget call `agentQuery.supportedModels()` on first invocation to populate the cache. Add `getSupportedModels()` public method that returns cached models or defaults. Create `routes/models.ts` with a single `GET /` handler that delegates to `agentManager.getSupportedModels()`. Mount at `/api/models` in `app.ts`. Write unit tests for the caching logic.

**Files touched:**
- `apps/server/src/services/core/agent-manager.ts` — Add caching + public method
- `apps/server/src/routes/models.ts` — New route file
- `apps/server/src/app.ts` — Mount route
- `apps/server/src/services/core/__tests__/agent-manager-models.test.ts` — Unit tests

---

### Task 1.3 — Create useModels hook and update ModelItem with descriptions

**Size:** Medium | **Priority:** High | **Depends on:** 1.1, 1.2

Create `useModels()` TanStack Query hook in `entities/session/model/use-models.ts` with 30-minute `staleTime`. Export from session barrel. Replace `ModelItem.tsx`: remove hardcoded `MODEL_OPTIONS`, consume `useModels()`, update `getModelLabel()` to accept models array, widen dropdown to `w-56`, render `displayName` + `description` on two lines per radio item. Write hook test and component test.

**Files touched:**
- `apps/client/src/layers/entities/session/model/use-models.ts` — New hook
- `apps/client/src/layers/entities/session/index.ts` — Barrel export
- `apps/client/src/layers/features/status/ui/ModelItem.tsx` — Full rewrite
- `apps/client/src/layers/entities/session/__tests__/use-models.test.tsx` — Hook test
- `apps/client/src/layers/features/status/__tests__/ModelItem.test.tsx` — Component test

---

### Task 1.4 — Register ModelOption in OpenAPI spec and verify end-to-end

**Size:** Small | **Priority:** Medium | **Depends on:** 1.1, 1.2, 1.3

Register `ModelOptionSchema` and `GET /api/models` endpoint in `openapi-registry.ts`. Run `pnpm typecheck`, `pnpm lint`, and `pnpm test -- --run` to verify no regressions. Manual verification: model dropdown shows defaults on cold start, SDK models after first query, descriptions visible in dropdown.

**Files touched:**
- `apps/server/src/services/openapi-registry.ts` — Register schema + endpoint

---

## Dependency Graph

```
1.1 (Schema + Transport) ──┐
                            ├──→ 1.3 (Hook + UI) ──→ 1.4 (OpenAPI + Verify)
1.2 (Server + Route)  ─────┘
```

## Summary

| Task | Subject | Size | Dependencies |
|------|---------|------|-------------|
| 1.1 | Schema + Transport interface | Medium | None |
| 1.2 | AgentManager caching + route | Medium | None |
| 1.3 | useModels hook + ModelItem UI | Medium | 1.1, 1.2 |
| 1.4 | OpenAPI + end-to-end verify | Small | 1.1, 1.2, 1.3 |
