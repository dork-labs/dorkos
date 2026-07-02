---
slug: additional-agent-runtimes
number: 268
created: 2026-07-02
status: ideation
---

# Additional Agent Runtimes: OpenCode + Codex

**Slug:** additional-agent-runtimes
**Author:** Dorian (brief) / Claude (ideation)
**Date:** 2026-07-02
**Tracker:** DOR-180 - Add two additional agent runtimes beyond Claude Code (adapters + runtime visibility/selection UX)

---

## 1) Intent & Assumptions

- **Task brief:** DorkOS currently has a single agent runtime/adapter: Claude Code. Add **two** additional runtimes/adapters, of which **at least one must support open-source models** (candidates named in the brief: OpenCode, Pi, or rolling our own agent). Alongside the runtimes, add the ability to **show** which runtime an agent is using and to **set/change** the runtime an agent is using. UI/UX and DX must both be 10/10 — this is the feature that makes "DorkOS is the operating system for autonomous AI agents" literally true rather than "a Claude Code wrapper."
- **Assumptions:**
  - The `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`) is the integration seam; it was designed for this (ADR-0086) and `TestModeRuntime` already proves a second implementation end-to-end.
  - "Usable end-to-end" means: create session → send message → streamed response in the chat UI → history/transcript on revisit → interrupt/stop — for each new runtime.
  - Runtime binaries/SDK backends are user-installed (`opencode`, `codex` auth); DorkOS detects and guides, it does not bundle them.
  - Per-session runtime binding stays immutable first-write-wins (ADR-0255); "changing an agent's runtime" affects **new** sessions only.
  - The open-source-model constraint is satisfied by OpenCode (75+ providers incl. Ollama/LM Studio/any OpenAI-compatible endpoint).
- **Out of scope:**
  - A generic ACP adapter that speaks to any ACP agent (OpenCode/Cline/Goose). Deliberately deferred: valuable, but a third integration style to design and test; revisit once two concrete adapters expose what the abstraction must cover.
  - Pi / rolling our own embedded agent engine (deferred, not rejected — see Decision #1 rationale and §5 alternatives).
  - Changing the default runtime away from `claude-code`.
  - Runtime _migration_ of an existing session's history (cross-runtime session transplant).
  - Feature parity for Claude-specific extras on the new runtimes (plugins, marketplace command warm-up, hooks); capability flags already gate these per runtime.
  - Closed/cloud-only agents (Devin, Kiro, Copilot CLI, Amp, Droid) — misaligned with local-first ethos.

## 2) Pre-reading Log

- `research/20260405_ai_coding_agent_runtime_landscape.md`: 10-agent survey. Tier 1 = OpenCode, Cline, Codex SDK (official TS SDKs + streaming). ACP emerging as the subprocess standard.
- `research/20260405_pi_coding_agent_and_local_model_frameworks.md`: pi-agent-core is the strongest embedded/"roll our own" path; local-model bottleneck is model capability (tool-calling reliability under ~14B), not framework support.
- **July 2026 verification (this ideation, web + npm):** material staleness found — see §5. Key: OpenCode org is now `anomalyco/opencode` (MIT unchanged, SDK `@opencode-ai/sdk@1.17.13`, sessions migrated to SQLite); Codex SDK at `0.142.5` (API shape unchanged, threads persist under `~/.codex/sessions`); **Pi acquired by Earendil** (`@earendil-works/pi-agent-core@0.80.3`, MIT core guaranteed by RFC-0015, refactor settled); **Gemini CLI killed June 18, 2026** (closed-source Antigravity CLI successor); Cline CLI reached GA.
- `packages/shared/src/agent-runtime.ts` (553 lines): the universal contract — session lifecycle, `sendMessage(): AsyncGenerator<StreamEvent>`, interactive flows (approvals/questions/elicitations), storage queries (list/get/history/snapshot/subscribe), locking, `RuntimeCapabilities` (structured `permissionModes`, boolean feature flags, `features` extension map per ADR-0256).
- `apps/server/src/services/core/runtime-registry.ts` (339 lines): `Map<string, AgentRuntime>` keyed by type; `resolveForSession()` via `session_metadata.runtime` (ADR-0255), `resolveForAgent()` via manifest `runtime` field, legacy sessions infer `claude-code`; `RuntimeNotRegisteredError` handled in routes.
- `apps/server/src/services/runtimes/claude-code/` (~9,746 LOC non-test): facade + sessions (JSONL transcript reader/parser/watcher, locks) + messaging (SDK query, event mapper, cache) + tooling (command registry) + `sdk/`. The JSONL layer is Claude-specific; locks/store patterns are reusable.
- `apps/server/src/services/runtimes/test-mode/` (699 LOC): stateless second runtime using the shared EventLog + `SessionStateProjector` — proof the interface is storage-format-agnostic, and the template for runtimes whose native storage we don't scan.
- `packages/shared/src/mesh-schemas.ts:18-36,124-162`: `AgentRuntimeSchema` enum (has `codex` but **not** `opencode`), `AgentManifestSchema.runtime` is already a first-class field; discovery strategies set `detectedRuntime`.
- `packages/db/src/schema/sessions.ts:14-26`: `session_metadata (sessionId, runtime, agentPath, createdAt)` immutable + mutable settings (ADR-0260).
- `apps/client/src/layers/features/agents-list/ui/AgentRow.tsx:36-38`, `features/mesh/ui/AgentCard.tsx:37`: runtime **badges already render** `agent.runtime`.
- ADRs: 0086 (multi-runtime registry), 0255 (per-session runtime persistence), 0256 (capabilities `features` map), 0260 (SessionSettingsPort), 0273 (runtime-neutral additional-context channel — built explicitly so non-Claude runtimes get context injection right).
- Related tracker groundwork: DOR-114 (emulated compaction for runtimes without native compact), DOR-100 (runtime-agnostic usage/cost), DOR-110 (standardize `operation_progress`).

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/shared/src/agent-runtime.ts` — contract (no changes expected beyond doc comments; the seam holds).
  - `apps/server/src/services/core/runtime-registry.ts` — registration/resolution (additive registration at `apps/server/src/index.ts:194-218`).
  - `apps/server/src/services/runtimes/opencode/` (new) and `apps/server/src/services/runtimes/codex/` (new) — the two adapters.
  - `apps/server/src/services/session/session-state-projector.ts` + EventLog — snapshot/subscribe path for non-JSONL runtimes (test-mode pattern).
  - `packages/shared/src/mesh-schemas.ts` — `AgentRuntimeSchema` gains `opencode`; agent manifest `runtime` already exists.
  - `apps/client` — new-session flow, agent detail panel, session header, models list, dependency/onboarding surfaces.
- **Shared dependencies:** `session_metadata` table (`packages/db`), `SessionSettingsPort` (ADR-0260), `AdditionalContext` channel (ADR-0273), `RuntimeCapabilities` consumers (permission-mode picker, cost strip), `FakeAgentRuntime` (`packages/test-utils`).
- **Data flow:** route → `runtimeRegistry.resolveForSession(sessionId)` (or `resolveForAgent` → default) → `AgentRuntime.sendMessage()` → `StreamEvent` async generator → per-session SSE stream (spec-255 snapshot/replay/live) → client store. History: `getMessageHistory()` from the runtime's native storage (JSONL for Claude; OpenCode SQLite via SDK; Codex thread files).
- **Feature flags/config:** none today; registry default is hardcoded `'claude-code'` (`runtime-registry.ts:64`). New: `runtimes.default` user-config field (Zod `UserConfigSchema` + semver migration per `contributing/configuration.md`), per-runtime enable/config blocks (e.g. OpenCode server port/binary path).
- **Potential blast radius:**
  - Server: composition root, routes already runtime-dispatched (low risk), dependency checks (`/api/system/requirements` aggregation), models route (per-runtime).
  - Client: everywhere capabilities are assumed Claude-shaped — permission-mode picker, cost display, command palette (`commands_changed`), compaction strip. All already gated by `RuntimeCapabilities`, but each gate needs verification against two real runtimes.
  - Sessions list: merged multi-runtime listing (today `listSessions()` is Claude's JSONL scan; the list layer must aggregate across registered runtimes).
  - Mesh/discovery: `detectedRuntime` semantics ("which harness created this agent dir") vs execution runtime ("which backend DorkOS uses to run this agent") must not be conflated — same enum, two meanings today.

## 4) Root Cause Analysis

Not a bug fix — omitted.

## 5) Research

- **Potential solutions (runtime pair):**
  1. **OpenCode + Codex (chosen).** OpenCode: MIT, `@opencode-ai/sdk@1.17.13`, headless `opencode serve` (REST + SSE, OpenAPI 3.1 at `/doc`), ACP, 75+ providers incl. Ollama — satisfies the open-source-model constraint and is the strongest community bet (~178K stars). Codex: Apache-2.0, `@openai/codex-sdk@0.142.5`, `startThread()/resumeThread()/runStreamed()` (7 structured event types), threads at `~/.codex/sessions`, ChatGPT-account or API-key auth. Pros: covers the two largest agent ecosystems after Claude ("DorkOS runs the top 3 coding agents") + full open/local coverage via OpenCode; both have official TS SDKs → clean adapters. Cons: Codex has zero local-model support (accepted — OpenCode covers it); OpenCode's new SQLite session store has open reliability issues (growth #22110, NFS corruption #14970) — mitigated by treating OpenCode's server as the source of truth and reading via its SDK rather than scanning its DB.
  2. **OpenCode + Pi.** Pi post-acquisition is healthier (Earendil funding, MIT core per RFC-0015, `@earendil-works/pi-agent-core@0.80.3`, refactor settled) and is the "roll our own"/embedded path — in-process `Agent` class, no subprocess, could eventually power DorkBot natively. Rejected for this round: overlaps OpenCode's local-model coverage while skipping the OpenAI user base; watch-flag on Earendil Fair-Source add-on drift. Strong candidate for runtime #4.
  3. **OpenCode + Cline.** Cline CLI is GA (Apache-2.0, shares the agent core with the dominant VS Code extension). Rejected: heavy coverage overlap with OpenCode (both open, ACP, local models); its CLI identity is younger than its IDE identity.
  4. ~~Gemini CLI~~ — eliminated by events: Google stopped serving individual requests June 18, 2026; successor Antigravity CLI is closed-source.
- **Integration architecture per adapter:**
  - **OpenCode adapter:** manage a per-server-instance `opencode serve` child process (health-checked, lazy-started, port from config; auth via its own `auth.json`). Map DorkOS sessions 1:1 to OpenCode sessions via the SDK; stream SSE events → `StreamEvent`; sessions/history read through the SDK (its SQLite store stays OpenCode-owned). Permission flow: OpenCode permission requests → `supportsToolApproval` flow.
  - **Codex adapter:** SDK-managed CLI subprocess per query (the SDK spawns `codex` and speaks JSONL over stdio). `ensureSession` ↔ `startThread`/`resumeThread` (thread id persisted as the session id mapping); `runStreamed()` events → `StreamEvent`. Auth reuses `codex login` state; `checkDependencies` verifies binary + auth. Note v0.132.0 breaking change (explicit sandbox/approval params) and the June 2026 CLI logging-volume bug (`logs_2.sqlite`) — pin SDK version, verify patch status during implementation.
  - Both adapters follow the test-mode pattern for live state (EventLog + `SessionStateProjector`) and implement their own `listSessions`/`getMessageHistory` against native storage. Locking, `session_metadata` persistence, SSE delivery, and context injection (ADR-0273 `additionalContext`) come from existing shared machinery.
- **UI/UX direction (the 10/10 bar):**
  - **Show:** runtime badge on agent rows/cards (exists), agent detail header, session header chip, session list rows (subtle), new-session flow. One consistent runtime identity: icon + label + accent from a single `RuntimeDescriptor` registry in the client (`@dorkos/icons` additions for OpenCode/Codex marks).
  - **Set/change:** runtime picker in new-session flow (default from agent → config → `claude-code`); agent detail gets a runtime select (writes `.dork/agent.json` file-first per ADR-0043). Honest-by-design: changing an agent's runtime shows "applies to new sessions; existing sessions keep their runtime."
  - **Capability-adaptive chrome:** permission-mode picker renders the runtime's declared modes (`RuntimeCapabilities.permissionModes` — already structured for this); cost strip hidden when `supportsCostTracking: false`; model picker per runtime via `getSupportedModels()`.
  - **Absent-dependency onboarding:** `checkDependencies()` per runtime drives an install/auth guide state (e.g. "Codex CLI not found — `npm i -g @openai/codex`, then `codex login`") instead of dead dropdowns. The Apple Test: "Chat with your Codex agent from DorkOS" — never "configure a runtime adapter."
- **DX direction:** a runtime **conformance suite** (shared Vitest harness run against every registered runtime: session lifecycle, streaming, interrupt, history, capability contract) so runtime #4 is a checklist, not archaeology; ESLint SDK-confinement rules for `@opencode-ai/sdk` → `services/runtimes/opencode/` and `@openai/codex-sdk` → `services/runtimes/codex/` (mirroring the existing Claude rule); a `contributing/adding-a-runtime.md` guide.
- **Recommendation:** proceed with OpenCode + Codex adapters plus the runtime-selection UX above; defer Pi to a follow-up (candidate runtime #4) and a possible generic ACP adapter after two concrete adapters exist.

## 6) Decisions

| #   | Decision                      | Choice                                                                       | Rationale                                                                                                                                                                      |
| --- | ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Which two runtimes            | **OpenCode + Codex** (user-confirmed)                                        | OpenCode satisfies the open-source-model constraint with the strongest SDK/community; Codex brings the OpenAI ecosystem — together with Claude Code, the top three agent CLIs. |
| 2   | Runtime-selection UX scope    | **Agent + session** (user-confirmed)                                         | Runtime is already per-session in the data model (ADR-0255); agents bind a default for their sessions. Session-level picker covers ad-hoc (agent-less) chats.                  |
| 3   | Integration style per runtime | OpenCode = managed `opencode serve` + SDK/SSE; Codex = SDK thread subprocess | Each runtime's official, supported surface; avoids scraping OpenCode's SQLite or Codex's session files directly.                                                               |
| 4   | Session storage               | Runtime-owned native storage; no unified DorkOS transcript store             | Follows the proven claude-code (JSONL) and test-mode (EventLog) split; `session_metadata` + EventLog projection give cross-runtime uniformity where it matters.                |
| 5   | Pi / roll-our-own             | Deferred, not rejected                                                       | Post-acquisition Pi is healthy (MIT core, funded) but overlaps OpenCode's local coverage; revisit as runtime #4 or as a native DorkBot engine.                                 |
| 6   | Generic ACP adapter           | Deferred                                                                     | Design it after two concrete adapters reveal what the abstraction must cover; premature abstraction risk.                                                                      |

**Next step:** SPECIFY (`/flow:specify`) — the decisions above are resolved; the spec should freeze the adapter contracts, session-mapping semantics, UX surfaces, config schema (`runtimes.*`), conformance suite scope, and dependency-onboarding flows.
