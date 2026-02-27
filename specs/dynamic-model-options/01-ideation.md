---
slug: dynamic-model-options
number: 69
created: 2026-02-27
status: ideation
---

# Dynamic Model Options

**Slug:** dynamic-model-options
**Author:** Claude Code
**Date:** 2026-02-27
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Replace the hardcoded `MODEL_OPTIONS` array in `ModelItem.tsx` with a dynamic list fetched from the Claude Agent SDK's `supportedModels()` method, so the UI stays current when Anthropic releases new models.
- **Assumptions:**
  - The Agent SDK's `Query.supportedModels()` returns the full list of models available to the current account
  - The model list is stable across the lifetime of a server process (doesn't change mid-session)
  - A sensible fallback list is acceptable before the first SDK query runs
- **Out of scope:**
  - Model filtering/favoriting in the UI
  - Per-user model restrictions
  - Model pricing display

## 2) Pre-reading Log

- `apps/client/src/layers/features/status/ui/ModelItem.tsx`: Current hardcoded `MODEL_OPTIONS` array with 3 models, `getModelLabel()` helper, dropdown rendering
- `apps/client/src/layers/features/status/ui/StatusLine.tsx`: Consumes `ModelItem`, passes `model` and `onChangeModel` from `useSessionStatus`
- `apps/server/src/services/core/agent-manager.ts`: `sendMessage()` creates `query()`, stores on `session.activeQuery`. `updateSession()` sets `session.model`
- `apps/server/src/services/core/agent-types.ts`: `AgentSession` interface with `activeQuery?: Query` (from SDK)
- `packages/shared/src/schemas.ts`: `ServerConfigSchema`, `UpdateSessionRequestSchema` (model is `z.string().optional()`)
- `packages/shared/src/transport.ts`: Transport interface with `getConfig()`, no model-listing method yet
- `apps/client/src/layers/shared/lib/http-transport.ts`: `getConfig()` calls `fetchJSON('/config')`
- `apps/client/src/layers/shared/lib/direct-transport.ts`: `getConfig()` returns hardcoded defaults
- `packages/test-utils/src/mock-factories.ts`: `createMockTransport()` with all Transport methods mocked
- `apps/server/src/app.ts`: Route mounting — simple routes use default exports, feature-flagged routes use factory functions
- Claude Agent SDK docs (Context7): `Query` interface has `supportedModels(): Promise<ModelInfo[]>` returning `{ value, displayName, description }`. Also has `setModel(model?: string)` for live model switching.

## 3) Codebase Map

**Primary components/modules:**
- `apps/client/src/layers/features/status/ui/ModelItem.tsx` — Model selector dropdown (THE file to change)
- `apps/server/src/services/core/agent-manager.ts` — SDK query lifecycle, where `supportedModels()` will be called
- `packages/shared/src/schemas.ts` — Zod schemas (add `ModelOptionSchema`)
- `packages/shared/src/transport.ts` — Transport interface (add `getModels()`)

**Shared dependencies:**
- `@anthropic-ai/claude-agent-sdk` — `Query` interface with `supportedModels()`
- `@tanstack/react-query` — Client data fetching
- `@/layers/shared/model` — `useTransport()` hook for Transport access

**Data flow:**
SDK `query()` call -> `agentQuery.supportedModels()` -> cache in AgentManager -> `GET /api/models` -> HttpTransport -> TanStack Query `useModels()` hook -> ModelItem dropdown

**Feature flags/config:** None — always available

**Potential blast radius:**
- Direct: `ModelItem.tsx`, `agent-manager.ts`, `schemas.ts`, `transport.ts`, transports, mock factory
- Indirect: `StatusLine.tsx` (no changes needed — already passes model prop)
- Tests: New test files for hook and server method; existing ModelItem tests if any

## 5) Research

**Potential solutions:**

**1. SDK `supportedModels()` with server-side caching (Recommended)**
- Description: Call `agentQuery.supportedModels()` after first SDK query, cache in-memory on `AgentManager`, expose via `GET /api/models`
- Pros:
  - Uses the SDK's own API — always returns models available to the current account
  - Zero new dependencies
  - Non-blocking (fire-and-forget cache population during first query)
  - Fallback defaults ensure UI works before any query runs
- Cons:
  - Requires at least one SDK query before the cache is populated
  - If the server never sends a message, users see defaults only
- Complexity: Low
- Maintenance: Low

**2. Anthropic HTTP API `/v1/models`**
- Description: Server calls the Anthropic REST API directly to list models
- Pros:
  - Available immediately at server startup (no query needed)
  - Independent of session lifecycle
- Cons:
  - Requires `ANTHROPIC_API_KEY` env var (the Agent SDK handles auth internally)
  - Adds a new HTTP dependency and error path
  - Duplicates what the SDK already provides
- Complexity: Medium
- Maintenance: Medium

**3. Server-side config file**
- Description: Store model list in `~/.dork/config.json`, let users customize
- Pros:
  - User-customizable
  - No network calls
- Cons:
  - Still hardcoded, just in a different location
  - Doesn't auto-update when new models release
  - Users have to manually maintain the list
- Complexity: Low
- Maintenance: High (for users)

**Recommendation:** Approach 1 — SDK `supportedModels()` with server-side caching. It's the simplest path that actually solves the problem. The fallback defaults cover the cold-start case cleanly.

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Model data source | SDK `supportedModels()` | The SDK already exposes this method on the `Query` interface — no need for separate API keys or HTTP calls |
| 2 | Caching strategy | In-memory on AgentManager, populated on first query | Models don't change mid-session; fire-and-forget avoids blocking the streaming pipeline |
| 3 | Cold-start fallback | Hardcoded defaults (Sonnet 4.5, Haiku 4.5, Opus 4.6) | Ensures the dropdown works before any SDK query runs |
| 4 | Description display | Show in dropdown below model name | User requested descriptions be included in the UI |
| 5 | Hook placement | `entities/session/model/use-models.ts` | Models are session-adjacent; FSD rules allow features to import from entities |
