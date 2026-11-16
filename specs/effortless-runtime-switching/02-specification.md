---
slug: effortless-runtime-switching
number: 271
created: 2026-07-03
status: specified
---

# Effortless Runtime Switching: Connect Once, Switch Anytime

**Status:** Draft
**Author:** Dorian (brief) / Claude (spec)
**Date:** 2026-07-03

## Overview

DorkOS runs three agent backends (Claude Code, Codex, OpenCode; DOR-180). This spec makes going from "Claude only" to a working Codex or OpenCode session a terminal-free, sibling-grade experience, and makes ongoing switching a single pick. The north star is **"Three agents. Connect once. Switch anytime."**

It delivers three cumulative tiers as one committed scope:

- **T0 (truth + consistency):** resolve Codex's already-vendored binary so it stops falsely reporting "needs setup"; reframe the setup surface to a two-state **Ready / Connect** with an Advanced disclosure; make the three runtimes present identically; add opt-in, on-demand OpenCode binary provisioning.
- **T1 (kill the terminal):** a `CredentialProvider` port and `providers` config block; an in-app connect flow per provider (delegate vs native, chosen honestly per provider's terms); the OpenCode provider picker (Local/Ollama zero-auth hero, Gateway/OpenRouter, Direct key).
- **T2 (discovery + delight):** identity shown as runtime + model; "Run this with…" re-run onto another runtime; per-model nature badges (privacy/cost); a dedicated Runtimes surface; a guided, hardware-aware Ollama model pull.

This spec **evolves** the DOR-180 substrate (`AgentRuntime`, `runtimeRegistry`, per-session immutable binding per ADR-0255, `RuntimeSetupDialog`/`DependencyInstallHint`/`useRuntimeRequirements`, per-adapter `checkDependencies`, the `RuntimeDescriptor` registry). It does not rebuild them and does not change the `AgentRuntime` contract.

## Background / Problem Statement

DOR-180 shipped three runtimes behind one interface, but using anything other than Claude today means leaving the app for a terminal (`npm i -g …`, then `codex login`), and the three surface in three inconsistent states. Applying the DorkOS design mentors (AGENTS.md) to the shipped UX surfaced five concrete gaps:

1. The setup wall is a terminal round-trip that exposes plumbing (binary, dependency, CLI, install command, sidecar).
2. Codex falsely reports "needs setup": its binary is vendored by `@openai/codex-sdk`, but the Codex `checkDependencies` probe only inspects `PATH`.
3. The three are not siblings: one auto-works (Claude), one falsely needs setup (Codex), one needs a real install (OpenCode).
4. Discovery is weak: a Claude user may never learn DorkOS speaks Codex or OpenCode.
5. "Run this with Codex instead" is impossible.

The design bar is Jobs (delete the plumbing; the goal is three words, "use Codex"), Ive (rigor toward sameness; the user should feel none of the under-the-hood difference), and Rams (keep what is true and useful visible, hide the how). What DOR-180 got right stays: the read-only-after-start chip, capability-gating, one descriptor driving identity, needs-setup over raw error. The gap is entirely on the **connect** and **discover** seams.

## Goals

- A person goes from Claude-only to a working Codex or OpenCode session **without opening a terminal**.
- The three runtimes present as siblings: each is **Ready**, or offers a single **Connect**.
- Codex's false "needs setup" is gone: the SDK-vendored binary is resolved and reported Ready.
- OpenCode is installable on demand (one action, no `npm i -g`) and its **Local (Ollama)** path connects with **zero auth**, private and free.
- A single credential connection per provider (or none, for a local model), stored by reference, never as plaintext in human-edited config.
- Discovery: a Claude user can learn about and try the other runtimes in-product ("Run this with…", a Runtimes surface, honest per-model badges).
- Identity reads as **runtime + model** ("OpenCode · qwen2.5-coder"), surfacing the local-model story.

## Non-Goals

- **Cross-runtime session-history transplant.** "Run this with…" re-runs the prompt into a fresh session; it never migrates an existing conversation's messages onto another runtime. (Rejected in DOR-180, still rejected.)
- **Changing the shipped default runtime** away from `claude-code`.
- **A reimplemented claude.ai browser OAuth.** ToS-prohibited (see Detailed Design → Connect). Claude stays on delegate-to-host-login.
- **A native reimplementation of any provider's _subscription_ OAuth** (Anthropic-banned; undocumented for OpenAI) until that provider's terms are explicitly verified. Subscription sign-in delegates to the vendor CLI.
- **A hosted DorkOS-cloud credential broker / proxy.** This connects the user's own accounts locally.
- **Owning or managing the Ollama process or its model library.** DorkOS detects Ollama and (at most) links to its installer and triggers a single pull; Ollama owns its lifecycle.
- **Bundling runtime binaries into the base install by default.** Provisioning stays opt-in / on-demand (local-first Non-Goal carried from DOR-180).

## Technical Dependencies

- **`@openai/codex-sdk@0.142.5`** (already a dependency): vendors the real `codex` executable as a per-platform optional dependency (verified present at `node_modules/.pnpm/@openai+codex@0.142.5-<platform>/…/@openai/codex/vendor/<triple>/bin/codex`). T0 resolves this path.
- **`opencode-ai@1.17.13`**: declares 12 `optionalDependencies` (per-platform binaries with `os`/`cpu` gating, a `bin`, and a `postinstall`). Added as an **opt-in / on-demand** dependency so installing it pulls only the current platform's binary. Version-matches the `@opencode-ai/sdk` already in use.
- **OpenRouter** (`https://openrouter.ai`): API-key auth and **OAuth-PKCE key provisioning** for the OpenCode Gateway path. OAuth-PKCE is ToS-clean here (OpenRouter is built for app integration).
- **Ollama** (detected, not managed): local HTTP API (`http://127.0.0.1:11434`) for model listing and pull. No account.
- **DOR-180 substrate** (`specs/additional-agent-runtimes/`): the runtimes, registry, requirements surface, and descriptor registry this extends. Its `04-implementation.md` follow-ups ("make `checkDependencies` probes async", "needs-setup UX") are absorbed here.
- Auth substrate: `research/20260625_agent_auth_patterns_meta_harnesses.md` (the `CredentialProvider` port, `providers` config block, and MCP-style OAuth subsystem this builds on).

## Detailed Design

### Architecture changes

Three seams change; the `AgentRuntime` contract and the ADR-0255 selection data model do not.

1. **Binary resolution** gains a vendored-path resolver alongside the existing PATH probe (T0).
2. **A `CredentialProvider` port** is introduced as a narrow seam near the runtime env-injection point, backed by a `providers` config block with a reference scheme (T1).
3. **A connect surface** (server endpoints + client Runtimes UI) drives provisioning, credential connection, and vendor-CLI delegation (T1/T2).

### Implementation approach (by contract)

**Ready / Connect state model (T0).** Each runtime resolves to exactly one of:

- **Ready** = binary resolvable **AND** (auth satisfied **OR** auth not required, e.g. a detected local Ollama model).
- **Connect** = anything blocking the above, surfaced as a single call to action (install the binary, connect an account, or pick a provider), never as a raw dependency error.

`checkDependencies()` per adapter is the source of truth; `GET /api/system/requirements` projects it. Binary/CLI/sidecar vocabulary moves behind an **Advanced** disclosure (kept for the Priya persona; hidden from the default path per the Apple Test). The probes become **async** (absorbing the DOR-180 follow-up), so a slow or hung probe never blocks the event loop.

**Vendored-binary resolution (T0).** `resolveCodexBinaryPath` (`services/runtimes/codex/check-dependencies.ts`) resolves the SDK-vendored path (mirroring `resolveClaudeCliPath`) before falling back to PATH; the vendored path makes Codex **Ready** out of the box. The resolution pattern is factored so every adapter (present and future) can resolve "SDK-vendored, else configured `binaryPath`, else PATH" uniformly.

**Opt-in OpenCode provisioning (T0).** `opencode-ai` is added as an optional/on-demand install rather than bundled. A server action installs it (pulling only the current platform's binary via the optional-platform-package mechanism) and reports progress; on success OpenCode resolves Ready. The base install stays lean.

**`CredentialProvider` port + config (T1).** A narrow port resolves a credential reference to a secret at the runtime env-injection seam (near the Claude env injection in `message-sender.ts`). Config gains a `providers` block; credentials are stored **by reference** using a `keychain:` / `env:` / `file:` scheme, never inline plaintext. Schema change ships with a semver-keyed `conf` migration (per `contributing/configuration.md`).

**Connect-flow-per-provider (T1).** "In-app" does not mean "we own the OAuth." The matrix, chosen per provider's terms:

| Runtime  | Connect flow (terminal-free)                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude   | Delegate to `claude login` (button-triggered spawn, detect completion); or read host credentials; or paste an API key. Never a reimplemented claude.ai OAuth.                                          |
| Codex    | Native **API-key** entry (clean, sanctioned). "Sign in with ChatGPT" **delegates to `codex login`** (button-triggered, terminal-free). No native subscription OAuth until OpenAI's terms are verified. |
| OpenCode | A **provider picker** (below). No single "login"; connecting means choosing where the model comes from.                                                                                                |

**OpenCode provider picker (T1/T2).** OpenCode is provider-agnostic; its connect is "choose where the model comes from," presented as a small menu with two easy paths featured:

- **Local (Ollama) — the zero-auth hero (private, free).**
  - _Baseline (T1):_ detect a running Ollama + any pulled models -> connect with **zero auth**.
  - _Guided (T2):_ if Ollama is present but no coding model is pulled, offer a curated, **hardware-aware** one-click pull (e.g. `qwen2.5-coder`) with honest sizing ("~18 GB; runs well / may be slow on your hardware") and download progress.
  - _Boundary:_ detect and link to the Ollama installer (at most a one-click download). Do not own or manage the Ollama process or its model library.
  - _Honesty (Rams):_ tool-calling below ~14B is unreliable (DOR-180 research). Never sell a 7B as Claude-equivalent.
- **Gateway (OpenRouter) — one key, every model (T1).** _Easiest:_ paste an OpenRouter key (+ a get-a-key link); the model dropdown populates from OpenRouter's catalog. _Slickest:_ a "Connect OpenRouter" button using **OAuth-PKCE key provisioning** that auto-creates a scoped key (no copy-paste). This is the one place a fully-native in-app OAuth is unambiguously right.
- **Direct provider — your existing key (T1).** Paste a provider key (+ optional `baseURL`); a gateway/baseURL override is the same shape.

**Identity = runtime + model (T2).** Surfaces show runtime **and** model ("OpenCode · qwen2.5-coder"), driven by `useCapabilitiesForRuntime` / `getSupportedModels()`. This is where the local-model superpower becomes legible.

**"Run this with…" (T2).** Re-runs the current prompt into a **fresh** session bound to another runtime (ADR-0255 immutable binding; a switch is always a new session, never a mutation or a history transplant). Hooks the existing prompt + `?runtime=` launch path.

**Nature badges (T2).** Per-model badges at the point of choice: privacy/cost read (local · private · free vs cloud · per-token) plus an honest capability signal, so the real tradeoff (privacy/cost vs frontier capability) is visible, not hidden. A short benefit line on the Local path ("Private and free: runs on your machine; your code never leaves it; no per-token bills"), with the plain counterweight that frontier quality still comes from Claude/Codex or a top cloud model via OpenRouter.

**Runtimes surface (T2).** A dedicated surface with three sibling cards, each Ready or a single Connect; the home for discovery and connect.

### Code structure & file organization

- **Server:** `services/runtimes/codex/check-dependencies.ts` (vendored resolution), `services/runtimes/opencode/check-dependencies.ts` + `server-manager.ts` (provisioning), a shared vendored-resolution helper; `routes/system.ts` (async requirements + Ready/Connect projection); new connect/provisioning/Ollama/OpenRouter endpoints (see API changes); a `CredentialProvider` port near the `message-sender.ts` env seam.
- **Shared:** `packages/shared/src/config-schema.ts` (`runtimes.*` extension + `providers` block; semver migration).
- **Client:** `entities/runtime` (`runtime-descriptors.ts` extended with connect/model identity; `useRuntimeRequirements`; the `RuntimeSetupDialog`/`DependencyInstallHint` reframed to Ready/Connect; `RuntimeItem`), a new Runtimes surface (widget) with the provider picker, connect flows, nature badges, and "Run this with…" entry points; `SessionLaunchPopover` / `useRuntimeChip` for switching.

### API changes

- `GET /api/system/requirements`: async probes; report per-runtime **Ready/Connect** and available connect actions (install / login-delegate / provider-picker) rather than raw dependency rows.
- **Provisioning:** an endpoint to trigger the opt-in OpenCode install with progress.
- **Connect:** an endpoint to store a credential reference (via `CredentialProvider`), and to trigger a delegated vendor login (`claude login` / `codex login`) and detect completion.
- **OpenRouter:** OAuth-PKCE start + callback handling that provisions and stores a scoped key.
- **Ollama:** detection (running? which models pulled?) and a single guided pull with progress.

All secret-bearing endpoints are loopback-only and never echo secrets.

### Data model changes

- `runtimes.{codex,opencode}` config extended with credential/provider references and (OpenCode) provider-picker selection.
- New top-level `providers` config block holding `CredentialProvider` references (`keychain:`/`env:`/`file:`).
- Semver-keyed `conf` migration; no breaking change to existing keys.

### Integration with external libraries

- Codex vendored binary via the SDK's optional-platform-package (resolve the `vendor/<triple>/bin/codex` path).
- OpenCode binary via adding `opencode-ai` on demand (optional-platform-package install).
- OpenRouter OAuth-PKCE + REST for key provisioning and model catalog.
- Ollama local HTTP API for model list + pull.

## User Experience

- **First encounter (discovery):** a Claude-only user sees the other runtimes presented as siblings on the Runtimes surface and (T2) an inline "Run this with…" affordance on a prompt. Each sibling shows **Ready** or one **Connect**.
- **Connect Codex (terminal-free):** click **Connect** -> choose "Paste API key" (native, done in-app) or "Sign in with ChatGPT" (button spawns `codex login`, DorkOS detects completion). Codex flips to Ready; the vendored binary was already resolved, so no install step.
- **Connect OpenCode -> Local/Ollama (the hero):** click **Connect** -> **Local**. If Ollama is running with a coding model, connect with **no account**; identity reads "OpenCode · qwen2.5-coder", badged private · free. If Ollama is present without a coding model, offer the guided hardware-aware pull with honest sizing and progress. If Ollama is absent, link to its installer (no further management).
- **Connect OpenCode -> Gateway/Direct:** paste an OpenRouter key (or "Connect OpenRouter" via OAuth-PKCE), or paste a direct provider key + optional `baseURL`. The model dropdown populates accordingly.
- **Switch / Run this with…:** picking a runtime for a new session, or re-running the current prompt on another runtime, always opens a **fresh** session; the runtime + model mark shows who runs each session.
- **Error / exit paths:** a failed install, a hung delegated login, a missing/withdrawn credential, or an unreachable Ollama each resolve back to a clear single Connect action with an honest message, never a raw stack or PATH error. Advanced disclosure remains available for the operator who wants the underlying detail.

## Testing Strategy

- **Unit:** vendored-binary resolution (Codex resolves vendored path; falls back to configured `binaryPath` then PATH); Ready/Connect state derivation across the truth table (binary present/absent × auth satisfied/none/not-required); `CredentialProvider` reference resolution (`keychain:`/`env:`/`file:`) with a secret never appearing in serialized config; config migration up/down.
- **Integration:** the connect endpoints (store reference, delegate login + completion detection, OpenRouter OAuth-PKCE happy path + denial, OpenCode opt-in install success/failure, Ollama detect + guided pull progress/failure); async requirements projection with a slow/hung probe (must not block).
- **E2E (Playwright, real Chromium):** the three connect flows to Ready; the Ollama zero-auth path; "Run this with…" opening a fresh session bound to the new runtime; identity showing runtime + model.
- **Mocking strategy:** mock the vendored binaries, the Ollama HTTP API, and OpenRouter; never spawn a real login or hit a real provider in CI. Each test carries a purpose comment; include failure-revealing edge cases (hung probe, denied OAuth, install failure, withdrawn credential).

## Performance Considerations

- Requirements probes become async and are bounded (a hung `which`/login/detect must never block the event loop; this generalizes the DOR-180 timeout fix). Cache probe/detection results with a short TTL and avoid focus-refetch storms (mirroring the DOR-180 requirements-query settings).
- Ollama detection and OpenRouter catalog fetches are cached; model pulls stream progress rather than blocking.

## Security Considerations

- Credentials are stored **by reference** (`keychain:`/`env:`/`file:`), never as plaintext in human-edited config; secrets are never logged or echoed by endpoints.
- OAuth-PKCE uses a state/verifier and a loopback callback; only OpenRouter (which invites app OAuth) gets a native OAuth flow. No provider **subscription** OAuth is reimplemented.
- Delegated logins spawn the vendor's own CLI; DorkOS never handles subscription credentials directly.
- The OpenCode sidecar stays loopback-only with its per-boot secret (unchanged from DOR-180).

## Documentation

- `contributing/adding-a-runtime.md`: add the connect-flow contract and the vendored-resolution + `CredentialProvider` seams so runtime #4 inherits them.
- A user-facing doc on connecting each runtime (Claude delegate, Codex key/ChatGPT, OpenCode Local/Gateway/Direct), leading with the Ollama zero-auth path.
- `contributing/configuration.md`: the `providers` block + reference scheme.

## Implementation Phases

- **Phase 1 (T0) — truth + consistency:** vendored-binary resolution (Codex Ready); async Ready/Connect requirements + Advanced disclosure; opt-in OpenCode provisioning; three-siblings presentation.
- **Phase 2 (T1) — kill the terminal:** `CredentialProvider` port + `providers` config + migration; connect-flow-per-provider (Claude delegate, Codex key + `codex login` delegate); OpenCode provider picker (Ollama zero-auth baseline, OpenRouter paste-key + OAuth-PKCE, Direct key).
- **Phase 3 (T2) — discovery + delight:** identity = runtime + model; "Run this with…"; nature badges; the Runtimes surface; the guided hardware-aware Ollama pull.

## Open Questions

- **VRAM/RAM heuristic for the guided pull:** how to estimate "will this model run well on your machine" (a static VRAM/RAM-vs-model-size heuristic vs a quick benchmark). Lean static heuristic first; keep the sizing copy honest either way.
- **OpenRouter OAuth-PKCE specifics:** confirm the exact scope/callback contract against OpenRouter's current app-integration docs before building the native flow; the paste-key path is the always-available fallback.

- ~~**First shippable slice: T0-only vs T0+T1 vs full.**~~ **(RESOLVED, 2026-07-03)** — **Answer:** full **T0 + T1 + T2**. **Rationale:** the north star ("connect once, switch anytime") lives in T1, and the discovery/delight of T2 is what turns "we support three runtimes" into a reason to use DorkOS; the user chose the complete scope. The phases above stage the delivery.
- ~~**Codex subscription sign-in: delegate vs native OAuth.**~~ **(RESOLVED, 2026-07-03)** — **Answer:** delegate to `codex login` (terminal-free) + native **API-key** entry; build a native subscription OAuth only after OpenAI's terms on third-party subscription OAuth are explicitly verified. **Rationale:** the API-key path is sanctioned and clean; the subscription-OAuth path carries the same _shape_ of risk Anthropic banned and is undocumented for OpenAI, so delegation is the safe, still-terminal-free default.
- ~~**Local-model install depth: detect-only vs guided pull vs installer.**~~ **(RESOLVED, 2026-07-03)** — **Answer:** detect (baseline, T1) + a guided hardware-aware pull (T2); at most link to the Ollama installer; never own or manage Ollama. **Rationale:** the zero-auth detect path is the hero and must be effortless; the guided pull is the delight but must stay hardware-honest; owning Ollama's lifecycle is out of scope.

## Related ADRs

- **ADR-0315** (draft, this spec): `CredentialProvider` port + `providers` config block + reference scheme.
- **ADR-0316** (draft, this spec): SDK-vendored-binary resolution across runtime adapters.
- **ADR-0317** (draft, this spec): opt-in / on-demand runtime provisioning (add `opencode-ai` lazily; do not bundle by default).
- **ADR-0318** (draft, this spec): connect-flow-per-provider (in-app connect that delegates subscription OAuth to the vendor CLI; native only where the provider invites it).
- **ADR-0255** (accepted): per-session immutable first-write-wins runtime binding (constrains "switch = new session").
- **ADR-0307 / 0308 / 0309 / 0310** (accepted, DOR-180): the runtime pair, OpenCode sidecar, Codex threads, runtime-owned storage this extends.

> ADR numbering note: this spec claims **0315–0318**. The concurrent `accounts-and-auth` spec reserves **0311–0314**; DOR-183 intentionally starts above it so the two never collide (final contiguous range 0307–0318 once both merge).

## References

- `specs/effortless-runtime-switching/01-ideation.md` (this spec's input; the tier model, ToS analysis, provisioning table, and 11 resolved decisions).
- `specs/additional-agent-runtimes/` (DOR-180: the runtime substrate this extends; its `04-implementation.md` follow-ups absorbed here).
- `research/20260625_agent_auth_patterns_meta_harnesses.md` (the load-bearing auth/ToS reference; the `CredentialProvider` port + `providers` block + MCP-style OAuth substrate).
- `research/20260405_ai_coding_agent_runtime_landscape.md`, `research/20260405_pi_coding_agent_and_local_model_frameworks.md` (runtime + local-model landscape).
- Tracker: DOR-183.
