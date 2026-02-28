---
slug: relay-mesh-telegram-review-fixes
number: 73
created: 2026-02-28
status: ideation
---

# Relay, Mesh & Telegram Adapter — Code Review Remediation

**Slug:** relay-mesh-telegram-review-fixes
**Author:** Claude Code
**Date:** 2026-02-28
**Branch:** preflight/relay-mesh-telegram-review-fixes
**Related:** Specs #50 (Relay Core), #53 (External Adapters), #54 (Mesh Core), #56 (Mesh Integration), #71 (Adapter-Agent Routing)

---

## 1) Intent & Assumptions

- **Task brief:** Fix all critical and important issues identified in a comprehensive code review of the Relay subsystem (binding-router, adapter-manager, relay-core), Mesh UI (TopologyGraph, AgentNode, BindingEdge), and the Telegram adapter. Also split relay-core.ts (1028 lines) into focused modules.
- **Assumptions:**
  - All issues were verified at exact line numbers against current HEAD
  - We fix critical + important severity issues only (skip suggestions like hysteresis, DRY card refactors, relativeTime extraction)
  - We write tests for code we change, not backfilling unrelated gaps
  - relay-core.ts split is included despite being a "suggestion" — user explicitly requested it
- **Out of scope:**
  - AgentNode DefaultCard/ExpandedCard deduplication (suggestion-tier)
  - `useLodBand` hysteresis (cosmetic UX polish)
  - `relativeTime` extraction to shared lib
  - BindingEdge hover mechanism refactor
  - `edited_message` / `channel_post` Telegram handlers (feature addition, not a fix)
  - Backfilling test gaps for untouched code (AgentNode tests, compact LOD tests)

## 2) Pre-reading Log

- `apps/server/src/services/relay/binding-router.ts`: Session routing with per-chat/per-user strategies. Race condition in getOrCreateSession, no error handling in handleInbound, unbounded sessionMap.
- `apps/server/src/services/relay/adapter-manager.ts`: Adapter lifecycle with config persistence. Non-atomic saveConfig, timer leak in testConnection, misleading variable naming, duplicate status shape.
- `packages/relay/src/relay-core.ts`: Core pub/sub with adapter delivery. 1028 lines. Timer leaks, console.warn instead of logger, dynamic imports in hot paths.
- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx`: 763 lines. Unsafe type casts, missing button types, inline style tag, stale callback refs.
- `apps/client/src/layers/features/mesh/ui/AgentNode.tsx`: 371 lines. Card duplication noted but out of scope.
- `apps/client/src/layers/features/mesh/ui/BindingEdge.tsx`: 118 lines. Hover via local state noted but out of scope.
- `packages/relay/src/adapters/telegram-adapter.ts`: 619 lines. Missing webhook secret, no input length limits, no reconnection, no server hardening.
- `apps/server/src/services/relay/__tests__/binding-router.test.ts`: Existing tests cover happy paths. Need failure path tests for new error handling.

## 3) Codebase Map

**Primary files to modify:**

| File | Lines | Changes |
|------|-------|---------|
| `packages/relay/src/relay-core.ts` | 1028 | Split into modules, fix timer leaks, static imports, replace console.warn |
| `apps/server/src/services/relay/binding-router.ts` | 224 | Add in-flight lock, try/catch, session TTL |
| `apps/server/src/services/relay/adapter-manager.ts` | 628 | Atomic saveConfig, fix timer leak, rename agentId, extract status helper |
| `packages/relay/src/adapters/telegram-adapter.ts` | 619 | Webhook secret, input length cap, server hardening, reconnection backoff, status reset |
| `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx` | 763 | Type safety, button types, extract inline styles |

**New files to create:**

| File | Purpose |
|------|---------|
| `packages/relay/src/adapter-delivery.ts` | Extracted adapter delivery pipeline from relay-core |
| `packages/relay/src/subscription-registry.ts` | Already exists — may receive methods from relay-core |
| `packages/relay/src/relay-metrics.ts` | Extracted metrics aggregation from relay-core |
| `apps/client/src/layers/features/mesh/ui/topology-graph.css` | Extracted inline styles |

**Shared dependencies:**
- `@dorkos/shared/relay-schemas` — TelegramAdapterConfigSchema may need `webhookSecret` field
- `packages/relay/src/endpoint-registry.ts` — `hashSubject` import moved to static

**Potential blast radius:**
- Direct: 5 files modified, 3-4 new files created
- Indirect: Any code importing from `relay-core.ts` must update import paths after split
- Tests: binding-router tests need failure path additions, relay-core tests need import updates

## 4) Root Cause Analysis

N/A — this is a remediation pass, not a bug fix for a single issue.

## 5) Research

No external research needed. All issues are well-understood patterns:

- **Race condition fix**: In-flight promise map (standard async dedup pattern)
- **Timer leaks**: `clearTimeout` in `finally` block (standard Promise.race cleanup)
- **Atomic writes**: tmp file + `rename()` (already used elsewhere in codebase)
- **Webhook security**: grammY `secretToken` option (documented in grammY API)
- **Reconnection**: Exponential backoff with jitter (standard resilience pattern)
- **File splitting**: Extract by responsibility boundary (adapter delivery, metrics, subscriptions)

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Scope | Critical + Important only | Best impact-to-risk ratio. Skip suggestions (DRY refactors, hysteresis, relativeTime). |
| 2 | relay-core.ts split | Include in this pass | User explicitly requested. 1028 lines is 2x the 500-line limit. |
| 3 | Test strategy | Tests for changed code only | Cover new error handling, race condition lock, timer cleanup. Don't backfill AgentNode/BindingEdge tests. |

---

## 7) Issue Inventory (In-Scope)

### Critical (3)

| # | Subsystem | Issue | File:Line | Fix |
|---|-----------|-------|-----------|-----|
| C1 | Relay | Race condition in `getOrCreateSession` — concurrent messages create duplicate sessions | `binding-router.ts:151-158` | Add per-key in-flight promise map |
| C2 | Relay | `handleInbound` has no try/catch — unhandled rejection crashes subscription | `binding-router.ts:96-122` | Wrap body in try/catch with error logging |
| C3 | Telegram | Webhook has no secret token — anyone can inject fake updates | `telegram-adapter.ts:480-500` | Add `webhookSecret` to config, pass to `setWebhook` + `webhookCallback` |

### Important (8)

| # | Subsystem | Issue | File:Line | Fix |
|---|-----------|-------|-----------|-----|
| I1 | Relay | Timer leak in `deliverToAdapter` — setTimeout never cleared | `relay-core.ts:816-824` | Store timer ref, clearTimeout in finally |
| I2 | Relay | Timer leak in `testConnection` | `adapter-manager.ts:386-394` | Same pattern as I1 |
| I3 | Relay | `console.warn` instead of logger | `relay-core.ts:843` | Replace with structured logger call |
| I4 | Relay | Dynamic import of `hashSubject` in hot paths | `relay-core.ts:360, 828` | Move to static top-level import |
| I5 | Relay | `saveConfig` not atomic | `adapter-manager.ts:621-628` | Use tmp+rename pattern |
| I6 | Relay | Unbounded sessionMap growth | `binding-router.ts:53` | Add configurable max-size with LRU eviction |
| I7 | Telegram | No reconnection logic for polling | `telegram-adapter.ts:454-469` | Exponential backoff reconnection (5s, 10s, 30s, 60s, max 5 retries) |
| I8 | Telegram | Webhook server has no timeout/size limits | `telegram-adapter.ts:493-499` | Set headersTimeout, requestTimeout, maxHeadersCount |

### Important — UI (3)

| # | Subsystem | Issue | File:Line | Fix |
|---|-----------|-------|-----------|-----|
| U1 | Mesh | Unsafe `Record<string, unknown>` casts in TopologyGraph | `TopologyGraph.tsx:378-429` | Extend shared schema types for enriched topology data |
| U2 | Mesh | Missing `type="button"` on 2 buttons | `TopologyGraph.tsx:206, 626` | Add explicit type attributes |
| U3 | Mesh | Inline `<style>` tag re-created every render | `TopologyGraph.tsx:655-690` | Extract to `topology-graph.css` |

### Structural (1)

| # | Subsystem | Issue | File:Line | Fix |
|---|-----------|-------|-----------|-----|
| S1 | Relay | `relay-core.ts` is 1028 lines (2x limit) | `relay-core.ts` | Split into: core (pub/sub/config), adapter-delivery, relay-metrics |

### Also addressed (low-effort drive-bys)

| # | Subsystem | Issue | File:Line | Fix |
|---|-----------|-------|-----------|-----|
| D1 | Relay | `agentId` variable is actually `sessionId` | `adapter-manager.ts:330` | Rename variable |
| D2 | Relay | Duplicate adapter status fallback shape | `adapter-manager.ts:250-256, 280-284` | Extract `defaultAdapterStatus()` helper |
| D3 | Telegram | `startedAt` not cleared on stop | `telegram-adapter.ts:347-349` | Reset startedAt to undefined in stop() |
| D4 | Telegram | No input length validation on inbound messages | `telegram-adapter.ts:532-558` | Cap content at 32KB |
