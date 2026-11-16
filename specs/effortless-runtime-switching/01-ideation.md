---
slug: effortless-runtime-switching
number: 271
created: 2026-07-03
status: ideation
---

# Effortless Runtime Switching: Connect Once, Switch Anytime

**Slug:** effortless-runtime-switching
**Author:** Dorian (brief) / Claude (ideation)
**Date:** 2026-07-03
**Tracker:** DOR-183 - Effortless runtime switching: connect once, switch anytime (Claude · Codex · OpenCode)
**Follows:** DOR-180 (OpenCode + Codex runtimes — in review)

---

## 1) Intent & Assumptions

- **Task brief:** DorkOS now runs three agent backends (Claude Code, Codex, OpenCode — DOR-180). Make **switching between them a 10/10 experience** at the Jobs/Ive bar. Today, using a second runtime means leaving the app for a terminal (`npm i -g …`, then `codex login`), and the three runtimes surface in three inconsistent states. The goal is: a person goes from "Claude only" to a working Codex or OpenCode session **without ever opening a terminal**, and the three feel like siblings.
- **North Star:** **Three agents. Connect once. Switch anytime.** A Runtimes surface with three sibling cards, each **Ready** or a single **Connect**. Connect = silently ensure the agent is present (resolve the vendored binary, or install on demand) + one in-app account connection (or nothing at all, for a local Ollama model). Then switching is just picking; the runtime mark shows who runs each session.
- **Assumptions:**
  - DOR-180 lands first: the `AgentRuntime` interface, `runtimeRegistry`, per-session binding (ADR-0255), the `RuntimeSetupDialog` / `DependencyInstallHint` / `useRuntimeRequirements` client surface, `checkDependencies` per adapter, and the `RuntimeDescriptor` identity registry all exist. This spec **evolves** those surfaces, it does not rebuild them.
  - Per-session runtime binding stays immutable first-write-wins (ADR-0255). "Switch" always means a **new session**, never mutating an existing one. "Run this with…" is therefore a re-run into a fresh session, not a transplant.
  - Runtime binaries are still not shipped in the base DorkOS install by default (local-first Non-Goal from DOR-180). Provisioning is **opt-in / on-demand**, not bundle-by-default.
  - Auth is irreducible: an account/login cannot be bundled. The best we can do is make it one in-app moment (or zero, for local models).
- **Out of scope:**
  - Cross-runtime session-history transplant (moving a Claude conversation's messages onto Codex). Rejected in DOR-180 and still rejected. ("Run this with…" re-runs the prompt, it does not migrate history.)
  - Changing the shipped default runtime away from `claude-code`.
  - A reimplemented **claude.ai** browser OAuth — ToS-prohibited (see §5). Claude stays on delegate-to-host-login.
  - A hosted DorkOS-cloud credential broker / proxy. This is about connecting the user's own accounts locally.

## 2) Pre-reading Log

- `research/20260625_agent_auth_patterns_meta_harnesses.md` — the load-bearing auth/ToS reference. Key: Anthropic's Jan-2026 crackdown targeted tools routing through Claude **Max/Pro subscription** OAuth tokens; the ToS-safe posture for Claude is **delegate to the host `claude` login** or use an API key, never a reimplemented claude.ai OAuth. It also proposes a `CredentialProvider` narrow port + a Zod `providers` config block + a near-verbatim-reusable MCP-style OAuth subsystem (from opencode/codex source). This spec builds on that substrate.
- `research/20260405_ai_coding_agent_runtime_landscape.md`, `20260405_pi_coding_agent_and_local_model_frameworks.md` — runtime landscape (OpenCode local-model story via Ollama / OpenAI-compatible endpoints).
- DOR-180 artifacts (`specs/additional-agent-runtimes/`) — the shipped runtime substrate this extends; its `04-implementation.md` follow-up list already names "make `checkDependencies` probes async" and "needs-setup UX," which this spec absorbs.
- Vendoring mechanics (verified against the DOR-180 tree + npm registry, 2026-07-03):
  - **Codex's binary is already vendored.** `@openai/codex-sdk` pulls the real `codex` executable as a per-platform optional dependency (present at `node_modules/.pnpm/@openai+codex@0.142.5-darwin-arm64/…/@openai/codex/vendor/aarch64-apple-darwin/bin/codex`), exactly like `@anthropic-ai/claude-agent-sdk` bundles Claude Code. DorkOS's Codex `checkDependencies` only probes `PATH`, so it falsely reports "needs setup" for a binary that is physically present.
  - **OpenCode ships via optional-platform-packages.** `opencode-ai@1.17.13` declares 12 `optionalDependencies` (`opencode-darwin-arm64`, `opencode-linux-x64`, … + musl/baseline variants), `os`/`cpu` gating, a `bin`, and a `postinstall`. Adding `opencode-ai` installs only the current platform's binary — a clean on-demand vendoring path with no `npm i -g`.

## 3) Codebase Map

- **Binary resolution:** `apps/server/src/services/runtimes/claude-code/…` `resolveClaudeCliPath` (the pattern to mirror). `apps/server/src/services/runtimes/codex/check-dependencies.ts` (`resolveCodexBinaryPath` — PATH-only today; must also resolve the SDK-vendored path). `apps/server/src/services/runtimes/opencode/check-dependencies.ts` + `server-manager.ts` (spawns `opencode serve` from the resolved binary).
- **Dependency/requirements surface:** `checkDependencies()` per adapter → `GET /api/system/requirements` (`routes/system.ts`, synchronous `execFileSync` probes — a DOR-180 follow-up to make async). Client: `useRuntimeRequirements` (entities/runtime), `RuntimeSetupDialog` + `DependencyInstallHint` (the current "copy the install command" UI to reframe), `RuntimeItem` (the status-bar picker + needs-setup split), `SystemRequirementsStep` (onboarding).
- **Runtime identity:** `apps/client/src/layers/entities/runtime/config/runtime-descriptors.ts` (`RuntimeDescriptor` = icon/label/accent; extend with connect/setup metadata + model identity), `@dorkos/icons` marks.
- **Capabilities + models:** `useCapabilitiesForRuntime` / `useSessionRuntime` (DOR-180), `getSupportedModels()` per runtime (OpenCode surfaces `provider/model`, incl. Ollama) — the substrate for "identity = runtime + model."
- **Config:** `packages/shared/src/config-schema.ts` `runtimes.{default,codex,opencode}` (extend for credential references / provider config; a semver migration per `contributing/configuration.md`). Proposed `CredentialProvider` port seam near the Claude env injection (`message-sender.ts` env seam, per the auth research).
- **Session launch / switching:** `?runtime=` launch param + first-send hint (DOR-180), `SessionLaunchPopover`, `useRuntimeChip`. "Run this with…" hooks the existing prompt + a fresh session bound to another runtime.
- **Blast radius:** primarily client (the connect UX + Runtimes surface) + server (binary resolution, provisioning, a credential/connect endpoint). No change to the `AgentRuntime` contract expected; the runtime-selection data model (ADR-0255) is unchanged.

## 4) Root Cause Analysis

Not a bug fix (though it absorbs one: Codex's false "needs setup"). Omitted.

## 5) Research

### 5.1 The Jobs/Ive read of the current experience

Applying the DorkOS design mentors (AGENTS.md) to the shipped DOR-180 UX:

- **Jobs (delete the plumbing).** The setup surface exposes _binary_, _dependency_, _CLI_, _install command_, _sidecar_ — system vocabulary, not user intent. The user's goal is three words: "use Codex." Everything between that and a working agent is friction. The current path forces two context-switches into a terminal.
- **Ive (rigor toward sameness).** Under the hood the three runtimes differ wildly (Claude SDK-vendored, Codex SDK-vendored-but-unused, OpenCode not vendored). The user should feel none of it — three agents, presented identically, differing only in _connected / not-yet_. Today they surface in three inconsistent states, which is the tell that the design leaks its implementation.
- **Rams (honest + unobtrusive).** Keep what is true and useful visible (Codex is OpenAI's; OpenCode can run a model on your own machine with no account). Hide the _how_ (sidecars, PATH, npm).

**What DOR-180 already got right** (the foundation is sound): the chip is unobtrusive and honestly read-only after start (reflecting immutable-per-session); capability-gating hides dead controls; one descriptor drives identity everywhere; needs-setup beats a raw error. The gap is entirely on the _connect_ and _discover_ seams.

**The five gaps:**

1. The setup wall is a terminal round-trip that exposes plumbing.
2. Codex falsely reports "needs setup" (its binary is vendored; the check only probes PATH).
3. The three aren't siblings (auto / false-setup / real-install).
4. Discovery is weak — a Claude user may never learn DorkOS speaks Codex/OpenCode.
5. "Run this with Codex instead" is impossible.

### 5.2 The ToS constraint is Anthropic-specific (this widens the design space)

Per the auth research, the hard "don't reimplement OAuth" constraint is scoped to **Anthropic's subscription-token crackdown**, not a general rule:

- **OpenCode — fully unconstrained.** MIT, self-hosted, no subscription model. Auth is the user's own provider keys or a local model. Ollama needs **no account at all**. → richest possible native in-app connect (paste keys, auto-detect Ollama, device-code), zero ToS worry.
- **Codex — real headroom.** No documented OpenAI equivalent to the Anthropic crackdown; the API-key path is explicitly sanctioned. → a native "paste your OpenAI key" connect is clean. Reimplementing OpenAI's _ChatGPT-subscription_ OAuth is the only part to verify against OpenAI's terms before building; delegating to `codex login` is the safe fallback and is still terminal-free (spawn it from a button, detect completion).
- **Claude — conservative posture only.** Delegate to `claude login` / read host credentials / API key. Never a reimplemented claude.ai OAuth.

**Design consequence (a useful inversion):** the two _new_ runtimes — the whole point of this work — are the _less_ constrained ones, so their connect experience can be the most polished and fully in-product, while Claude (the incumbent) stays on the delegate path.

### 5.3 The one irreducible step, and how to make it beautiful

An account cannot be bundled. So the endpoint is always "click Connect, approve once" — or, for a local Ollama model, **nothing at all**. That makes the Ollama path the frictionless hero (private, free, zero-auth) and the natural showcase for the open-source-model thesis.

### 5.4 Provisioning options (per runtime)

| Runtime  | Binary today                          | Path to zero-install                                         | Auth (the irreducible step)                                    |
| -------- | ------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| Claude   | vendored by SDK (works)               | already resolved                                             | delegate to `claude login` / host creds / API key              |
| Codex    | **vendored by SDK** (present, unused) | resolve the vendored path (mirror `resolveClaudeCliPath`)    | native API-key entry (clean) or delegate to `codex login`      |
| OpenCode | not vendored                          | add `opencode-ai` (opt-in/lazy) → one-click platform install | native: paste provider keys, or **detect local Ollama → none** |

### 5.5 OpenCode is a provider picker (this is where "how do I use it" lives)

OpenCode's superpower is that it is provider-agnostic — its "connect" is really "choose where the model comes from." Present it as a small menu with two easy paths featured:

- **Local (Ollama) — no account, private, free.** The hero path. Ladder of ambition:
  - _Baseline (must-have):_ detect a running Ollama + any pulled models → OpenCode connects with **zero auth**.
  - _Guided (stretch):_ if Ollama is present but no coding model is pulled, offer a curated, **hardware-aware** one-click pull (e.g. `qwen2.5-coder`) with honest sizing ("~18 GB; runs well / may be slow on your hardware") and download progress.
  - _Boundary:_ detect + link to install Ollama (at most a one-click installer download); do **not** own/manage the Ollama process or its full model library — that is Ollama's job.
  - _Honesty (Rams):_ local-model quality is model- and hardware-dependent; tool-calling below ~14B is unreliable (DOR-180 research). Never sell a 7B as Claude-equivalent.
- **Gateway (OpenRouter) — one key, every model, pay-as-you-go.** The breadth path. One credential unlocks hundreds of models across providers (including ones with no first-class DorkOS runtime). _Easiest:_ "Paste your OpenRouter key" (+ a get-a-key link) → the model dropdown populates from OpenRouter's catalog. _Slickest:_ OpenRouter supports **OAuth-PKCE key provisioning** — a "Connect OpenRouter" button that OAuths and auto-creates a scoped key, no copy-paste. This is ToS-clean (OpenRouter is built for exactly this), so it is the one place a fully-native in-app OAuth is unambiguously right.
- **Direct provider (OpenAI / Anthropic / …) — your existing key.** Paste a provider key (+ optional `baseURL`). A gateway/baseURL override is the same shape (auth research).

### 5.6 Communicating the local-model benefit — honestly

OpenCode + a local model is the one combination with two benefits nothing else offers: **privacy** (your code and prompts never leave your machine) and **no per-token cost** (you already own the hardware). Both are strong and both are on-brand for DorkOS's local-first, operator ethos. Surface them at the moment of choice, without overselling:

- A short benefit line on the Local path: _"Private and free — runs on your machine; your code never leaves it; no per-token bills."_
- **Per-model nature badges** in the picker so the tradeoff is legible where the user decides: 🔒 **local · private · free** vs **$ cloud · per-token**, plus an honest capability signal. Honest-by-design: it makes the real tradeoff (privacy/cost vs frontier capability) visible instead of hidden.
- The counterweight, stated plainly: frontier-model quality still comes from Claude/Codex (or a top cloud model via OpenRouter). Local is "private, free, good on capable hardware," not "better."

### 5.7 Recommendation

Proceed in three tiers (below). Tier 0 is small, fixes a real bug, and makes the three feel like siblings (most of the perceived-quality win). Tier 1 is the flagship — it makes a Jobs demo possible ("watch, I'll switch to a model running on this laptop: no account, no setup"). Tier 2 turns "we support three runtimes" from a config fact into a reason to use DorkOS.

## 6) Decisions

Resolved during ideation; open questions for SPECIFY are in §7 of the eventual spec.

| #   | Decision                  | Choice                                                                                                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scope model               | Three tiers: **T0** truth+consistency · **T1** kill-the-terminal · **T2** discovery+delight                                                                                                                                                                                                                                                   | T0 alone lifts perceived quality a lot and fixes a bug; T1 is the flagship; T2 differentiates.                                                           |
| 2   | Codex binary              | Resolve the **SDK-vendored** binary (mirror `resolveClaudeCliPath`); stop reporting false "needs setup"                                                                                                                                                                                                                                       | The binary is already present; the PATH-only probe is the bug.                                                                                           |
| 3   | OpenCode provisioning     | Add `opencode-ai` as an **opt-in / on-demand** install (not bundle-by-default)                                                                                                                                                                                                                                                                | Keeps the base install lean (local-first Non-Goal) while making setup one click. Version-matches the SDK (a plus).                                       |
| 4   | Setup surface framing     | Two-state **Ready / Connect**; move binary/CLI/sidecar vocabulary behind an **Advanced** disclosure                                                                                                                                                                                                                                           | Apple Test: describe what happens for the user, not the system. Keep internals for the Priya persona.                                                    |
| 5   | Connect flow per provider | **In-app for all three, but "in-app" ≠ "we own the OAuth."** Claude → delegate to `claude login` (button-triggered, terminal-free). Codex → native API-key entry; "Sign in with ChatGPT" delegates to `codex login` for the subscription. Do **not** reimplement a provider's _subscription_ OAuth (Anthropic-banned; unverified for OpenAI). | Triggering the vendor's own login from a button is already terminal-free; reserve native OAuth for services that invite it (OpenRouter, plain API keys). |
| 6   | OpenCode connect model    | A **provider picker**: Local (Ollama) · Gateway (OpenRouter) · Direct key. Local = detect → zero-auth connect, with a **guided, hardware-aware model pull** as a stretch; do not manage Ollama itself.                                                                                                                                        | OpenCode is provider-agnostic; its connect should present that. Local is the zero-auth hero; guided pull is delightful but must be hardware-honest.      |
| 7   | Switching model           | "Switch" = new session (ADR-0255 immutable). Add **"Run this with…"** = re-run the prompt on another runtime                                                                                                                                                                                                                                  | Respects the data model; satisfies the compare-instinct without history transplant.                                                                      |
| 8   | Identity                  | Show **runtime + model** ("OpenCode · qwen2.5-coder"), not runtime alone                                                                                                                                                                                                                                                                      | The user cares which brain is working; surfaces the local-model superpower.                                                                              |
| 9   | Credential architecture   | Build on the research's proposed **`CredentialProvider` port** + `providers` config block; `keychain:`/`env:`/`file:` reference scheme                                                                                                                                                                                                        | Reuses a scoped design; keeps plaintext out of human-edited config.                                                                                      |
| 10  | OpenRouter path           | First-class **OpenRouter** for OpenCode: paste-key (easiest) or **OAuth-PKCE key provisioning** (slickest, ToS-clean). One key → the whole model catalog.                                                                                                                                                                                     | One credential unlocks everything, pay-as-you-go; OpenRouter is built for app integration, so a native OAuth is safe here.                               |
| 11  | Benefit messaging         | Surface **privacy + no-cost** on the Local path: a short benefit line + **per-model nature badges** (🔒 local/free vs $ cloud). Stay honest about capability/hardware.                                                                                                                                                                        | The two benefits nothing else offers; honest-by-design badging makes the tradeoff legible at the moment of choice.                                       |

## 7) Open Questions (carried to SPECIFY)

- **Codex subscription sign-in:** delegate to `codex login` (safe, terminal-free) vs a fully-native OAuth. Default to delegate + native API-key; build native OAuth only after verifying OpenAI's terms on third-party subscription OAuth (same _shape_ of risk Anthropic banned, just undocumented for OpenAI).
- **Local-model install depth:** detect-only vs guided hardware-aware pull vs offering the Ollama installer — and how to estimate "will this model run well on your machine" (VRAM/RAM heuristic vs a quick benchmark).
- **First shippable slice:** T0-only (truth + consistency, ships fast, fixes the Codex bug) vs T0+T1 (adds the terminal-free connect + Ollama/OpenRouter paths — the flagship).

**Recommended next step:** SPECIFY (`/flow:specify`). The tiers, the ToS posture, and the provisioning paths are resolved; the spec should freeze the connect-flow contract per provider, the `CredentialProvider` port + config schema, the Ready/Connect state model, the "Run this with…" UX, and decide T0-only vs T0+T1 (vs full) as the first shippable slice. Draft ADRs to seed: `CredentialProvider` port; SDK-vendored-binary resolution; opt-in runtime provisioning; connect-flow-per-provider (delegate vs native).
