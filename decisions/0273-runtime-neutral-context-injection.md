---
number: 0273
title: Runtime-Neutral Additional-Context Injection at the Runtime Boundary
status: accepted
created: 2026-06-16
spec: runtime-neutral-context-channel
superseded-by: null
---

# 0273. Runtime-Neutral Additional-Context Injection at the Runtime Boundary

## Status

Accepted — 2026-06-16. Ratified and realized by spec-258 (`specs/runtime-neutral-context-channel/`): the contract below is implemented and verified at the unit, integration, and live-browser levels. DOR-106 (server-owned queue) remains a follow-on that relocates the queued-note signal server-side; the interim client signal is already in place.

**Refined 2026-06-16 by spec-258 ideation** (`specs/runtime-neutral-context-channel/01-ideation.md`) on `@anthropic-ai/claude-agent-sdk@0.3.177` evidence: the principle below is unchanged, but two mechanisms were corrected — (a) Claude materialization is a **structured tagged prepend + adapter strip**, _not_ the `UserPromptSubmit` hook; (b) git de-dup adopts **A2** (`excludeDynamicSections` + forward DorkOS's canonical block), which **collapses** the de-dup matrix. See the Decision and Consequences below.

## Context

DorkOS injects per-message context — git status, UI state, and the queued-message note — by **mutating the user message body**. Two mechanisms do this today, both runtime-specific and both leaking into the transcript:

- The Claude adapter prepends a `<git_status>` (+`<ui_state>`) block to `content` (`message-sender.ts:248-253`), then the server's `transcript-parser.stripSystemTags` hides it on render.
- The client prepends an English `[Note: This message was composed while the agent was responding…]` line to queued messages (`use-message-queue.ts:106`); it is **not** on any strip list, so it renders verbatim as if the user typed it.

This is fragile and not runtime-agnostic. The body-prepend caused the slash-command dispatch bug (DOR-107) and forces a strip pass that must stay in sync with every injected wrapper. The `claude_code` preset _also_ derives git status natively and freshly on every resume, so git status is **injected twice per turn**. And with Codex/OpenCode runtimes anticipated (the `codex-runtime-adapter-prework` spec laid interface groundwork; no adapter exists yet), a Claude-specific injection path doesn't generalize.

The SDK's `UserPromptSubmit` hook (`hookSpecificOutput.additionalContext`) looked like the clean out-of-band channel. Spec-258 ideation evaluated it against the installed SDK (0.3.177 / claudeCode 2.1.177) and found it unsuitable as the primary mechanism: while the within-turn duplication bug (GitHub #14281) is fixed on the 2.1 line, the hook's `additionalContext` **accumulates** a `<system-reminder>` block every turn (#40216, closed _not-planned_), writes **`hook_result`** records into the session JSONL that DorkOS parses to render history, and is **worse for prompt cache** than placing per-turn context in the user message. A cache-correct, non-accumulating structured prepend is the better primary mechanism — and it is also the common denominator across Claude, Codex, and OpenCode (none of which has a richer per-turn out-of-band channel).

## Decision

Per-message context is a **runtime-neutral concern carried as structured data down the existing layers**, never baked into the user's `content`, and materialized by each runtime adapter through a uniform, cache-correct channel:

1. **Content stays pristine.** The user's literal message is never mutated by the client or server. `Transport.postMessage` already carries `uiState` as structured data on its `options` bag (the correct pattern); generalize that into a typed `context` structure (signals + data, never pre-formatted prose) shared by `HttpTransport` and `DirectTransport`. The queued-message note becomes a structured **signal**, not client-injected English prose.
2. **Neutral interface.** `AgentRuntime.sendMessage`'s `MessageOpts` (today's `uiState?`) generalizes to a neutral `additionalContext` bag of labeled entries — a discriminated union by `kind` carrying structured `data` (not pre-formatted text) plus a `scope` (`per-turn` | `per-session`). The **server merges** client-supplied context (UI state, the queued-message signal, editor selection) with server-derived context (git status, env) and hands the bag to the runtime. The interface contract: additional context is delivered **out-of-band relative to `content`, must not mutate `content`, and must never render as user-authored text**. The server owns _what_ context exists; the adapter owns _how_ it is rendered.
3. **Per-runtime materialization (structured prepend + strip).** Each adapter formats the bag's entries into tagged blocks, prepends them to the prompt it sends to its runtime, and strips those tags on render so injected context never appears as user text. This is the **primary mechanism for all runtimes** — it is cache-correct (per-turn context sits after the cache breakpoint), non-accumulating, and uniform; Codex and OpenCode have no richer per-turn channel and would prepend regardless. The Claude `UserPromptSubmit` hook is **deferred**, not adopted (see Context); it becomes a future `RuntimeCapabilities.contextDelivery: 'native'` option only once #40216 is fixed _and_ the transcript parser hides `hook_result` records.
4. **Native-context de-dup (A2).** The server owns neutral derivation and forwards **one canonical context bag uniformly to every adapter**. Git status is the proof case: rather than letting the `claude_code` preset inject it (the rejected option A1), the Claude adapter sets `excludeDynamicSections: true` to **suppress** the preset's native working-directory/auto-memory/git sections and forwards DorkOS's own git block — single source of truth, byte-identical across runtimes, and a fully static, cacheable system prompt. Because native injection is suppressed, **the de-dup matrix collapses** (nothing to skip). `RuntimeCapabilities.nativeContext` is retained as the general mechanism for any future runtime that injects context it cannot suppress; under A2 it is effectively empty for Claude. `contextDelivery` is deferred until a second materialization strategy (the hook) is actually adopted.
5. **Same rule for commands.** Universal command intents (compact / clear / context) translate at the same boundary — neutral intent down, per-runtime expansion in the adapter. This ADR is the shared principle for both context and commands; the command track is tracked under the Universal Command Interface project (DOR-109).

## Consequences

### Positive

- One runtime-agnostic context model; Codex/OpenCode adapters are correct by construction, implementing against a neutral interface rather than inheriting a Claude-specific path.
- The user's `content` is never mutated by the client or server, and the adapter strips its injected tags on render, so context can never appear as user-authored text — the queued-note leak is fixed at the source (a structured signal replaces the client's prose), not patched with another ad-hoc strip rule.
- The primary mechanism is uniform, **cache-correct, and non-accumulating** — no per-turn growth of `<system-reminder>` blocks and no `hook_result` JSONL records to filter.
- A2 removes the per-turn double-injection of git status and makes the `claude_code` system prompt fully static and cacheable; neutral derivation is a single server-side source of truth, byte-identical across runtimes.

### Negative

- The `UserPromptSubmit` hook is deferred, not adopted: #14281 (within-turn duplication) is fixed on 0.3.177, but #40216 (cross-turn accumulation) and `hook_result` JSONL persistence remain. The structured prepend is the primary path until those are resolved.
- `excludeDynamicSections: true` moves the preset's working-directory/memory/git out of the system prompt; the SDK re-injects the stripped sections into the first user message, so a session-start git snapshot may briefly coexist with DorkOS's fresh per-turn block (minor, stale-tolerant). The exact re-injection behavior under DorkOS's per-resume model is a verification gate before adoption.
- The **DOR-107 command-skip guard is retained**: a `/`-prefixed prompt must reach the CLI bare, so the adapter cannot prepend context on command-dispatch turns. Only the (deferred) hook path would have removed this guard. The guard is well-contained, since `content` is never otherwise mutated.
- Adds a `RuntimeCapabilities.nativeContext` declaration each adapter must keep honest (effectively empty for Claude under A2); `contextDelivery` is deliberately deferred (no second strategy yet).
- The queued-message note's full fix depends on the queue becoming server-owned (DOR-106) so the signal originates server-side rather than as a client-supplied signal; the interim client signal is a strict improvement in the meantime.
