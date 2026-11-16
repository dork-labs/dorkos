---
slug: runtime-neutral-context-channel
number: 258
created: 2026-06-16
status: ideation
linearIssue: DOR-111
---

# Runtime-Neutral Additional-Context Channel

**Slug:** runtime-neutral-context-channel
**Author:** Claude Code
**Date:** 2026-06-16
**Branch:** preflight/runtime-neutral-context-channel
**Governing decision:** [ADR-0273](../../decisions/0273-runtime-neutral-context-injection.md) (proposed) — see the **ADR amendment** in §9.

---

## 1) Intent & Assumptions

- **Task brief:** Design the runtime-neutral mechanism by which DorkOS delivers per-message _additional context_ (git status, UI state, env, the queued-message note, relay context) to **any** agent runtime — Claude Agent SDK today, Codex/OpenCode tomorrow — **without mutating the user's literal message** and **without that context ever rendering as user-authored text**. Ideation only; no implementation. Work _within_ ADR-0273's principle, refining the specific mechanism where new evidence warrants.

- **Assumptions:**
  - ADR-0273's **principle holds** and is not relitigated: content stays pristine; context is structured data carried down the existing layers; each runtime adapter materializes it; per-runtime differences live in `RuntimeCapabilities`.
  - The installed SDK is `@anthropic-ai/claude-agent-sdk@0.3.177` (claudeCode `2.1.177`). Findings are pinned to this version.
  - DorkOS spawns a fresh `query({ resume })` per message, so the `claude_code` preset's dynamic sections (cwd / auto-memory / git status) are **re-derived every turn**.
  - DorkOS renders chat history by parsing the SDK session JSONL (`transcript-parser.ts`); anything written to the JSONL is a render concern.
  - This is a design/architecture ideation, not a bug fix — §4 (Root Cause Analysis) is N/A.

- **Resolved by the user during ideation (Phase 3.5):**
  1. **Claude materialization = structured tagged prepend + adapter strip** (not the `UserPromptSubmit` hook). Amends ADR-0273 layer 3.
  2. **Git de-dup = A2** — `excludeDynamicSections: true` to suppress the preset's native git, and forward DorkOS's own canonical git block uniformly. Flips ADR-0273's A1.

- **Out of scope:**
  - Implementation (that's `/spec:execute`).
  - The server-owned message queue itself (**DOR-106**) — this spec only defines the channel the queued-note rides on.
  - Universal command intents (**DOR-109**) — a _sibling_ track sharing ADR-0273's boundary principle, not this context contract.
  - A real Codex/OpenCode adapter (none exists yet — see §3); the design must _accommodate_ them, but building them is separate.

---

## 2) Pre-reading Log

- `decisions/0273-runtime-neutral-context-injection.md` — governing principle: pristine content, neutral bag, server-merge, per-runtime materialization, capability-driven de-dup. Layer-3 mechanism (hook) and A1 de-dup are revisited here on new evidence.
- `research/20260218_agent-sdk-context-injection.md` — prior research on the four SDK context mechanisms; **recommended `systemPrompt.append` / prepend over hooks precisely because of #14281.** Corroborates this spec's direction.
- `packages/shared/src/transport.ts:253` — `postMessage(sessionId, content, cwd?, options?: { clientMessageId?; uiState? })`. `cwd` is positional; the options bag is the generalization point.
- `packages/shared/src/agent-runtime.ts:117,175` — `RuntimeCapabilities` (no `contextDelivery`/`nativeContext` today; has a `features: Record<string, unknown>` escape hatch) and `MessageOpts` (`cwd?`, `uiState?`).
- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts:225,248,255,404` — command-skip guard (DOR-107), `enrichedContent` body-prepend, `sdkOptions` (preset `claude_code`, **no `excludeDynamicSections`**, **no `hooks`**), `query()`.
- `apps/server/src/services/runtimes/claude-code/messaging/context-builder.ts:179,349,388,436` — `buildUiToolsBlock`, `buildSystemPromptAppend` (env goes here, into the system prompt), `buildPerMessageContext` (git + ui_state, body-prepended), `buildGitBlock`.
- `apps/server/src/services/runtimes/claude-code/sessions/transcript-parser.ts:142,158` — `stripSystemTags` (strips `<system-reminder>`/`<git_status>`/`<ui_state>`), `stripRelayContext`. The queue-note is **not** stripped.
- `apps/client/src/layers/features/chat/model/use-message-queue.ts:106` — client prepends the English `[Note: …]` queue annotation as prose into `content`.

---

## 3) Codebase Map — the mechanism today

### Layer 1 — Client → Server

`Transport.postMessage(sessionId, content, cwd?, options?: { clientMessageId?; uiState? })` (`transport.ts:253`). `uiState` is already carried as **structured data** on the options bag — the correct pattern to generalize. The **queue-note is the exception**: `use-message-queue.ts:106` prepends an English `[Note: This message was composed while the agent was responding…]` string directly into `content`, so it is prose, not a signal.

### Layer 2 — Server → Runtime

`SendMessageRequestSchema` (`schemas.ts:174`) validates `content`, `cwd`, `uiState`, etc. `POST /messages` → `triggerTurn` → `deps.sendMessage(sessionId, content, { cwd, uiState })` (`trigger-turn.ts:192`; mirrored in `embedded-turn-trigger.ts`). `MessageOpts` (`agent-runtime.ts:175`) is the neutral boundary and today carries `cwd?` + `uiState?`.

### Layer 3 — Claude adapter (`services/runtimes/claude-code/`)

- **Body-prepend:** `buildPerMessageContext(cwd, uiState)` emits `<git_status>` + `<ui_state>` blocks; `message-sender.ts:248` sets `enrichedContent = \`${perMessageContext}\n\n${content}\``.
- **Env split:** `<env>` is **not** per-message — it's part of `buildSystemPromptAppend` (`context-builder.ts:349`), appended to the `claude_code` preset's system prompt.
- **Command-skip guard (DOR-107):** `message-sender.ts:225` detects a known slash command and sets `isCommandDispatch`, which skips the prepend so `/compact` reaches the CLI bare.
- **Preset:** `systemPrompt: { type:'preset', preset:'claude_code', append }` with **no `excludeDynamicSections`** → the preset _also_ injects git/cwd/memory natively, fresh each resume ⇒ **git is injected twice per turn**.
- **No hooks** wired into `query()` (verified).

### Render strip

`stripSystemTags` (`transcript-parser.ts:142`) removes `<system-reminder>`/`<git_status>`/`<ui_state>`; `stripRelayContext` peels `<relay_context>`. The `[Note: …]` queue annotation is on **no** strip list, so it renders verbatim as if the user typed it — the leak that motivated this work.

### RuntimeCapabilities & runtimes

`RuntimeCapabilities` (`agent-runtime.ts:117`) is all `supports*` booleans + structured `permissionModes` + a `features` escape hatch. **No `contextDelivery`/`nativeContext` exist.** Producers: `CLAUDE_CODE_CAPABILITIES`, `TEST_MODE_CAPABILITIES`. **There is no Codex adapter** — only `claude-code/` and `test-mode/`. The `codex-runtime-adapter-prework` spec laid interface groundwork but shipped no adapter directory. ⇒ runtime-neutrality is today validated only against `test-mode`; "serve Codex" is **forward-looking**.

### Blast radius

`transport.ts` (options bag) · `schemas.ts` (new context schema) · `sessions.ts` route · `trigger-turn.ts` + `embedded-turn-trigger.ts` (threading) · `agent-runtime.ts` (`MessageOpts`, `RuntimeCapabilities`) · `message-sender.ts` + `context-builder.ts` (materialize + `excludeDynamicSections`) · `transcript-parser.ts` (strip allowlist) · `use-message-queue.ts` (prose → signal) · `fake-agent-runtime.ts` + capability/route/sender tests.

---

## 4) Research (SDK 0.3.177 / claudeCode 2.1.177)

> Full report retained from the research agent; sources are primary (SDK `sdk.d.ts`, Anthropic prompt-caching docs, the GitHub issues).

### 4.1 The `UserPromptSubmit` hook is the _wrong_ primary mechanism here

- **#14281** ("`additionalContext` injected multiple times") — the _within-turn duplication_ bug — is **closed/fixed in the 2.1 line** (we run 2.1.177). ✅ That narrow bug is not the blocker.
- **#40216** — `UserPromptSubmit` `additionalContext` **accumulates across turns**: each turn appends a _new_ `<system-reminder>` block; prior turns are **not** replaced. Closed **"not planned"** (treated as intended). A long session would carry a git snapshot per turn. ❌
- **JSONL pollution** — hook context is written as `hook_result` user-role records. DorkOS's `transcript-parser` has no handling for them, so they risk rendering as phantom history — the exact leak we're eliminating. ❌ (Unverified against our parser; moot unless the hook is ever adopted.)
- **Prompt cache** — per-turn-changing context belongs **after** the cache breakpoint, i.e. in the latest user message. The current body-prepend is **already cache-correct**; the hook's accumulating `<system-reminder>` blocks are not. ❌

### 4.2 `excludeDynamicSections: true` (the de-dup lever)

From `sdk.d.ts` (0.3.177): strips the preset's **working-directory, auto-memory path, and git status** from the system prompt (making it static/cacheable) and re-injects them **as the first user message**. No effect if `systemPrompt` is a custom string. This is the supported way to stop the preset's native git injection so DorkOS can supply its own canonical block (A2). Tradeoffs: the stripped content is "marginally less authoritative" in a user message vs the system prompt; the first user message grows slightly.

### 4.3 Prompt-cache summary

Order is `tools → system → messages`; the stable prefix (system + prior turns) caches, and per-turn content after the breakpoint does not harm it. **A2 makes the entire system prompt static/cacheable** (git moves out), with a small fresh git block per turn in the body — cache-correct and current. The cache delta vs A1 is **marginal for single-user DorkOS**; the real A2 win is uniformity/single-source.

### 4.4 Cross-runtime out-of-band context

|                        | Claude SDK                        | Codex CLI                   | OpenCode                                       |
| ---------------------- | --------------------------------- | --------------------------- | ---------------------------------------------- |
| Static session context | `systemPrompt.append` / AGENTS.md | AGENTS.md / `developer` msg | AGENTS.md / provider prompt                    |
| Per-turn context       | hook / **body prepend**           | user-prompt hook / **body** | `<system-reminder>` via tool output / **body** |
| **Native git status**  | **Yes** (preset)                  | **No**                      | **No**                                         |

**Body-prepend is the common denominator** across all three; only Claude injects git natively, and `excludeDynamicSections` lets us turn that off. This validates a single uniform mechanism rather than a per-runtime split.

### 4.5 Recommendation (research agent, verbatim sense)

Do **not** use the hook as the primary channel on 0.3.177. Keep a cache-correct, non-accumulating **structured body-prepend** for all runtimes; for Claude git, set `excludeDynamicSections: true` and supply one fresh per-turn block. `SessionStart` hook (fires once, does **not** persist to transcript per #11906) is acceptable for session-once context if ever needed.

---

## 5) Recommended Approach

A single uniform channel: **the server assembles one canonical, structured `additionalContext` bag per turn; every adapter materializes it the same way — a tagged prepend it strips on render — and the user's `content` is never mutated upstream.**

### Layer 1 — Client → Server (`postMessage` options → typed `context`)

Generalize the options bag from `{ clientMessageId?; uiState? }` to also carry a typed **`context`** object of **signals + structured data, never pre-formatted prose**. The client contributes only what it knows:

- `uiState` (already structured) — keep as-is, fold under `context`.
- **queue signal** — replace the client's English `[Note: …]` prose (`use-message-queue.ts:106`) with a boolean/structured signal (e.g. `context.composedDuringPrevTurn: true`). This is the **interim** queue-note fix; it is pristine immediately and does **not** wait for DOR-106.
- (room for future: editor selection, open file, etc.)

Defined as a Zod schema in `packages/shared`, shared by `HttpTransport` and `DirectTransport`. `git_status`/`env` are **not** client-sent — the server derives them.

### Layer 2 — Server → Runtime (`MessageOpts.additionalContext`)

Generalize `MessageOpts` (`cwd?`, `uiState?`) to a neutral **`additionalContext`** bag of **labeled entries** — a discriminated union by `kind`, each carrying **structured `data` (not pre-formatted text)** plus a `scope: 'per-turn' | 'per-session'`:

```
kind: 'git_status' | 'ui_state' | 'queue_note' | 'env' | 'relay_context'
```

The **server merges** client-supplied entries (`ui_state`, `queue_note`) with server-derived entries (`git_status`, `env`) into one bag and hands it to the runtime. **Interface contract:** additional context is delivered out-of-band relative to `content`, must never mutate `content`, and must never render as user-authored text. The server is the single source of truth for _what_ context exists; the adapter owns _how_ it is rendered. (Decision: entries are **structured, adapter-formats** — maximally runtime-neutral; the server does not emit Claude-flavored XML.)

### Layer 3 — Claude adapter (structured prepend + strip; `excludeDynamicSections`)

- For each forwarded entry, the adapter formats a tagged block (`<git_status>`, `<ui_state>`, `<queue_note>`, …) and prepends it to the prompt sent to `query()`. The user's stored/displayed message stays pristine because `transcript-parser` strips these tags on render (extend the `stripSystemTags` allowlist to cover every kind, incl. the new `<queue_note>`).
- Set `systemPrompt: { type:'preset', preset:'claude_code', append, excludeDynamicSections: true }` (A2) so the preset stops injecting git/cwd/memory; DorkOS's canonical git block is the only one.
- **Command-skip guard stays.** Structured-prepend does **not** let us drop the DOR-107 guard: a `/`-prefixed prompt must reach the CLI bare, so the adapter still skips the prepend on command-dispatch turns. This is the documented tradeoff of choosing prepend over the hook — but the guard is now well-contained (content is never otherwise mutated), not fragile.

### Layer 4 — Capability surface (simplified by A2)

- **A2 collapses the de-dup matrix.** Because we _suppress_ Claude's native git via `excludeDynamicSections`, there is nothing left to de-dup against — the server forwards one canonical bag to **every** runtime uniformly. The ADR's "Claude is special, skip git for it" rule disappears.
- Add **`nativeContext: ContextKind[]`** to `RuntimeCapabilities` as the general, future-proof mechanism (a runtime declares any context it injects itself and cannot suppress, so the server omits those kinds). Under A2, Claude's `nativeContext` is effectively empty.
- **Defer `contextDelivery`** ('native' | 'prepend'). With only one materialization strategy in play today, adding the field now is speculative (Rams: "as little design as possible"). Introduce it only when the hook path (a second strategy) is actually adopted.

### Why this satisfies ADR-0273's principle

Content is pristine (client/server never mutate it; the queue prose becomes a signal); injected context never renders as user text (adapter-owned strip); context is neutral structured data carried down the existing layers; per-runtime differences live in capabilities; the same boundary principle extends to commands (DOR-109). It is _more_ uniform than the ADR's original A1 + hook design, and it is grounded in the SDK's actual 0.3.177 behavior.

---

## 6) Decisions

| #   | Decision                          | Choice                                                                                                                                                                      | Rationale                                                                                                                                                                                                                             |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Claude context-delivery mechanism | **Structured tagged prepend + adapter strip** (amends ADR-0273 layer 3)                                                                                                     | Cache-correct and non-accumulating; avoids `hook_result` JSONL pollution; uniform across Claude/Codex/OpenCode (all three prepend anyway). Hook deferred until SDK fixes #40216 accumulation + parser handles `hook_result`. _(user)_ |
| 2   | Git-status de-duplication         | **A2: `excludeDynamicSections: true` + forward our canonical git** (flips ADR-0273 A1)                                                                                      | Single source of truth, byte-identical git format across all runtimes, fully static/cacheable system prompt. Collapses the de-dup matrix. _(user)_                                                                                    |
| 3   | Context-entry shape               | **Discriminated union by `kind` with structured `data` + `scope`; adapter formats**                                                                                         | Server owns _what_, adapter owns _how_ — maximally runtime-neutral; server never emits Claude-flavored XML.                                                                                                                           |
| 4   | Capability surface                | **Add `nativeContext`; defer `contextDelivery`**                                                                                                                            | `nativeContext` is needed as the general de-dup mechanism; `contextDelivery` is speculative with only one strategy today.                                                                                                             |
| 5   | Queue-note                        | **Client sends a structured signal now (interim); server-origin completes under DOR-106**                                                                                   | Pristine immediately, no waiting on the server-owned queue; adapter wraps as `<queue_note>` + strips. Note stays as **model** context; optional quiet "queued" UI badge is a separate render concern.                                 |
| 6   | DOR-107 command-skip guard        | **Retained** (prepend can't drop it)                                                                                                                                        | A `/`-prefixed prompt must reach the CLI bare; only the hook path would have eliminated the guard. Accepted tradeoff of Decision 1.                                                                                                   |
| 7   | Scope & sequencing                | **This spec = the channel (L1–L3 + simplified de-dup) + migrate git_status/ui_state/queue-note.** DOR-132 first slice; DOR-106 completes queue-note origin; DOR-109 sibling | Matches the brief; keeps independently-shippable slices.                                                                                                                                                                              |

---

## 7) Open Questions / Verification Gates (for the `/spec` phase)

These are implementation verifications, **not** blockers:

1. **`excludeDynamicSections` re-injection under per-resume.** Confirm whether the SDK re-injects the stripped sections into _every_ resumed turn's first message (potential stale git alongside our fresh per-turn block) or only at true session start. If stale duplication appears, decide whether to live with one stale session-start block or compensate.
2. **Env de-dup.** `excludeDynamicSections` is documented for cwd/memory/git — confirm whether it also suppresses the preset `<env>` block. If env survives, reconcile it with DorkOS's `buildEnvBlock` (today in `systemPromptAppend`) so env isn't doubled.
3. **Strip allowlist completeness.** Extend `stripSystemTags` for every `kind` (incl. `<queue_note>`); add a test asserting no injected tag ever survives to a rendered user message.
4. **Cache validation.** Empirically confirm A2 preserves cache hits (the [[token_burn]] context: cache RE-creation churn is the real cost) — compare cache-hit rate before/after on a multi-turn session.
5. **Future hook option.** Re-evaluate `contextDelivery: 'native'` only if/when #40216 accumulation is fixed _and_ the parser learns to hide `hook_result` records.

---

## 8) Scope & Sequencing

- **In this spec:** the neutral context channel (Layers 1–3), the simplified capability de-dup (Layer 4), and migrating `git_status` + `ui_state` + the queue-note onto it.
- **First shippable slice → DOR-132:** add `excludeDynamicSections: true` and route git through the new channel (kills the per-turn double git injection) — can land ahead of the full client→server schema work.
- **Completed by DOR-106:** the queued-note's _server-side origin_ (the signal originates from the server-owned queue rather than the client). The interim client signal (Decision 5) is a strict improvement in the meantime.
- **Sibling, not merged → DOR-109:** universal command intents share ADR-0273's boundary-translation _principle_ but not this context _contract_. Keep aligned.
- **Forward-looking:** when a real Codex/OpenCode adapter lands, it implements against this neutral interface from day one (declaring an empty-or-minimal `nativeContext`, prepending the canonical bag).

---

## 9) ADR-0273 Amendment (recommended)

ADR-0273 is `proposed`. This ideation **keeps its principle intact** but, on SDK-0.3.177 evidence, amends two implementation choices. Before `/spec:execute`, ADR-0273 should be updated (or a short superseding note added):

- **Layer 3:** primary Claude materialization is a **structured tagged prepend + adapter strip**, not the `UserPromptSubmit` hook. The hook is recorded as a deferred future option with explicit gates (#40216 accumulation fixed; `hook_result` handled by the parser).
- **De-dup:** adopt **A2** (`excludeDynamicSections: true` + forward DorkOS's canonical git), replacing A1. Note that A2 **collapses** the capability-driven de-dup matrix — uniform forwarding to all runtimes — and that `nativeContext` remains the general mechanism while `contextDelivery` is deferred.
- Carry forward the honest negatives: the DOR-107 command-skip guard is retained under prepend; the queue-note's full fix still depends on DOR-106.

---

## Next Steps

1. Review this ideation.
2. Amend **ADR-0273** per §9 (or queue it as the first task of the spec).
3. Run: `/ideate-to-spec specs/runtime-neutral-context-channel/01-ideation.md`
