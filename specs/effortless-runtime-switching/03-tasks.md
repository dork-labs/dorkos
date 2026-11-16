# Effortless Runtime Switching — Task Breakdown

**Spec:** `specs/effortless-runtime-switching/02-specification.md` · **Slug:** `effortless-runtime-switching` · **Tracker:** DOR-183
**Mode:** full (T0 + T1 + T2) · **Generated:** 2026-07-03

This is the human-readable view of `03-tasks.json` (the canonical, machine-readable source). Each phase is an independently-shippable slice (its own PR). The tiers are cumulative: T1 connect UIs build on the T0 Ready/Connect surface; the T2 Runtimes surface composes the T1 connect flows.

Grounding note: `AgentRuntime.checkDependencies()` is already `Promise`-typed and the requirements route already `await`s it, so the "async probes" work (1.2) is converting the internal `execFileSync` to non-blocking, not a signature change. Codex's binary is already vendored (its `codexPathOverride` self-resolves it); the T0 bug is purely that `resolveCodexBinaryPath` only probes PATH. `ExtensionSecretStore` (`@dorkos/shared/extension-secrets`) is the write-only, never-echo secret pattern reused by the `CredentialProvider`.

---

## Phase 1 — T0: Truth + Consistency (6 tasks)

Resolve Codex's vendored binary (kills the false "needs setup"), make probes non-blocking, reframe the surface to two-state Ready/Connect with an Advanced disclosure, and add opt-in OpenCode provisioning — so the three runtimes present as siblings.

| ID  | Title                                                                         | Size   | Deps     | Parallel |
| --- | ----------------------------------------------------------------------------- | ------ | -------- | -------- |
| 1.1 | Factor a shared binary resolver + resolve Codex's SDK-vendored binary         | medium | —        | 1.4      |
| 1.2 | Make dependency probes async and time-bounded (absorb DOR-180 follow-up)      | medium | 1.1      | 1.4      |
| 1.3 | Project per-runtime Ready/Connect state in the requirements API               | medium | 1.1, 1.2 | 1.5      |
| 1.4 | Reframe the client setup surface to Ready/Connect with an Advanced disclosure | large  | 1.3      | —        |
| 1.5 | Add opt-in, on-demand OpenCode provisioning (server action + endpoint)        | large  | 1.1      | 1.3, 1.4 |
| 1.6 | Wire the OpenCode Connect CTA to provisioning with inline progress            | medium | 1.4, 1.5 | —        |

**Key files:** `apps/server/src/services/runtimes/codex/check-dependencies.ts`, `apps/server/src/services/runtimes/claude-code/sdk/sdk-utils.ts` (`resolveBundledClaudeBinary`/`resolveClaudeCliPath` — the pattern to mirror), new `apps/server/src/services/runtimes/shared/resolve-binary.ts`, `apps/server/src/services/runtimes/opencode/{check-dependencies,server-manager}.ts`, new `.../opencode/provision.ts`, `apps/server/src/routes/system.ts`, `packages/shared/src/agent-runtime.ts` (`SystemRequirements`), `apps/client/src/layers/entities/runtime/ui/{RuntimeSetupDialog,DependencyInstallHint}.tsx`, `.../model/use-runtime-requirements.ts`, `apps/client/src/layers/features/status/ui/RuntimeItem.tsx`.

**ADRs:** 0316 (SDK-vendored resolution), 0317 (opt-in provisioning).

---

## Phase 2 — T1: Kill the Terminal (8 tasks)

Introduce the `CredentialProvider` port + `providers` config + migration, the server connect surface (store reference / delegate vendor login), and the per-provider connect UIs including the OpenCode provider picker (Ollama zero-auth hero, OpenRouter paste-key + OAuth-PKCE, Direct key).

| ID  | Title                                                                 | Size   | Deps               | Parallel      |
| --- | --------------------------------------------------------------------- | ------ | ------------------ | ------------- |
| 2.1 | CredentialProvider port + `providers` config block + semver migration | large  | —                  | 2.6, 2.7      |
| 2.2 | Resolve credential references at each runtime's env-injection seam    | medium | 2.1                | —             |
| 2.3 | Connect endpoints: store credential reference + delegate vendor login | large  | 2.1                | 2.6, 2.7      |
| 2.4 | Codex Connect UI: native API key + delegate `codex login`             | medium | 2.3, 1.4           | 2.5           |
| 2.5 | Claude Connect UI: delegate `claude login` + paste key                | small  | 2.3, 1.4           | 2.4           |
| 2.6 | OpenRouter connect: paste-key, OAuth-PKCE, model catalog (server)     | large  | 2.1                | 2.3, 2.7      |
| 2.7 | Zero-auth Ollama detection (server)                                   | small  | —                  | 2.1, 2.3, 2.6 |
| 2.8 | OpenCode provider picker UI (Local / Gateway / Direct)                | large  | 2.6, 2.7, 2.3, 1.4 | —             |

**Key files:** `packages/shared/src/config-schema.ts` (`providers` block + `runtimes.{codex,opencode}` refs), `apps/server/src/services/core/config-manager.ts` (`CONFIG_MIGRATIONS` — append `backfillProvidersDefaults` after `0.47.0`), new `apps/server/src/services/core/credential-provider.ts`, `packages/shared/src/extension-secrets.ts` (reuse pattern), env seams: `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts` (`sdkOptions.env`), `.../opencode/server-manager.ts` (spawn env), `.../codex/codex-runtime.ts` (never sets `CodexOptions.env`), new `apps/server/src/routes/runtimes.ts` (mounted in `apps/server/src/app.ts`), new `.../opencode/ollama.ts`, `apps/server/src/routes/extensions.ts` (write-only secret pattern), new client `apps/client/src/layers/features/runtime-connect/`.

**ADRs:** 0315 (CredentialProvider + `providers`), 0318 (connect-flow-per-provider). **Skill:** `adding-config-fields`.

---

## Phase 3 — T2: Discovery + Delight (6 tasks)

Identity = runtime + model, "Run this with…" (re-run into a fresh session, never a transplant), per-model nature badges, the dedicated Runtimes surface, and the guided hardware-aware Ollama pull.

| ID  | Title                                                      | Size   | Deps               | Parallel |
| --- | ---------------------------------------------------------- | ------ | ------------------ | -------- |
| 3.1 | Show identity as runtime + model everywhere                | medium | —                  | 3.2      |
| 3.2 | "Run this with…" re-run into a fresh session (ADR-0255)    | medium | 3.1                | —        |
| 3.3 | Per-model nature badges (privacy/cost + honest capability) | medium | 3.1, 2.8           | 3.2      |
| 3.4 | Dedicated Runtimes surface (widget + route)                | large  | 2.4, 2.5, 2.8, 3.3 | —        |
| 3.5 | Guided Ollama pull endpoint + hardware heuristic (server)  | medium | 2.7                | 3.4      |
| 3.6 | Guided Ollama pull UI in the provider picker (client)      | medium | 3.5, 2.8           | 3.4      |

**Key files:** `apps/client/src/layers/entities/runtime/ui/RuntimeMark.tsx`, `apps/client/src/layers/features/chat/model/status/use-runtime-chip.ts`, `apps/client/src/layers/features/chat/model/use-session-submit.ts`, `apps/client/src/router.tsx` (`/session` `search.runtime`; new `/runtimes` route mirroring `/marketplace`), `apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx`, new `apps/client/src/layers/entities/runtime/ui/ModelNatureBadge.tsx`, new `apps/client/src/layers/widgets/runtimes/`, `apps/server/src/services/runtimes/opencode/{ollama,models}.ts` (`projectModelOptions` -> `provider/model`).

**ADR:** 0255 (immutable per-session binding constrains "switch = new session").

---

## Critical path

```
1.1 → 1.2 → 1.3 → 1.4 ─┬─→ 2.4 ─┐
                        └─→ 2.5 ─┤
2.1 → 2.3 ──────────────────────┼─→ 2.8 → 3.3 → 3.4
2.1 → 2.6 ──────────────────────┘         (3.1 feeds 3.3)
2.7 → 3.5 → 3.6
```

Longest chain: **1.1 → 1.2 → 1.3 → 1.4 → 2.4/2.5 → 2.8 → 3.3 → 3.4** (T0 spine → connect surface → provider picker → badges → Runtimes surface). `2.1` (CredentialProvider) is the T1 root and gates 2.2/2.3/2.6; it is on a parallel strand to the T0 client spine and should start as soon as T1 opens.

## Parallelizable work

- **Within T0:** the server binary/probe/provisioning strand (1.1 → 1.2, and 1.5) runs concurrently with the client Ready/Connect UI (1.4, once 1.3 lands the projection). 1.3 ∥ 1.5.
- **Within T1:** 2.1 ∥ 2.6 ∥ 2.7 (Ollama detect has no deps). After 2.3, the Codex (2.4) and Claude (2.5) connect UIs are independent. 2.6 (OpenRouter server) ∥ 2.3 ∥ 2.7.
- **Within T2:** 3.1 ∥ 3.2; the guided-pull strand (3.5 → 3.6) ∥ the Runtimes surface (3.4).

## Assumptions & reversible defaults (flagged for review)

1. **Binary-resolution precedence (1.1).** ADR-0316 says "vendored → configured → PATH", but today a configured `runtimes.codex.binaryPath` is authoritative. Defaulted to the ADR order (vendored first); flip to "configured → vendored → PATH" if an explicit override should win. Either way, a configured-but-absent path still surfaces as a resolution miss (preserves existing honesty).
2. **OpenCode install location + package manager (1.5).** Defaulted to a dork-home-scoped `npm install --prefix {dorkHome}/runtimes/opencode/` to stay package-manager-agnostic on the user's machine and keep the base install lean. A `pnpm add` into a scoped dir is the alternative.
3. **Codex credential injection (2.2).** Codex's runtime deliberately never sets `CodexOptions.env` (would drop PATH/HOME/CODEX_HOME). Defaulted to routing Codex auth through the delegated `codex login` (writes to the child's `CODEX_HOME`) rather than an injected env var; API-key injection is applied only at the safe Claude/OpenCode env seams.
4. **New route module (2.3).** Defaulted to a new `apps/server/src/routes/runtimes.ts` mounted at `/api/runtimes` rather than overloading `routes/system.ts`; the provisioning endpoint (1.5) may live under either — chose `/api/system/...` for provisioning and `/api/runtimes/...` for connect. Consolidate if review prefers one namespace.
5. **OpenRouter OAuth-PKCE contract (2.6).** The exact scope/callback contract must be confirmed against OpenRouter's current app-integration docs before finalizing (spec Open Question); the paste-key path is the always-available fallback.
6. **Ollama guided-pull heuristic (3.5).** Defaulted to a static VRAM/RAM-vs-model-size heuristic (spec Open Question resolved toward "lean static first") with honest sizing copy either way.
7. **Runtimes surface route (3.4).** Defaulted to `/runtimes` mirroring the `/marketplace` widget+route pattern; the exact path and nav placement are cosmetic and reversible.

## Testing posture (all tasks)

Vitest with `vi.mock()`; tests in `__tests__/`. Server route/service tests use `FakeAgentRuntime` and mock `child_process` / `fetch` (never spawn a real login, hit a real provider, or run `npm install` in CI). Client tests use RTL + jsdom with a mock `Transport` via `TransportProvider`. Every runtime-touching change keeps the shared `runtimeConformance` suite green. E2E (Playwright, real Chromium) covers the three connect flows to Ready, the Ollama zero-auth path, "Run this with…" opening a fresh bound session, and identity showing runtime + model. Each test carries a purpose comment and includes failure-revealing edge cases (hung probe, denied OAuth, install failure, withdrawn/dangling credential).
