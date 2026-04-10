---
slug: runtime-model-discovery
number: 230
created: 2026-04-10
status: ideation
design-session: .dork/visual-companion/83310-1775832929
---

# Runtime Model Discovery & Caching

**Slug:** runtime-model-discovery
**Author:** Claude Code
**Date:** 2026-04-10

---

## 1) Intent & Assumptions

**Task brief:** Replace hardcoded model defaults with SDK-driven model discovery, file-backed caching with TTL, and warm-up queries so that DorkOS always shows accurate, up-to-date model and effort level options. Create a universal model capability schema that works across runtimes and providers. Redesign the model selector UI as a grouped card panel that surfaces all available model capabilities (effort, fast mode, auto mode, adaptive thinking).

**Assumptions:**

- The Claude Agent SDK's `Query.supportedModels()` is the authoritative source for available models
- Creating a warm-up query (via never-yielding async iterable) is a supported SDK usage pattern
- Models change infrequently enough that a 24-hour disk cache TTL is sufficient
- The universal schema must be a strict superset of the current `ModelOption` type (backward-compatible)
- Fast mode, auto mode, and adaptive thinking are features we want to surface in the UI now
- The redesigned popover replaces the current `ModelItem.tsx` dropdown

**Out of scope:**

- Multi-runtime support (adding OpenAI/Gemini runtimes) — we design for it but only implement Claude Code
- Pricing/cost display in the model selector
- Token budget control (Gemini-style numeric thinking budgets) — effort levels only for now
- Provider-specific capability extensions in the UI (the schema supports them, the UI doesn't render them yet)
- Redesigning the status bar itself — only the model popover changes

## 2) Pre-reading Log

- `apps/server/src/services/runtimes/claude-code/runtime-cache.ts`: In-memory cache, no persistence, no TTL. `getSupportedModels()` returns `cachedModels ?? DEFAULT_MODELS`. Cache populated via `buildSendCallbacks()` on first message send.
- `apps/server/src/services/runtimes/claude-code/runtime-constants.ts`: `DEFAULT_MODELS` array with 3 hardcoded models (Sonnet 4.5, Haiku 4.5, Opus 4.6). Also contains `CLAUDE_CODE_CAPABILITIES` static flags.
- `apps/server/src/services/runtimes/claude-code/message-sender.ts:277-294`: Non-blocking `agentQuery.supportedModels()` call. Maps SDK `ModelInfo` to `ModelOption`, discarding `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`.
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts:411-413`: `getSupportedModels()` delegates to `this.cache.getSupportedModels()`.
- `apps/server/src/routes/models.ts`: Thin route — `runtime.getSupportedModels()` → `{ models }`.
- `apps/server/src/index.ts:184-186`: `ClaudeCodeRuntime` created with `env.DORKOS_DEFAULT_CWD`, registered in `runtimeRegistry`.
- `apps/server/src/services/core/runtime-registry.ts`: Singleton registry. `getDefault()` returns active runtime. `resolveForAgent()` supports per-agent runtime selection (future multi-runtime).
- `apps/client/src/layers/entities/session/model/use-models.ts`: TanStack Query hook, `staleTime: 30 * 60 * 1000` (30 min). Calls `transport.getModels()`.
- `apps/client/src/layers/entities/session/model/use-session-status.ts:14`: Hardcoded `DEFAULT_MODEL = 'claude-sonnet-4-5-20250929'`. Lines 17-22: hardcoded `MODEL_CONTEXT_WINDOWS` map.
- `apps/client/src/layers/features/status/ui/ModelItem.tsx`: `ResponsiveDropdownMenu` with radio groups. Auto-closes on selection. Effort levels as radio items. No fast mode or auto mode controls.
- `packages/shared/src/schemas.ts:96`: `EffortLevelSchema = z.enum(['low', 'medium', 'high', 'max'])`.
- `packages/shared/src/types.ts`: `ModelOption` type — `value`, `displayName`, `description`, `supportsEffort?`, `supportedEffortLevels?`.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:811-844`: `ModelInfo` type — includes `supportsAdaptiveThinking?`, `supportsFastMode?`, `supportsAutoMode?` beyond what we capture.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1783-1786`: `query()` accepts `prompt: string | AsyncIterable<SDKUserMessage>`. Key insight: never-yielding iterable enables warm-up query.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1652-1664`: `Query.initializationResult()` and `Query.supportedModels()` — both available on any query object.
- `apps/server/src/lib/dork-home.ts`: Single source of truth for data directory (`~/.dork/`).
- `apps/server/src/services/marketplace/marketplace-cache.ts`: Existing file-based cache pattern with TTL — prior art for `~/.dork/cache/` structure.
- `contributing/design-system.md`: Calm Tech design language — card radius 16px, button radius 10px, 8pt grid, 100-300ms animations.
- `specs/dynamic-model-options/02-specification.md`: Existing spec for dynamic model options (predecessor work).

## 3) Codebase Map

**Primary components/modules:**

- `apps/server/src/services/runtimes/claude-code/runtime-cache.ts` — In-memory SDK response cache (models, subagents, MCP status, commands)
- `apps/server/src/services/runtimes/claude-code/runtime-constants.ts` — Hardcoded `DEFAULT_MODELS` and `CLAUDE_CODE_CAPABILITIES`
- `apps/server/src/services/runtimes/claude-code/message-sender.ts` — SDK query execution, model fetch callback
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — Runtime wrapper, delegates to cache
- `apps/server/src/routes/models.ts` — `GET /api/models` thin route
- `apps/server/src/index.ts` — Server startup, runtime registration
- `apps/client/src/layers/features/status/ui/ModelItem.tsx` — Current dropdown-based model selector
- `apps/client/src/layers/entities/session/model/use-models.ts` — TanStack Query hook for fetching models
- `apps/client/src/layers/entities/session/model/use-session-status.ts` — Session config with hardcoded defaults
- `packages/shared/src/types.ts` — `ModelOption` type definition
- `packages/shared/src/schemas.ts` — `ModelOptionSchema`, `EffortLevelSchema` Zod schemas

**Shared dependencies:**

- `packages/shared/src/agent-runtime.ts` — `AgentRuntime` interface with `getSupportedModels()`
- `apps/server/src/lib/dork-home.ts` — Data directory resolution
- `apps/server/src/services/core/runtime-registry.ts` — Runtime registry singleton
- `apps/server/src/services/marketplace/marketplace-cache.ts` — Prior art for file-based caching with TTL

**Data flow:**

```
SDK subprocess → Query.supportedModels() → RuntimeCache (in-memory)
                                              ↓
GET /api/models → runtime.getSupportedModels() → RuntimeCache → response
                                                                  ↓
Client: useModels() → transport.getModels() → TanStack Query cache
                                                     ↓
                                              ModelItem.tsx (popover)
```

**Proposed data flow (with disk cache + warm-up):**

```
Server startup → warmup query (if disk cache stale) → SDK → memory + disk cache
                                                                ↓
GET /api/models → check memory → check disk → warm-up retry → response
                                                                ↓
Message send → SDK → refresh memory + disk cache (background)
```

**Feature flags/config:** None currently. No feature flags needed for this work.

**Potential blast radius:**

- Direct: 11 files (runtime-cache, runtime-constants, message-sender, claude-code-runtime, models route, index.ts, ModelItem.tsx, use-models.ts, use-session-status.ts, types.ts, schemas.ts)
- Indirect: Any component reading `useModels()` or `useSessionStatus()` — currently `ChatStatusSection.tsx`, `ModelItem.tsx`
- Tests: `claude-code-runtime-models.test.ts`, any tests mocking `getSupportedModels()`
- No config/feature flag changes needed

## 4) Root Cause Analysis

N/A — This is a feature enhancement, not a bug fix.

## 5) Research

### 5.1 Cross-Provider Model Capability Survey

Research agent surveyed 8 providers/aggregators: Anthropic (REST API + Agent SDK), OpenAI, Google Gemini, DeepSeek, Mistral, xAI Grok, OpenRouter, and LiteLLM. Key findings:

**Effort/reasoning levels vary across providers:**

| Provider          | Effort Levels                                       | Mechanism                |
| ----------------- | --------------------------------------------------- | ------------------------ |
| Claude            | `low`, `medium`, `high`, `max`                      | `effort` param           |
| OpenAI (o-series) | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` | `reasoning_effort` param |
| Gemini 3.x        | `minimal`, `low`, `medium`, `high`                  | `thinkingLevel` param    |
| Gemini 2.5        | Token budget 0–32768                                | `thinkingBudget` param   |
| Grok              | `low`, `high`                                       | `reasoning_effort` param |
| DeepSeek/Mistral  | N/A                                                 | Reasoning via model ID   |

**Best cross-provider schemas:**

- **OpenRouter** — richest aggregator: modality arrays, `supported_parameters`, pricing
- **LiteLLM** — most exhaustive capability flags: 15+ `supports_*` booleans, deprecation dates
- **Anthropic REST API** (`/v1/models`) — far richer than Agent SDK's `ModelInfo`: nested `capabilities` object with `effort`, `thinking`, `image_input`, `pdf_input`, `structured_outputs`, `code_execution`, `citations`

**UI patterns from competitors:**

- Windsurf lists reasoning levels as separate model entries (UX debt — our effort sub-selector is better)
- Cursor groups by provider with speed badges
- OpenAI Codex CLI shows visual speed + capability indicators
- Continue.dev uses config-driven minimal capability schema

### 5.2 Potential Solutions

**1. Warm-up Query + File Cache (Hybrid)**

- On server start, check disk cache at `~/.dork/cache/runtimes/claude-code/models.json`
- If fresh (< 24h TTL), load into memory
- If stale/missing, create warm-up query (never-yielding iterable), fetch models, write to disk, close query
- On first `GET /api/models`, if cache still empty, retry warm-up before responding
- On every real SDK query, refresh both memory + disk cache
- Pros: Models available immediately, resilient to startup failures, self-healing
- Cons: Warm-up spawns a brief subprocess (~1-2s on cold cache)
- Complexity: Medium
- Maintenance: Low

**2. Lazy-Only (No Warm-up)**

- Same disk cache, but no proactive warm-up on startup
- First `GET /api/models` triggers SDK fetch if cache is cold
- Pros: Simpler, no startup cost
- Cons: First client pays full latency; shows loading skeleton on every cold start
- Complexity: Low
- Maintenance: Low

**3. Anthropic REST API Instead of SDK**

- Use Anthropic's `/v1/models` REST API directly (richer than Agent SDK)
- Returns `capabilities` object with structured flags
- Pros: Richer data, no subprocess needed
- Cons: Requires API key management separate from SDK; would need to reconcile two model sources (REST API models vs SDK-available models may differ); doesn't generalize to non-API runtimes
- Complexity: Medium
- Maintenance: Medium

### 5.3 Recommendation

**Approach 1: Warm-up Query + File Cache** — best combination of reliability, speed, and simplicity. The warm-up cost is negligible (only on cold/stale cache), the file cache makes most server starts instant, and the lazy fallback on `GET /api/models` makes it self-healing. The pattern generalizes cleanly to future runtimes.

### 5.4 Universal Model Capability Schema

Research-backed schema design covering all surveyed providers. The schema is provider-agnostic with typed provider extensions:

**Core fields (all runtimes):** `value`, `displayName`, `description`, `provider`, `family?`, `tier?` (flagship/balanced/fast/specialized), `contextWindow?`, `maxOutputTokens?`, `inputModalities?`, `outputModalities?`

**Capability flags (universal booleans):** `supportsToolUse?`, `supportsStructuredOutput?`, `supportsVision?`, `supportsStreaming?`, `supportsPromptCaching?`, `supportsCodeExecution?`, `supportsComputerUse?`

**Reasoning dimension:** `supportsReasoning?`, `supportsEffort?`, `supportedEffortLevels?` (superset: `none`|`minimal`|`low`|`medium`|`high`|`max`|`xhigh`), `supportsAdaptiveThinking?`, `supportsThinkingBudget?`, `thinkingBudget?` (min/max/default)

**Speed dimension:** `speedVariant?` (`standard`|`fast`|`turbo`), `baseModelValue?`

**Lifecycle:** `isDeprecated?`, `deprecationDate?`, `replacementModelValue?`

**UI hints:** `isDefault?`, `isNew?`, `tags?`

**Provider extensions:** Typed discriminated union keyed by `provider` field — Anthropic, OpenAI, Gemini, Mistral, and generic fallback schemas.

**Backward compatibility:** Current `ModelOption` maps 1:1 to the universal schema's identity + reasoning subset. Migration adds optional fields without breaking existing behavior.

## 6) Decisions

| #   | Decision              | Choice                                      | Rationale                                                                                                                                                                                                                                                                                                 |
| --- | --------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----- | -------- | ------ | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | Warm-up strategy      | Startup + lazy fallback                     | Belt and suspenders: try non-blocking warm-up on server start; if cache is still empty when `GET /api/models` is called, retry before responding. Message-send path remains as final backstop. No single failure point.                                                                                   |
| 2   | ModelInfo passthrough | Full passthrough + universal schema         | Cache and expose all SDK `ModelInfo` fields plus research-backed universal fields. Design a provider-agnostic schema that works for Claude now and future runtimes later. Update UI to surface fast mode, auto mode, adaptive thinking.                                                                   |
| 3   | UI design direction   | B — Grouped Card Panel                      | Spacious model cards with accent border on selection, shared configuration section below with pill-style effort selector and mode toggles. Popover stays open until dismissed (not a dropdown). Dynamic sections animate based on model capabilities. ~320px wide. Selected via visual companion session. |
| 4   | Failure handling      | Graceful degradation with error payload     | If warm-up and lazy retry both fail, return `{ models: [], error: "unable_to_fetch" }` so client can show meaningful message. Message-send path still populates cache when user eventually sends a message.                                                                                               |
| 5   | Cache path convention | `~/.dork/cache/runtimes/{type}/models.json` | Self-documenting, runtime-scoped. Follows existing `~/.dork/cache/marketplace/` pattern. Each runtime manages its own cache directory.                                                                                                                                                                    |
| 6   | TTL                   | 24 hours                                    | Models don't change hourly. Daily refresh catches new releases. Warm-up only runs on cold/stale cache, so most starts are instant (<10ms disk read).                                                                                                                                                      |
| 7   | Hardcoded defaults    | Remove entirely                             | No `DEFAULT_MODELS` in `runtime-constants.ts`. No `DEFAULT_MODEL` in `use-session-status.ts`. No `MODEL_CONTEXT_WINDOWS` map. All model data flows from SDK → cache → API → client. Empty state shows loading skeleton, not stale data.                                                                   |
| 8   | Effort level schema   | Superset enum across providers              | `'none'                                                                                                                                                                                                                                                                                                   | 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'xhigh'`— covers Claude, OpenAI, Gemini, Grok. Each model's`supportedEffortLevels` constrains to its provider's subset. |
