---
slug: additional-agent-runtimes
number: 270
created: 2026-07-02
status: specified
---

# Additional Agent Runtimes: OpenCode + Codex

**Status:** Draft
**Author:** Dorian (brief) / Claude (specification)
**Date:** 2026-07-02
**Tracker:** DOR-180 - Add two additional agent runtimes beyond Claude Code (adapters + runtime visibility/selection UX)

## Overview

Add two production agent runtimes alongside Claude Code — **OpenCode** (open-source/local models) and **Codex** (OpenAI ecosystem) — as `AgentRuntime` implementations, and finish the multi-runtime experience: sessions and agents show their runtime, users choose a runtime at session launch and per agent, and every capability-dependent surface adapts to the active runtime. Ship the DX rails (conformance suite, SDK confinement, adding-a-runtime guide) that make runtime #4 a checklist.

## Background / Problem Statement

DorkOS's thesis is coordination across autonomous agents, but production DorkOS can only run Claude Code — every "runtime-agnostic" seam (ADR-0086 registry, ADR-0255 per-session binding, `RuntimeCapabilities`, capability-gated UI) is exercised by a single real implementation plus `TestModeRuntime`. The Kai persona runs multiple agent CLIs today; for him DorkOS is a Claude wrapper until his OpenCode and Codex sessions live in the same cockpit. The brief (DOR-180) requires two new runtimes, at least one supporting open-source models, plus the ability to show and set/change an agent's runtime.

Verified groundwork already shipped (July 2026 audit):

- `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`, 553 lines) — no Claude leakage; structured `permissionModes`; `features` extension map (ADR-0256).
- `runtimeRegistry` (`apps/server/src/services/core/runtime-registry.ts`) — `resolveForSession` (session_metadata, first-write-wins), `resolveForAgent` (manifest), `RuntimeNotRegisteredError` handled in routes.
- `resolveRuntimeTypeForNewSession` (`apps/server/src/routes/sessions.ts:291-326`) — explicit `body.runtime` hint > agent manifest (`<cwd>/.dork/agent.json`, soft-fallback when unregistered) > default.
- Agent Hub ConfigTab (`apps/client/.../agent-hub/ui/tabs/ConfigTab.tsx:204-218`) — **runtime selector already exists**, writes via `PATCH /api/agents/:path` (file-first per ADR-0043).
- Capabilities plumbing: `getCapabilities()` transport (`packages/shared/src/transport.ts:418-421`) returns `{ capabilities: Record<runtime, RuntimeCapabilities>, defaultRuntime }`; `useRuntimeCapabilities`/`useActiveCapabilities` hooks; session-scoped `useModels(sessionId)`.
- Onboarding `SystemRequirementsStep` already renders per-runtime `checkDependencies` results with install hints.

What does not exist: the two adapters; multi-runtime session listing (`routes/sessions.ts:64` lists `getDefault()` only) and list subscription; a runtime chip/selector on session surfaces; `runtimes.*` user config; runtime identity (icons/labels) as a design-system element; the conformance suite.

## Goals

- OpenCode and Codex sessions work end-to-end in DorkOS: create → send → streamed response → interrupt → history on revisit → visible in the session list.
- OpenCode runs against open-source models (Ollama / any OpenAI-compatible endpoint) — satisfying the brief's constraint.
- Runtime is visible on: session list rows, chat status bar, agent rows/cards (exists), agent detail (exists), new-session flow.
- Runtime is settable: at session launch (UI + `?runtime=` param + API hint), per agent (exists — verify + polish), and as a config default (`runtimes.default`).
- Capability-gated UI verified against three real capability profiles (cost tracking, permission modes, plugins, question prompts, MCP).
- Missing-dependency UX: a runtime that isn't installed/authed guides the user to install/login instead of failing opaquely.
- DX: conformance suite green for all runtimes; ESLint confinement for both new SDKs; `contributing/adding-a-runtime.md`.

## Non-Goals

- Generic ACP adapter (deferred — ADR-0307).
- Pi / embedded roll-our-own runtime (deferred, runtime #4 candidate — ADR-0307).
- Cross-runtime session migration/transplant; unified transcript store (rejected — ADR-0310).
- Claude-parity features on new runtimes (plugins, marketplace command warm-up, hooks) — capability flags gate them off honestly.
- Changing the shipped default runtime (`claude-code` remains default).
- Bundling runtime binaries; Windows-specific packaging work.

## Technical Dependencies

- `@opencode-ai/sdk` `^1.17.13` (MIT) — REST + SSE client for `opencode serve`; OpenAPI 3.1 at `/doc`. Requires user-installed `opencode` binary. Docs: opencode.ai/docs/server.
- `@openai/codex-sdk` `~0.142.5` **pinned** (Apache-2.0) — thread API (`startThread`/`resumeThread`/`runStreamed`), Node ≥ 18; spawns user-installed `codex` CLI; auth via `codex login` (ChatGPT OAuth) or `CODEX_API_KEY`. Post-0.132.0: pass sandbox/approval params explicitly. Docs: developers.openai.com/codex.
- Existing: `conf` (config), Drizzle (`session_metadata`), EventLog + `SessionStateProjector`, spec-255 SSE delivery, ADR-0273 `additionalContext` channel.
- Icon marks for OpenCode + Codex in `@dorkos/icons` (registry pattern already in place).

## Detailed Design

### Architecture changes

Two new adapter directories under `apps/server/src/services/runtimes/`, each owning its SDK behind an ESLint boundary (mirroring rule #2 for the Claude SDK):

```
services/runtimes/
├── claude-code/          # existing (~9.7k LOC)
├── test-mode/            # existing (699 LOC)
├── opencode/             # NEW — sidecar + SDK/SSE adapter
│   ├── opencode-runtime.ts        # AgentRuntime facade
│   ├── server-manager.ts          # opencode serve lifecycle (spawn/health/backoff/shutdown)
│   ├── event-mapper.ts            # OpenCode SSE events → StreamEvent
│   ├── session-mapper.ts          # DorkOS session ↔ OpenCode session (+cwd handling)
│   └── __tests__/
└── codex/                # NEW — SDK-thread adapter
    ├── codex-runtime.ts           # AgentRuntime facade
    ├── thread-map.ts              # sessionId ↔ threadId persistence
    ├── event-mapper.ts            # runStreamed events → StreamEvent
    └── __tests__/
```

**OpenCode adapter (ADR-0308):** one managed `opencode serve` sidecar per DorkOS server — lazily spawned on first OpenCode use, health-checked, port/binary from `runtimes.opencode` config, exponential-backoff restart, killed on server shutdown. All I/O via `@opencode-ai/sdk`; OpenCode's SQLite store is opaque. Streaming: subscribe to the server's SSE event stream, filter per session, map to `StreamEvent`. Permissions: OpenCode permission requests surface through the `supportsToolApproval` flow (`approveTool`). Live turn state flows through EventLog + `SessionStateProjector` (test-mode pattern); `listSessions`/`getMessageHistory` read via SDK.

**Codex adapter (ADR-0309):** one DorkOS session ↔ one Codex thread. `ensureSession` → `startThread`/`resumeThread(threadId)`; the sessionId↔threadId map is adapter-owned durable state (SQLite table `codex_threads` in `packages/db`, or `features`-scoped metadata — decided at implementation by whichever keeps `session_metadata` untouched). `sendMessage` drives `runStreamed()`; explicit approval/sandbox params; interrupt via the SDK's abort surface. History from thread state under `~/.codex/sessions` **via the SDK**, not by scanning files.

**Registry aggregation (ADR-0310):** `GET /api/sessions` and `subscribeSessionList` move from `getDefault()` to aggregation across `runtimeRegistry.getAll()`: merge + sort by `updatedAt`, tag each session `runtime: <type>`, degrade gracefully per runtime (partial results + `warnings[]` in the response envelope rather than a failed request). The `Session` shared type gains a required `runtime` field (claude-code fills it today from its own type).

### Implementation approach

Foundations land first behind no flag (aggregation of one runtime is a no-op refactor), then Codex (no sidecar lifecycle → lower risk), then OpenCode (sidecar + local-model path), then polish. Each adapter must pass the conformance suite before its UI entry points activate: a runtime appears in pickers only when registered **and** `checkDependencies` passes (else it appears with an "install/setup" affordance, never a dead option).

### Code structure & file organization

Server: as above, plus `routes/sessions.ts` listing aggregation and `routes/models.ts` unchanged (session-scoped resolution already works). Client (FSD):

- `layers/entities/runtime/` — extend with `RuntimeDescriptor` registry: `{ type, label, icon, accent }` for `claude-code | opencode | codex | test-mode` (single source for every badge/picker; unknown types render a neutral fallback).
- `layers/features/status/ui/RuntimeItem.tsx` — status-bar runtime chip (pattern: `PermissionModeItem.tsx`), rendered in `ChatStatusSection.tsx` beside the model picker. Read-only once a session has started (ADR-0255 immutability), selectable in the pre-first-message state.
- New-session flow: `?runtime=` search param on `/session` (router.tsx:105-143 loader), threaded into the first `POST /:id/messages` body as the existing `runtime` hint; `SessionLaunchPopover` passes the agent's runtime.
- Session list rows: small runtime icon (from `RuntimeDescriptor`) next to the title; tooltip with label.
- `SystemRequirementsStep` + a settings-surface reuse of the same component for post-onboarding runtime setup ("Add a runtime" entry point in the runtime picker when a known runtime is unregistered/missing deps).

### API changes

- `GET /api/sessions` — response items gain `runtime`; envelope gains optional `warnings[]`. Optional `?runtime=` filter.
- `GET /api/sessions/:id` / snapshots — include `runtime` (from `session_metadata` / registry resolution).
- `POST /api/sessions/:id/messages` — no change (already accepts `runtime` hint; unknown runtime already 400s).
- `PATCH /api/agents/:path` — no change (runtime updates already supported).
- `GET /api/system/requirements` — no change (already aggregates all registered runtimes).
- External MCP server (`/mcp`): session-creation tool docs mention the `runtime` hint; no new tools.

### Data model changes

- `packages/shared/src/mesh-schemas.ts` — add `'opencode'` to `AgentRuntimeSchema` (enum currently lacks it; `codex` present). Note the enum's dual use (discovery `detectedRuntime` vs execution runtime) in TSDoc; do not fork the enum in this spec.
- `packages/shared/src/schemas.ts` — `Session` gains `runtime: string`. `PermissionModeSchema`: new runtimes declare their modes via `RuntimeCapabilities.permissionModes` (test-mode pattern); extend the shared enum only if a mode must persist in `session_metadata` settings (expected: OpenCode maps to `default`/`acceptEdits`-like modes; Codex maps its approval levels; implementation validates against real SDKs).
- `packages/db` — `codex_threads (sessionId PK, threadId, createdAt)` if the thread map lands in SQLite.
- Config (`packages/shared/src/config-schema.ts` + semver migration per `contributing/configuration.md` and the `adding-config-fields` skill):

```jsonc
"runtimes": {
  "default": "claude-code",            // registry default at boot
  "opencode": {
    "enabled": true,
    "binaryPath": null,                 // null → resolve from PATH
    "port": 0,                          // 0 → ephemeral port
  },
  "codex": {
    "enabled": true,
    "binaryPath": null,
  },
}
```

### Integration with external libraries

Both SDK integrations live entirely inside their adapter directory; `eslint-config` gains two `no-restricted-imports` entries (`@opencode-ai/sdk` → `services/runtimes/opencode/`, `@openai/codex-sdk` → `services/runtimes/codex/`). Event-mapper tests use recorded fixture events (see Testing Strategy) so CI never needs the binaries.

## User Experience

**Start a session on a runtime.** New-chat surface shows a runtime selector (icon + label, default pre-selected from agent → config → server default) only when >1 runtime is registered — with one runtime, DorkOS looks exactly as it does today (less, but better). Launching from an agent pre-selects the agent's runtime automatically (server-side manifest fallback already does this; the UI now shows it instead of hiding it).

**See the runtime.** Session list rows carry the runtime mark; the chat status bar shows the runtime chip; agent rows/cards/detail keep their badges. One visual identity per runtime from the `RuntimeDescriptor` registry — same icon, label, accent everywhere.

**Change an agent's runtime.** Agent Hub → Config tab (exists). On save, UI states plainly: "Applies to new sessions. Existing sessions keep their runtime." (Honest by design; ADR-0255.)

**Runtime not ready.** A registered-but-unsatisfied runtime (binary missing, not logged in) appears in pickers in a "needs setup" state; selecting it opens the requirements panel (reused `SystemRequirementsStep` machinery) with copyable install/auth commands (`npm i -g opencode-ai && opencode auth login`, `npm i -g @openai/codex && codex login`). Never a dead dropdown, never a raw stack trace. If a runtime breaks mid-session (sidecar crash, CLI exit), the turn fails with a typed error event and the session shows a retry affordance; the sidecar restarts with backoff.

**Capability honesty.** Cost strip renders only when `supportsCostTracking`; permission-mode picker renders the runtime's declared modes; plugin/command surfaces gate on their flags. Error and empty states name the runtime ("OpenCode server is starting…", "Codex requires login").

**Exit paths.** Interrupt works on all runtimes (`interruptQuery`); stopping the DorkOS server tears down the OpenCode sidecar; sessions remain readable in native CLIs.

## Testing Strategy

- **Unit tests:** event mappers (fixture SDK/SSE events → `StreamEvent`, including error/interrupt/tool-approval shapes); `server-manager` lifecycle (spawn/health/backoff/shutdown with a fake child process); thread-map persistence; `resolveRuntimeTypeForNewSession` matrix (hint/manifest/default × registered/unregistered); config migration.
- **Conformance suite (the DX centerpiece):** `packages/test-utils` gains `runtimeConformance(makeRuntime)` — one shared Vitest suite asserting the `AgentRuntime` contract: session lifecycle, `sendMessage` yields well-formed `StreamEvent`s ending in a terminal event, interrupt semantics, history round-trip, capability-shape validity, dependency-check shape. Runs against `TestModeRuntime` and both new adapters (mocked backends) in CI; optionally against live binaries locally via env flag.
- **Integration tests:** aggregated `GET /api/sessions` with two registered runtimes (merge, tagging, one-runtime-failing degradation); SSE turn delivery through the projector for each adapter with mocked SDK; runtime-hint 400 on unknown type (exists — extend).
- **E2E (apps/e2e):** with `DORKOS_TEST_RUNTIME` + a second fake runtime registered, verify picker rendering, session launch with runtime param, status-bar chip, session-list badges.
- **Mocking strategy:** never require `opencode`/`codex` binaries in CI. OpenCode: fake SSE server emitting recorded fixtures. Codex: mock `@openai/codex-sdk` module (`vi.mock`) with scripted thread events, following `sdk-scenarios.ts` conventions from the Claude adapter.

## Performance Considerations

- Session-list aggregation fans out per runtime: parallelize with `Promise.allSettled`, per-runtime timeout (e.g. 2s) so one slow backend cannot stall the list; cold OpenCode sidecar must not block listing (report empty + warning until healthy).
- Sidecar startup (~1-3s) is lazy and amortized; first-message latency on OpenCode shows the existing "starting" status rather than blocking silently.
- SSE fan-in adds one subscription per runtime, not per session (OpenCode multiplexes sessions on one event stream).

## Security Considerations

- The OpenCode sidecar binds `127.0.0.1` only, with `OPENCODE_SERVER_PASSWORD` basic auth from a generated per-boot secret; never exposed through the DorkOS tunnel.
- No credential handling: Codex auth delegates to `codex login` on the host (consistent with the connect-account research stance — never proxy a third-party OAuth); OpenCode provider credentials stay in its own `auth.json`. DorkOS stores no runtime API keys in `~/.dork/config.json`.
- Both adapters execute agent tool-use with the user's local privileges — permission-mode mapping must default conservatively (approval-required modes), matching each backend's own default posture.
- Child-process args built from validated config (Zod), no shell interpolation.

## Documentation

- `contributing/adding-a-runtime.md` — the runtime-author guide (interface walk-through, conformance suite, ESLint boundary, UI descriptor registration).
- `docs/` (Fumadocs): "Runtimes" user guide — installing/connecting OpenCode and Codex, choosing a runtime, local models via OpenCode+Ollama.
- Update `AGENTS.md` (runtimes list), `contributing/architecture.md` (adapter diagram), config docs for `runtimes.*`.
- ADRs 0307-0310 accompany this spec (drafted).

## Implementation Phases

- **Phase 1 — Multi-runtime foundations:** `Session.runtime` + list aggregation + graceful degradation; `runtimes.*` config + migration; `'opencode'` enum value; `RuntimeDescriptor` client registry + icons; status-bar runtime chip (read-only + pre-launch selectable); `?runtime=` launch param; conformance suite running against test-mode + claude-code.
- **Phase 2 — Codex adapter:** thread mapping, event mapper, interrupt, history, dependency checks + auth guidance; conformance green; models list; e2e smoke against real CLI locally.
- **Phase 3 — OpenCode adapter:** server-manager sidecar, SSE fan-in, permission forwarding, session/history via SDK; local-model path verified against Ollama (e.g. qwen2.5-coder-32b-class model); conformance green.
- **Phase 4 — Polish + docs:** requirements-panel reuse as "add a runtime" flow, empty/error-state copy pass, Playwright e2e, guides + ADR acceptance, `research/` refresh of the two stale April reports.

## Open Questions

- ~~Which two runtimes?~~ (RESOLVED) **OpenCode + Codex.** Rationale: open-source constraint + largest ecosystems; user-confirmed 2026-07-02. Pi deferred (ADR-0307).
- ~~Selector scope?~~ (RESOLVED) **Agent + session.** Runtime is per-session in the data model; agents bind defaults; ad-hoc sessions need the picker. User-confirmed 2026-07-02.
- ~~Unified transcript store?~~ (RESOLVED) **No** — runtime-owned storage with aggregated listing (ADR-0310).
- **OpenCode sidecar × working directories** (carried to EXECUTE, verification not decision): confirm the SDK creates sessions with per-session `cwd` on one server instance; if a server instance is directory-bound, fall back to a small per-cwd instance pool inside `server-manager.ts`. Does not change the adapter's public shape.
- **Permission-mode persistence** (carried to EXECUTE): whether OpenCode/Codex modes fit the existing `PermissionModeSchema` values or the enum needs additive members — decided against real SDK behavior during Phase 2/3, additive-only either way.

## Related ADRs

- ADR-0307 — Second and third runtimes: OpenCode and Codex (draft, this spec)
- ADR-0308 — OpenCode adapter: managed `opencode serve` sidecar (draft, this spec)
- ADR-0309 — Codex adapter: SDK threads mapped to sessions (draft, this spec)
- ADR-0310 — Runtime-owned session storage with registry-aggregated listing (draft, this spec)
- ADR-0086 — Multi-runtime registry keyed by type · ADR-0255 — Per-session runtime persistence · ADR-0256 — Capabilities `features` map · ADR-0260 — SessionSettingsPort · ADR-0273 — Runtime-neutral additional-context channel · ADR-0043 — Agent storage file-first

## References

- Tracker: DOR-180 (this), DOR-114 (emulated compaction — unblocked by this spec's capability groundwork), DOR-100 (runtime-agnostic usage/cost), DOR-110 (operation_progress standardization)
- `specs/additional-agent-runtimes/01-ideation.md` — decisions + July 2026 landscape verification (OpenCode→Anomaly org + SQLite sessions; Codex SDK 0.142.5; Pi→Earendil; Gemini CLI discontinued; Cline GA)
- `research/20260405_ai_coding_agent_runtime_landscape.md`, `research/20260405_pi_coding_agent_and_local_model_frameworks.md` (April baseline; refresh scheduled Phase 4)
- OpenCode: opencode.ai/docs/server · github.com/anomalyco/opencode · npm `@opencode-ai/sdk`
- Codex: developers.openai.com/codex · github.com/openai/codex (sdk/typescript) · npm `@openai/codex-sdk`
