---
id: 260722-184734
slug: opencode-connect-overhaul
tracker: DOR-421
design-session: .dork/visual-companion/43160-1784741753
status: specified
---

# OpenCode connect overhaul — specification

Fix the readiness root cause, then rebuild the connect UX around one principle: **connecting is setup; choosing a model is a toolbar decision.** All user-facing copy follows the `writing-for-humans` skill.

## Scope

Two PRs, sequenced (PR2 builds on PR1's API):

- **PR1 — server + shared:** credential-aware readiness, model-tier metadata + sorting, Ollama installed-list/pull-by-name/catalog expansion, GPU probe.
- **PR2 — client:** power-source picker, success + handoff, tiered model menu, local panel, dead-code removal.

Out of scope: changing per-session runtime immutability (ADR-0255); any new gateway beyond OpenRouter; Windows `systeminformation` dependency (nvidia-smi only); live benchmarking.

## PR1 — server + shared

### 1. Credential-aware OpenCode readiness (the root-cause fix)

`checkOpenCodeDependencies` (`apps/server/src/services/runtimes/opencode/check-dependencies.ts`) currently derives auth solely from `opencode auth list`. Change the auth check to consult DorkOS's own persisted provider state FIRST:

- **Satisfied** when `config.runtimes.opencode.provider` is set AND its credential requirement is met: for providers needing a key (`openrouter`, `openai`, `anthropic`, and Direct providers), the reference in `config.providers[provider]` must resolve via the credential provider (same resolution seam as `resolveOpenCodeProviderEnv`, `services/core/credential-env.ts`); for `ollama`, no credential is needed (provider set = satisfied — optionally confirm reachability non-blockingly, do not block readiness on a probe).
- Otherwise fall back to today's `opencode auth list` probe (users who authenticated the CLI directly must keep working).
- Check copy must say what satisfied it in plain language, e.g. "Connected via OpenRouter" / "Using models on this computer (Ollama)" / "Signed in with the OpenCode CLI".
- A set provider whose credential reference no longer resolves is **missing** (honest degradation), with copy pointing at reconnecting.
- Constraint: `deriveRuntimeReadiness` (`packages/shared/src/agent-runtime.ts`) matches the auth check by `/auth|login/i` on the check name — keep the name matching that contract.
- Tests: provider set + resolvable ref (each provider incl. ollama), provider set + dangling ref, no provider + CLI-auth fallback, neither.

### 2. Model tiers (shared vocabulary) + sorting

New shared type in `@dorkos/shared` (runtime-connect or model schema, wherever `ModelOption` lives): `ModelTier = 'frontier' | 'solid-coder' | 'quick-helper'`. Extend `ModelOption` with optional `tier?: ModelTier` and `local?: boolean` (additive, no consumer breaks).

New server module `services/runtimes/opencode/model-tiers.ts`:

- Curated pattern-map for headliners → `frontier` (Anthropic Claude Sonnet/Opus, OpenAI GPT-5.x/o-series, Google Gemini Pro, DeepSeek R1/V3+, xAI Grok 4, Qwen Max-class). Data-driven table, unit-tested; unknown models get **no tier** (never guess a headline).
- Known coding/mid models and 10B–70B params → `solid-coder`; <10B → `quick-helper` (params parsed from id/name where present, e.g. `:7b`, `-14b`).
- `sortModelOptions`: Frontier (curated order) → Solid coders → Quick helpers → untiered (alphabetical). Stable and pure.

Apply in `projectModelOptions` (`services/runtimes/opencode/models.ts`): tag tiers, tag `local: true` for `ollama/*` provider models, and return sorted. Claude-code and codex runtimes are untouched (their short lists need no tiers).

### 3. Ollama: installed list, catalog expansion, pull-by-name

- **Installed models with fit verdicts:** extend `GET /api/runtimes/opencode/ollama` (or a sibling endpoint if cleaner) to return installed models from `/api/tags` each with `{ id, sizeBytes, assessment }` where assessment reuses `classifyModelFit` — derive `minMemoryBytes` from the tag's on-disk size with the existing headroom constant (footprint ≈ file size; comfortable needs the same 1.5× headroom). Zod schemas in `@dorkos/shared/runtime-connect`.
- **Catalog:** expand `OLLAMA_CODING_MODELS` from 2 to ~6 honest coding picks spanning tiers (e.g. qwen2.5-coder 7b/14b/32b, deepseek-r1 14b, plus 1–2 current strong coding models the implementer verifies exist as Ollama tags with real sizes). Each entry gains `tier`.
- **Pull-by-name:** `POST /api/runtimes/opencode/ollama/pull` accepts any syntactically valid Ollama tag (`/^[a-z0-9][a-z0-9._\-\/]*(:[a-z0-9._\-]+)?$/i`), not just curated ids. Keep SSE progress frames. Non-curated pulls skip the fit gate but the response includes a post-hoc assessment when size becomes known. Keep loopback-only.

### 4. GPU-honest verdicts (Windows/Linux)

`detectHardware` (`ollama-catalog.ts`) gains an async probe used on non-Apple-Silicon platforms: `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits` via `execFile` with a ~1.5s timeout; on success set `vramBytes` (largest GPU). Failure or absence → today's behavior (RAM-only, honest copy). No new npm dependency; no WMI. `classifyModelFit` already handles `vramBytes`. Callers that are sync today move to the async variant.

## PR2 — client

### 5. Power-source picker (replaces the Local/Gateway/Direct tabs)

`OpenCodeProviderPicker` becomes a single-column choice list (final copy from the design session, storyboard step 2):

- **"Best models, zero setup"** (recommended, first): "Claude, GPT, Gemini and 300+ more, running in the cloud — your hardware doesn't matter." Sub: "One OpenRouter account covers all of them. Pay only for what you use." Trade-off line: "Your prompts and code are sent to the model's provider." → OpenRouter connect step (OAuth button + paste-key, as today, minus the model picker).
- **"Private and free, on your computer"**: "Models run on this Mac — nothing you type ever leaves it." Sub: "Runs Quick helpers and Solid coders. Frontier models stay cloud-only." Trade-off: "Smaller models — great for edits and quick help, not frontier-level reasoning." → local panel (§7). Platform-adaptive noun ("this Mac"/"this computer").
- **"I have my own API key"** (quiet row): "Connect straight to Anthropic, OpenAI, or any OpenAI-compatible server (LM Studio, vLLM…)." → existing Direct form.

Selecting a card navigates within the dialog (with back); no tabs. The three existing path components are refactored into these steps, not rewritten from scratch.

### 6. Success moment + runtime handoff; kill the dead dropdown

- On connect success (any path): a success panel — "✓ OpenCode is connected. Frontier models are unlocked. This session will use OpenCode — pick any model from the model menu, anytime." with a **Done** button. Dialog closes on Done (replace the silent auto-close for this flow).
- The `ModelPicker` in `OpenRouterGatewayPath.tsx` is **deleted**, along with `useOpenRouterModels` and — once nothing references them — the server's `GET /api/runtimes/opencode/openrouter/models` route + `fetchOpenRouterModels` + transport method (dead-code policy; model discovery now rides `GET /api/models` via the sidecar).
- Handoff: keep the existing `onRuntimeReady` → `onChangeRuntime(type)` → `pendingRuntime` wiring (it becomes live once PR1 fixes readiness). Test the full chain: connect → requirements refetch → ready flip → pending runtime set → first message posts `runtime: 'opencode'`.

### 7. Local panel (scope B)

Per the approved mockup: Ollama status line ("● Ollama is running · N models installed · nothing you type leaves this Mac"); **Installed** list with tier badge + fit verdict per model; **Add a model** curated shelf (tier badge, size, verdict, one-click Get with streamed progress); **pull any model by name** input; "Browse the library →" link (https://ollama.com/library, external); footer escape hatch "Run local models with LM Studio or another server? Connect it directly" → Direct form with base-URL field. When Ollama isn't installed/running, keep today's guided install/start path, then land here.

### 8. Tiered model menu

`ModelConfigPopover` (`features/status/ui/ModelConfigPopover.tsx`): when options carry tiers or exceed ~10, render a search input (filter by id/name) and group by tier — labels **Frontier / Solid coders / Quick helpers / More models** — with `local` models suffixed "this Mac · private". Small untiered lists (claude-code, codex) render exactly as today. Keyboard navigation and mobile (ResponsiveDropdownMenu/sheet) must both work.

## Acceptance criteria (end-to-end)

1. Fresh session → runtime item → OpenCode "Set up" → connect OpenRouter (key or OAuth) → success panel → Done → toolbar shows OpenCode; first message binds the session to OpenCode (`session_metadata`).
2. Full page reload (and server restart) after connect: `GET /api/system/requirements` reports OpenCode `ready`; no re-auth prompt.
3. Model menu for an OpenCode session shows tier groups + search; local models marked "this Mac · private"; list no longer in raw API order.
4. Local panel lists installed models with honest verdicts; pulling `qwen2.5-coder:32b` by name streams progress and lands in Installed; curated shelf shows ~6 models.
5. On a Linux/Windows box with an NVIDIA GPU, verdicts use VRAM (unit-tested via injected hardware snapshot; no live CI GPU dependency).
6. No dead code: gateway ModelPicker, `useOpenRouterModels`, and the openrouter/models route are gone.
7. `pnpm verify` green; changelog fragment per PR; conformance suite untouched/passing.

## v1.1 addendum — post-dogfood findings (DOR-427, 2026-07-22)

Operator verification confirmed the flow works end-to-end with Ollama, and surfaced two gaps:

### 9. Reconfigure a connected runtime (PR3)

A ready OpenCode has no way to change its power source. Fix: the ready-state setup surface gains a **Change** affordance that reopens the power-source picker with the current source labeled ("Currently: On your computer (Ollama)"). Switching runs the normal connect flow for the new source; the server side already supports it (`persistProviderCredential` is last-write-wins on `runtimes.opencode.provider` and recycles the sidecar). No disconnect/revoke management — switching is selection, stored keys stay.

### 10. Honest local-model availability (PR3)

`projectModelOptions` projects OpenCode's ollama _catalog_ (models.dev), so the menu offers models that aren't installed and a turn against one fails raw. Fix, server-side: for the ollama provider, offer only **installed** tags — intersect the provider's catalog with Ollama `/api/tags` (catalog metadata wins when the tag is known; installed tags missing from the catalog appended as plain options). If the tags probe fails, degrade to today's behavior rather than emptying the menu (comment why). No inline "Get" in the model menu — adding models stays in the local panel (scope B holds).

### 11. Vanished-model edge cases (PR3)

A session's saved model can stop existing (provider switched, model deleted). Client: when the saved model is absent from options, the model menu shows it marked "(not available)" with plain hint copy to pick another; never auto-switch. Server/client: a turn failure caused by an unknown/unavailable model maps to a friendly message pointing at the model menu (ride the typed turn-error path from the runtime-hardening batch), never a raw sidecar error.

## Risks / notes for implementers

- `deriveRuntimeReadiness` name-matching contract (see §1 constraint).
- Express 5 semantics on new/changed routes; loopback-only guard stays on all `/api/runtimes/*` mutations.
- OpenCode sidecar spawns with env from stored credentials — after a first-ever connect, the sidecar may need a restart to pick up the new key (`server-manager` restart seam exists; ensure connect success triggers it or the next boot uses it — verify and handle).
- Client FSD layers: picker work stays in `features/runtime-connect`; model menu in `features/status`; shared schemas via `@dorkos/shared` subpaths only.
- Copy through `writing-for-humans`; never claim unverified surfaces work (demo-claim gate).
