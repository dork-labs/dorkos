---
slug: codex-runtime-adapter-prework
number: 244
created: 2026-04-15
status: ideation
---

# Codex Runtime & Adapter Pre-Work

**Slug:** codex-runtime-adapter-prework
**Author:** Claude Code
**Date:** 2026-04-15
**Branch:** preflight/codex-runtime-adapter-prework

---

## 1) Intent & Assumptions

- **Task brief:** Define the pre-work required to add a first-class Codex runtime and relay adapter to DorkOS. The goal is not to jump straight to implementation, but to identify the platform seams that still assume Claude Code and must be hardened first.
- **Assumptions:**
  - Codex will not support the exact same feature surface as Claude Code, especially around permission modes, approvals, transcript/session storage, commands, and plugin/runtime-specific controls.
  - `runtime: 'codex'` in agent manifests should eventually control actual execution routing, not just metadata and UI labeling.
  - The existing `AgentRuntime` abstraction is the right foundation, but the surrounding server, Relay, and client layers still need follow-up work to make multi-runtime support real.
  - Existing research in `research/` is sufficient for ideation; no new external research is required for this pass.
- **Out of scope:**
  - Implementing `CodexRuntime` in this ideation pass
  - Designing a universal ACP abstraction for all future runtimes
  - Full Codex plugin marketplace integration
  - Replacing Claude transcript storage for existing Claude sessions

## 2) Pre-reading Log

- `.claude/commands/ideate.md`: Defines the expected ideation workflow and required `01-ideation.md` document structure.
- `AGENTS.md`: Confirms repo standards, spec placement, architecture expectations, and the existing `AgentRuntime` positioning.
- `meta/dorkos-litepaper.md`: Product-level positioning already promises pluggable runtimes and explicitly names Codex as part of the runtime landscape.
- `plans/2026-03-06-claude-code-adapter-audit.md`: Historical audit of Claude-specific coupling. It correctly predicted that route routing, transcript storage, client assumptions, and relay internals would block true multi-runtime support.
- `specs/agent-runtime-abstraction/02-specification.md`: Introduced `AgentRuntime` and `RuntimeRegistry`, but the current implementation still leaves default-runtime assumptions in production paths.
- `specs/agent-runtime-review-remediation/02-specification.md`: Documents cleanup work after the abstraction refactor. Useful for understanding which seams were intentionally deferred.
- `specs/relay-runtime-adapters/01-ideation.md`: Shows the intended shape of runtime adapters in Relay and confirms Codex was explicitly deferred as future work.
- `research/20260306_agent_runtime_interface_design_patterns.md`: Confirms the runtime abstraction direction is sound and that narrow shared ports are preferred over concrete runtime dependencies.
- `research/20260405_ai_coding_agent_runtime_landscape.md`: Confirms Codex is a strong candidate runtime with a TypeScript SDK and structured streaming interface.
- `research/20260329_ai_coding_agent_plugin_marketplaces.md`: Important Codex-specific context for config, skills, AGENTS.md discovery, and plugin surfaces that differ from Claude.
- `research/20260315_agent_runtime_permission_modes.md`: Examines how to generalize the permission-mode concept across runtimes without forcing Claude's exact four-mode model. Directly motivates Decision 3 on expanding the capability shape beyond boolean flags.
- `research/20260224_agent_client_protocol_analysis.md`: Agent Client Protocol analysis. Grounds why Option 3 (broad cross-runtime protocol abstraction) is deferred — ACP-style generalization is possible future work, not a prerequisite for Codex.
- `research/20260225_relay_runtime_adapters.md`: Updated relay runtime adapter research that informs how `AdapterManager` and the internal relay port should be generalized ahead of a Codex adapter.
- `packages/shared/src/agent-runtime.ts`: Shared runtime contract and current `RuntimeCapabilities` definition.
- `packages/shared/src/mesh-schemas.ts`: Agent manifest schema already includes `codex` as a valid runtime.
- `apps/server/src/services/core/runtime-registry.ts`: Registry supports per-agent resolution in theory, but most production code still uses `getDefault()`.
- `apps/server/src/routes/sessions.ts`: Core session/message lifecycle is still resolved through the default runtime.
- `apps/server/src/routes/models.ts`: Model listing is still default-runtime scoped.
- `apps/server/src/routes/subagents.ts`: Subagent listing is still default-runtime scoped.
- `apps/server/src/routes/commands.ts`: Command discovery is still default-runtime scoped.
- `apps/server/src/routes/capabilities.ts`: Server dynamically aggregates `runtimeRegistry.getAllCapabilities()` and exposes it alongside `defaultRuntime`. The aggregation itself is multi-runtime; what remains coarse is the capability shape and how clients consume it.
- `apps/server/src/routes/system.ts`: Requirements endpoint already checks dependencies per runtime. This is a good pattern to preserve for Codex.
- `apps/server/src/services/relay/adapter-manager.ts`: Internal relay adapter lifecycle still depends on a Claude-shaped runtime interface.
- `apps/server/src/services/relay/binding-router.ts`: Binding flow still republishes specifically for ClaudeCodeAdapter handling.
- `packages/relay/src/adapters/claude-code/claude-code-adapter.ts`: Existing internal relay adapter pattern is solid operationally, but branded and typed around Claude.
- `packages/relay/src/adapters/claude-code/types.ts`: Narrow runtime interface for relay delivery is still Claude-specific in naming and assumptions.
- `apps/client/src/layers/entities/runtime/model/use-runtime-capabilities.ts`: Client collapses capability lookup to the default runtime rather than the active runtime.
- `apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx`: Status bar currently consumes default-runtime capabilities only, mainly for permission modes.
- `apps/client/src/layers/shared/lib/direct-transport.ts`: Embedded transport only exposes one runtime’s capabilities, which is insufficient for a mixed-runtime environment.
- `packages/shared/src/transport.ts`: Shared transport surface still contains Claude-biased wording and feature assumptions — e.g. `McpServerEntry.status` documented as "reported by the Claude Agent SDK", the `'claudeai'` config scope string, a `reloadPlugins` method tied to Claude's plugin model, and `getModels` docstring referring to "Claude models". These are the places where the shared port leaks Claude semantics into clients.
- `apps/server/src/services/runtimes/test-mode/`: Existing non-Claude `AgentRuntime` implementation. Proves the current contract is runtime-agnostic at the interface level and anchors the "harden platform, then add Codex" direction — the gaps are in the surrounding server, Relay, and client layers, not the contract itself.

## 3) Codebase Map

**Primary components/modules:**

- `packages/shared/src/agent-runtime.ts` - Universal backend contract for session lifecycle, messaging, approvals, transcript access, commands, and capabilities.
- `apps/server/src/services/core/runtime-registry.ts` - Runtime registry with a per-agent resolver, but production paths still mostly use the default runtime.
- `apps/server/src/routes/sessions.ts` - Main session API surface; currently the largest blocker because it owns session creation, message streaming, approvals, history, tasks, locking, and session updates.
- `apps/server/src/routes/models.ts` - Exposes runtime model lists, currently only from the default runtime.
- `apps/server/src/routes/subagents.ts` - Exposes runtime subagent lists, currently only from the default runtime.
- `apps/server/src/routes/commands.ts` - Exposes runtime command discovery, currently only from the default runtime.
- `apps/server/src/routes/capabilities.ts` - Capability advertisement endpoint, already multi-runtime in shape (dynamic aggregation over `runtimeRegistry.getAllCapabilities()`).
- `apps/server/src/routes/system.ts` - Dependency-check endpoint, already multi-runtime in behavior.
- `apps/server/src/services/relay/adapter-manager.ts` - Internal relay adapter composition root; currently depends on Claude-shaped runtime ports.
- `apps/server/src/services/relay/binding-router.ts` - Resolves external bindings and republishes agent-bound messages into the internal runtime adapter flow.
- `packages/relay/src/adapters/claude-code/claude-code-adapter.ts` - Current internal runtime adapter implementation for Relay delivery to Claude sessions.
- `packages/relay/src/adapters/claude-code/types.ts` - Narrow relay-facing runtime port that will need generalization.
- `apps/client/src/layers/entities/runtime/model/use-runtime-capabilities.ts` - Capability query hooks for the client.
- `apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx` - Status bar/control surface already partially capability-aware.
- `apps/client/src/layers/shared/lib/direct-transport.ts` - Embedded-mode transport implementation with a single-runtime capability view.
- `packages/shared/src/transport.ts` - Client/backend boundary whose method surface needs to tolerate runtimes with different features; several docstrings (Claude Agent SDK, "Claude models") and at least one method (`reloadPlugins`) still assume Claude Code.

**Shared dependencies:**

- `packages/shared/src/mesh-schemas.ts` - Runtime type is part of agent manifest data.
- `apps/server/src/index.ts` - Registers runtime implementations and currently wires relay internals to the default runtime.
- `apps/server/src/services/runtimes/claude-code/runtime-constants.ts` - Concrete capability declaration for Claude Code; useful as the baseline to compare future Codex capabilities.
- `apps/server/src/services/runtimes/test-mode/` - Existing second `AgentRuntime` implementation. Shows the contract itself does not require a Claude runtime, even though most surrounding production code currently assumes one.
- `research/20260405_ai_coding_agent_runtime_landscape.md` - Runtime integration constraints and candidate approaches.
- `research/20260329_ai_coding_agent_plugin_marketplaces.md` - Codex-specific extension model and config conventions.

**Data flow:**

Agent manifest/runtime selection -> `RuntimeRegistry` lookup -> session/message/command/model routes -> runtime implementation -> runtime-specific storage/session model -> streamed events -> client capability-gated UI

Relay path:

binding or internal publish -> `BindingRouter` / Relay core -> runtime adapter -> runtime implementation -> streamed response events -> reply subject / session UI

**Feature flags/config:**

- Agent manifests already carry `runtime`, including `codex`, via `AgentRuntimeSchema`.
- `runtimeRegistry.getDefaultType()` and `/api/capabilities` expose a server-wide default runtime concept.
- `/api/system/requirements` already models per-runtime dependency checks and should be reused for Codex install validation.

**Potential blast radius:**

- Direct: runtime registry resolution, session routes, model/subagent/command routes, relay adapter manager, binding router, capability schemas/hooks, embedded transport
- Indirect: status bar controls, approval UI, command palette behavior, model selectors, subagent UI, runtime config surfaces, server bootstrap wiring
- Tests: runtime registry tests, route tests, client runtime hook tests, relay adapter tests, any session flow tests that assume one runtime

## 4) Research

**Potential solutions:**

1. Keep the current abstraction and add Codex directly on top
   - Pros:
     - Lowest short-term effort
     - Fastest way to get a prototype runtime class compiling
   - Cons:
     - Session routing would still be wrong for mixed-runtime fleets
     - Capability gating would remain default-runtime scoped
     - Relay would gain a second special-case runtime path instead of a generalized one
     - High risk of shipping "fake" multi-runtime support

2. Platform hardening first, then Codex implementation
   - Pros:
     - Makes runtime ownership, capability gating, and relay delivery correct before the second runtime lands
     - Keeps Codex implementation bounded to actual runtime concerns
     - Aligns implementation with existing product positioning and manifest schema
   - Cons:
     - More upfront platform work before visible Codex support
     - Requires touching server, Relay, and client seams in sequence

3. Jump to a broader cross-runtime protocol abstraction now
   - Pros:
     - Could reduce future work for OpenCode/Cline/ACP-style runtimes
     - Offers the cleanest long-term architecture if done well
   - Cons:
     - Too much scope for the immediate Codex goal
     - Risks delaying a concrete second runtime behind framework work
     - Not required to support Codex specifically

**Recommendation:** Choose option 2. The existing `AgentRuntime` contract is good enough to build on, but DorkOS still needs platform hardening in three places before Codex is added: runtime ownership/routing, capability shape/consumption, and relay internal adapter generalization. Codex should be the first runtime implemented on top of that hardened platform, not the forcing function that leaves half the platform assumptions in place.

## 5) Decisions

| #   | Decision                                                                            | Choice                                                                                                                                          | Rationale                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should this ideation target direct Codex implementation or platform pre-work first? | Platform pre-work first                                                                                                                         | Current execution still routes mostly through `runtimeRegistry.getDefault()`, so adding Codex immediately would produce partial or misleading multi-runtime behavior.                                                   |
| 2   | How should the work be sliced?                                                      | Four sequential specs: routing/session ownership, capability matrix/UI gating, relay runtime adapter generalization, then Codex runtime/adapter | This separates platform concerns from the concrete Codex implementation and keeps dependencies explicit.                                                                                                                |
| 3   | Is there already a runtime feature support mechanism worth keeping?                 | Yes, but expand it                                                                                                                              | `RuntimeCapabilities`, `/api/capabilities`, and `/api/system/requirements` are the right base, but the capability model is too coarse and the client currently reads the default runtime instead of the active runtime. |
| 4   | Should session ownership stay implicit via defaults/manifests?                      | No; persist runtime ownership per session                                                                                                       | Agent manifests and server defaults can change over time. Session routing needs a stable runtime owner once a session exists.                                                                                           |
| 5   | Should Relay keep Claude-specific internal adapter seams?                           | No; generalize before Codex                                                                                                                     | `AdapterManager`, `BindingRouter`, and the relay runtime port still assume Claude-specific semantics and naming. A second runtime should not duplicate that pattern.                                                    |
| 6   | Should Codex be forced into Claude transcript/storage semantics?                    | No                                                                                                                                              | Claude JSONL storage is an implementation detail of the Claude runtime, not a platform contract. Codex should use runtime-appropriate session/storage handling.                                                         |
| 7   | Are there unresolved ambiguities that block writing the ideation?                   | No ambiguities identified                                                                                                                       | The task brief and codebase findings were sufficiently clear to define the pre-work and spec boundaries without additional clarification.                                                                               |
