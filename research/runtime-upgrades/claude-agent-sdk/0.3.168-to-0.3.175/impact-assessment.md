# Impact Assessment: @anthropic-ai/claude-agent-sdk 0.3.168 → 0.3.175

**Generated**: 2026-06-12
**Codebase root**: `apps/server/src/services/runtimes/claude-code/`
**Abstraction boundary**: `AgentRuntime` interface (ADR-0089)
**Related ADRs**: 0089 (SDK import confinement), 0143 (retry over circuit breaker), 0239 (plugin activation), 0240 (permission passthrough)

## Summary

| Category             | Count | Action Required                     |
| -------------------- | ----- | ----------------------------------- |
| Breaking changes     | 0     | —                                   |
| Deprecations         | 0     | —                                   |
| Features (high)      | 1     | Adopt — Fable 5 model support       |
| Features (medium)    | 1     | Defer — model_fallback UI surfacing |
| Features (low/none)  | 3     | No action                           |
| Bug fixes (relevant) | 1     | Auto-resolved by bump               |

**Overall upgrade risk**: Low
**Estimated total effort**: < 1 hour (version bump + two trivial code changes + validation)

## Goal: Fable 5 support — how the model list actually flows

DorkOS does **not** hardcode the model catalog on the primary path. `RuntimeCache.warmup()` / `buildSendCallbacks()` (`messaging/runtime-cache.ts`) call the SDK's `agentQuery.supportedModels()` and cache the result (memory → disk at `~/.dork/cache/runtimes/claude-code/models.json`, 24h TTL). `GET /api/models` → `runtime.getSupportedModels()` reads that cache. Per-model capabilities (`supportsEffort`, `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`) also come from the SDK, so effort/thinking/auto-mode gating adapts to Fable automatically.

**Therefore the version bump itself delivers Fable 5** to the web client, desktop, and CLI cockpit. Two small gaps remain:

### Gap 1 — `inferTier()` doesn't know `fable`

- **File**: `apps/server/src/services/runtimes/claude-code/messaging/runtime-cache.ts:57`
- **Issue**: tier inference maps opus→flagship, sonnet→balanced, haiku→fast; `claude-fable-5` falls through to `undefined`
- **Blast radius**: cosmetic — `ModelOption.tier` currently has no client consumer (schema-only, "for UI grouping"), but the metadata should be correct
- **Fix**: map `fable` → `'flagship'` (effort: trivial)

### Gap 2 — Obsidian DirectTransport hardcoded fallback list

- **File**: `apps/client/src/layers/shared/lib/direct/system-methods.ts:172-193`
- **Issue**: embedded mode returns a static three-model list (Sonnet 4.5, Haiku 4.5, Opus 4.6) — no Fable 5; list predates Opus 4.7/4.8
- **Fix**: add `claude-fable-5` entry (add-alongside per migration guidance — existing entries still serve). Effort: trivial. A full refresh of this stale list is follow-up scope; this change only adds Fable.

## Feature Relevance — non-Fable items

### model_fallback expansion (0.3.174) — Relevance: Medium, defer

- `system-event-mapper.ts` handles unknown system subtypes by logging and yielding nothing, so the newly-broadcast `model_fallback` messages (`overloaded`, `server_error`, `last_resort` triggers) are safely ignored — no action required for the bump
- **Opportunity**: map `model_fallback` to a `system_status` StreamEvent so the chat UI shows "fell back to model X" notices. Needs UI consideration → separate piece of work, not bundled here

### skipMcpDiscovery (0.3.172) — Relevance: None

- DorkOS deliberately lets the SDK own plugin MCP loading (`plugin-activation.ts`, ADR-0239: "DorkOS owns the install half, the SDK owns the runtime half"). No host-managed MCP connections exist to skip

### Experimental usage() + browser SSE (0.3.169) — Relevance: None

- `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` — name says it; revisit when stable (potential fit for cost tracking)
- `BrowserQueryOptions.sse` — DorkOS runs the SDK server-side only

## Bug Fixes Resolving Known Issues

- 0.3.172 slash-whitespace fix: adjacent to (but does **not** resolve) the known "slash commands broken via DorkOS chat" issue, which is caused by DorkOS's per-message context prepend, not SDK parsing

## ADR Conflicts

None. All changes stay inside the `services/runtimes/claude-code/` boundary (ADR-0089) or touch the client's own DirectTransport stub. No permission-mode (ADR-0240) or plugin-activation (ADR-0239) surface changes.

## Dependency Check

- Peer deps unchanged: `zod ^4.0.0`, `@anthropic-ai/sdk >=0.93.0` (root override pins 0.102.0 ✓), `@modelcontextprotocol/sdk ^1.29.0` (root override pins 1.29.0 ✓)
- Native binary optional deps: same 8-platform layout, version-locked to the SDK version
- Version is pinned in 3 places: root `package.json` (`pnpm.overrides`), `apps/server/package.json`, `packages/cli/package.json`

## No Action Required

- 2 parity-only releases (0.3.173, 0.3.175)
- 3 low/no-relevance features (see changelog)
