---
slug: runtime-neutral-context-channel
number: 258
created: 2026-06-16
status: specified
linearIssue: DOR-111
governing-adr: 0273
---

# Runtime-Neutral Additional-Context Channel — Specification

## Overview

DorkOS delivers per-message _additional context_ — git status, UI state, environment, the queued-message note, relay context — to the agent runtime by **mutating the user's message body** (Claude adapter prepends `<git_status>`/`<ui_state>` to `content`; the client prepends an English `[Note: …]` line to queued messages). This is runtime-specific, leaks into the transcript (the queue-note renders as if the user typed it), forces a brittle strip pass, double-injects git status (the `claude_code` preset derives it natively too), and does not generalize to Codex/OpenCode.

This spec replaces that with a **runtime-neutral context channel**: the user's `content` stays pristine; context flows as **structured data** down the existing layers; the server assembles **one canonical context bag** per turn; each runtime adapter materializes it through a uniform, cache-correct **tagged prepend + render-strip**; and the strip is driven by a single source-of-truth tag map so it can never drift. Git de-duplication uses `excludeDynamicSections: true` (suppress the preset's native git) so DorkOS's block is the single source of truth.

This realizes **[ADR-0273](../../decisions/0273-runtime-neutral-context-injection.md)** (as amended 2026-06-16). The architectural decisions are settled there; this document specifies the contract and the implementation.

## Goals

- The user's literal `content` is never mutated by the client or server.
- Injected context never renders as user-authored text (adapter-owned strip, tag-map-driven).
- Per-message context is carried as **neutral structured data**, not pre-formatted prose; the server owns _what_ context exists, the adapter owns _how_ it is rendered.
- Git status is injected **once** per turn, server-derived, in one canonical format across all runtimes.
- The design generalizes to future runtimes (Codex/OpenCode) with no Claude-specific assumptions above the adapter boundary.
- The queued-message note becomes a structured signal that informs the model but renders pristine.

## Non-Goals

- Adopting the `UserPromptSubmit` hook (deferred per ADR-0273 — accumulation #40216, `hook_result` JSONL, cache).
- Building the server-owned message queue (**DOR-106**) — this spec only defines the channel the queue-note rides; the queue-note's server-side _origin_ completes under DOR-106.
- Universal command intents (**DOR-109**) — a sibling track under the same ADR principle.
- Building a real Codex/OpenCode adapter — none exists yet; this spec makes them _correct by construction_ when they land.

## Background — current mechanism (see ideation §3)

| Layer          | Today                                                                                                                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client→Server  | `postMessage(sessionId, content, cwd?, { clientMessageId?, uiState? })`; queue-note is English prose prepended into `content` (`use-message-queue.ts:106`).                                                                                                                            |
| Server→Runtime | `MessageOpts { cwd?, uiState? }`; `trigger-turn.ts:192` calls `sendMessage(sessionId, content, { cwd, uiState })`.                                                                                                                                                                     |
| Claude adapter | `buildPerMessageContext` → `<git_status>`+`<ui_state>` prepended to `content` (`message-sender.ts:248`); env via `systemPrompt.append`; preset `claude_code` **without** `excludeDynamicSections` (→ double git); DOR-107 command-skip guard at `message-sender.ts:225`; **no hooks**. |
| Render strip   | `stripSystemTags` removes `<system-reminder>`/`<git_status>`/`<ui_state>`; queue-note is **not** stripped.                                                                                                                                                                             |
| Capabilities   | `RuntimeCapabilities` — `supports*` + `permissionModes` + `features`; no `nativeContext`/`contextDelivery`. Runtimes: `claude-code`, `test-mode` only (no Codex).                                                                                                                      |

## Technical Design

### Data model (`packages/shared`)

A new module `packages/shared/src/additional-context.ts` (exported via a `@dorkos/shared/additional-context` subpath) defines the neutral context model. **Entries carry structured `data`, never pre-formatted text.**

```ts
/** Kinds of additional context DorkOS can attach to a turn. */
export type ContextKind = 'git_status' | 'ui_state' | 'queue_note' | 'env' | 'relay_context';

/** Lifetime of an entry — informs adapter placement, not yet load-bearing. */
export type ContextScope = 'per-turn' | 'per-session';

/** Discriminated union — the canonical server-assembled entries. */
export type AdditionalContextEntry =
  | { kind: 'git_status'; scope: 'per-turn'; data: GitStatusData }
  | { kind: 'ui_state'; scope: 'per-turn'; data: UiState }
  | { kind: 'queue_note'; scope: 'per-turn'; data: { composedDuringPrevTurn: true } }
  | { kind: 'env'; scope: 'per-session'; data: EnvData }
  | { kind: 'relay_context'; scope: 'per-turn'; data: RelayContextData };

export type AdditionalContext = AdditionalContextEntry[];

/**
 * Client-sourced signals. The client contributes only what it knows; the
 * SERVER derives git_status/env and normalizes everything into entries.
 * Signals + data only — NEVER pre-formatted prose.
 */
export interface ClientContext {
  uiState?: UiState;
  /** True when composed while the agent was responding to the previous turn. */
  queued?: boolean;
  // room for: editorSelection, openFile, …
}
```

**Single source of truth for tag names** (eliminates the "strip must stay in sync" fragility ADR-0273 called out): both the formatter and the stripper read the same map.

```ts
/** XML wrapper per kind — used by BOTH the adapter formatter and the strip. */
export const CONTEXT_TAG: Record<ContextKind, string> = {
  git_status: 'git_status',
  ui_state: 'ui_state',
  queue_note: 'queue_note',
  env: 'env',
  relay_context: 'relay_context',
};
```

Zod schemas (`ClientContextSchema`, and validators for each entry) live alongside, mirroring the `UiStateSchema` pattern, and are wired into `SendMessageRequestSchema`.

### Layer 1 — Client → Server

- `Transport.postMessage` options bag gains `context?: ClientContext` (alongside existing `clientMessageId?`, `uiState?`). **Migration:** fold `uiState` into `context.uiState` and remove the standalone `uiState?` option (no legacy parallel field — repo standard).
- `use-message-queue.ts:106` stops prepending the English `[Note: …]` string. Instead it sets `context.queued = true` and flushes the **pristine** `item.content`. The note becomes a structured signal.
- `SendMessageRequestSchema` (`schemas.ts`) gains `context: ClientContextSchema.optional()` and drops the standalone `uiState` field.
- Both `HttpTransport` and `DirectTransport` carry `context` identically.

### Layer 2 — Server → Runtime

- A new runtime-neutral **context assembler** (`apps/server/src/services/session/context-assembler.ts`) merges `ClientContext` (ui_state, queue signal) with **server-derived** context (git_status, env) into an `AdditionalContext` bag. Git derivation **moves here** from the Claude adapter's `context-builder.ts`, so every runtime gets identical git data (`getGitStatus` becomes a neutral server service).
- The assembler consults `runtime.getCapabilities().nativeContext` and **omits** any kind the target runtime injects itself (no-op today; the mechanism for future runtimes).
- `MessageOpts` (`agent-runtime.ts`) gains `additionalContext?: AdditionalContext` and **drops** `uiState?` (now an entry). Contract documented on the interface: _delivered out-of-band relative to `content`; must not mutate `content`; must never render as user-authored text._
- `trigger-turn.ts` / `embedded-turn-trigger.ts` thread `context` → assembler → `sendMessage(sessionId, content, { cwd, additionalContext })`.

### Layer 3 — Claude adapter (structured prepend + strip)

- `message-sender.ts` consumes `messageOpts.additionalContext`. A new `renderContextEntry(entry)` in `context-builder.ts` formats each entry into a tagged block using `CONTEXT_TAG[entry.kind]` (e.g. `<git_status>…</git_status>`, `<queue_note>composed while the agent was responding to the previous message</queue_note>`).
- Blocks are joined and prepended to the prompt, **respecting the existing DOR-107 command-skip guard**: on `isCommandDispatch` turns, no prepend (a `/`-prefixed prompt must reach the CLI bare). The guard is retained and is the one accepted tradeoff of the prepend mechanism.
- `sdkOptions.systemPrompt` gains `excludeDynamicSections: true` so the preset stops injecting native git/cwd/memory; DorkOS's git block (now from the assembler) is the only one.
- The old `buildPerMessageContext` path is removed; env continues via `systemPrompt.append` unless it duplicates a now-forwarded `env` entry (see Verification Gate G2).

### Render strip

- `transcript-parser.stripSystemTags` is rewritten to strip **every** `CONTEXT_TAG` value (so `<queue_note>` and any future kind are covered automatically) plus the existing `<system-reminder>`. A test asserts no `CONTEXT_TAG` block ever survives into a rendered user message.
- `stripRelayContext` is reconciled with the `relay_context` kind (single mechanism).

### Layer 4 — Capabilities

- `RuntimeCapabilities` gains `nativeContext: ContextKind[]` — kinds the runtime injects itself and the server must therefore omit.
- `CLAUDE_CODE_CAPABILITIES.nativeContext = []` (native git suppressed via `excludeDynamicSections`). `TEST_MODE_CAPABILITIES.nativeContext = []`.
- `contextDelivery` is **deferred** (not added) — only one materialization strategy exists today (prepend); introduce the field when/if the hook path is adopted.

## Implementation Phases

1. **Phase 1 — git de-dup (DOR-132, independently shippable):** add `excludeDynamicSections: true` to the Claude `sdkOptions.systemPrompt`. Verify git status appears once. No interface changes. Ships ahead of the rest.
2. **Phase 2 — shared model:** `additional-context.ts` (types, `CONTEXT_TAG`, Zod schemas); wire `ClientContextSchema` into `SendMessageRequestSchema`. Build `@dorkos/shared`.
3. **Phase 3 — server assembler + neutral interface:** create `context-assembler.ts`; move `getGitStatus` derivation to a neutral service; add `MessageOpts.additionalContext`, drop `MessageOpts.uiState`; consult `nativeContext`; thread through `trigger-turn`/`embedded-turn-trigger`; add `RuntimeCapabilities.nativeContext` + producers.
4. **Phase 4 — client:** add `context?` to `postMessage` (both transports); replace the `use-message-queue.ts` prose with `context.queued = true`; fold `uiState` into `context`.
5. **Phase 5 — Claude adapter:** consume the bag via `renderContextEntry` + `CONTEXT_TAG`; respect the command guard; remove `buildPerMessageContext`; rewrite `stripSystemTags` to be tag-map-driven.
6. **Phase 6 — tests:** unit (assembler merge, `nativeContext` omission, formatter/strip round-trip), integration (SSE turn carries pristine content; transcript renders no tags), and a render-leak guard test for every `CONTEXT_TAG`.

## Acceptance Criteria

- AC1 — Sending a message never mutates `content`: the JSONL user record's text (post-strip) equals the bytes the user typed, for plain, queued, and command messages.
- AC2 — Queued messages: the model receives a `<queue_note>` block; the rendered transcript shows the pristine user text with **no** `[Note: …]` prose.
- AC3 — Git status is injected exactly once per turn (no preset + body duplicate), server-derived, identical format regardless of runtime.
- AC4 — Slash commands still dispatch (`/compact`, `/context`) — the command-skip guard holds; context is not prepended on command turns.
- AC5 — `stripSystemTags` strips every `CONTEXT_TAG` value; a test proves no injected tag renders as user content; adding a new `ContextKind` requires no separate strip edit.
- AC6 — `MessageOpts.uiState` is gone; `additionalContext` carries ui_state; `test-mode` and `claude-code` both compile against the new interface.
- AC7 — `RuntimeCapabilities.nativeContext` exists and is honored by the assembler (omission is exercised by a `test-mode` capability with a non-empty `nativeContext` in a unit test).
- AC8 — No regression in prompt-cache hit rate on a multi-turn session (compare before/after; see Verification Gate G3).

## Testing Strategy

- **Unit:** assembler merge + `nativeContext` omission; `renderContextEntry`↔`stripSystemTags` round-trip for each kind; schema validation; queue signal → `queue_note` entry.
- **Integration (supertest + `collectSseEvents`):** a turn with ui_state + queue signal yields pristine `content` to the runtime and a clean rendered transcript; command dispatch unaffected.
- **Render-leak guard:** parametrized over `CONTEXT_TAG` — assert each tag is stripped from rendered user messages.
- Use `FakeAgentRuntime`/`testScenarios` per `.claude/rules/testing.md`; rebuild `@dorkos/shared` before client vitest (stale-dist false-red).

## Risks & Verification Gates (resolve during implementation)

- **G1 — `excludeDynamicSections` re-injection under per-resume:** confirm whether the SDK re-injects stripped sections into every resumed turn's first message (potential session-start stale git beside our fresh block) or only at true session start. Decide tolerate-vs-compensate.
- **G2 — env duplication:** confirm whether `excludeDynamicSections` suppresses the preset `<env>` block or only cwd/memory/git. If env survives, reconcile with DorkOS's `buildEnvBlock`/`env` entry so env isn't doubled.
- **G3 — cache validation:** empirically confirm the change preserves cache hits (token-burn is cache RE-creation churn, not duplicate sends); measure hit-rate on a multi-turn session before/after.
- **G4 — future hook option:** revisit `contextDelivery: 'native'` only if #40216 (accumulation) is fixed _and_ the parser learns to hide `hook_result`.

## Out of Scope / Deferred Work

- **DOR-106** — server-owned queue; relocates the queue-note's _origin_ server-side (the interim client `queued` signal is a strict improvement until then).
- **DOR-109** — universal command intents (sibling; shares the ADR-0273 boundary principle, not this contract).
- **Codex/OpenCode adapters** — build against this neutral interface when they land (declare empty/minimal `nativeContext`, prepend the canonical bag).
- **The `UserPromptSubmit` hook path** — deferred with explicit gates (G4).

## References

- [ADR-0273](../../decisions/0273-runtime-neutral-context-injection.md) — governing decision (amended 2026-06-16).
- [`01-ideation.md`](./01-ideation.md) — research (SDK 0.3.177 findings), the two user-resolved decisions, full codebase map.
- Linear: **DOR-111** (seed), **DOR-132** (Phase 1), **DOR-106** (queue origin), **DOR-109** (command sibling); context: DOR-107, DOR-82.
- `research/20260218_agent-sdk-context-injection.md`.
