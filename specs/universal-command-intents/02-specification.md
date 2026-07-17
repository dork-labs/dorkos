---
slug: universal-command-intents
id: 260716-234343
created: 2026-07-16
status: specified
linearIssue: DOR-109
project: Universal Command Interface
---

# Universal Command Intents with Cross-Agent Aliases (compact / clear / context)

**Status:** Draft
**Author:** Sage (SPECIFY stage, /flow drain)
**Date:** 2026-07-16
**Tracker:** DOR-109 (Universal Command Interface project) · type hypothesis · size 5

## Overview

DorkOS runs several agent runtimes (Claude Code, Codex, OpenCode) behind one
cockpit. Each agent has its own muscle-memory vocabulary for the same three
everyday actions — shrink the context, start fresh, see how much context/cost
you have left — and the tokens differ per agent (`/compact` vs `/compress` vs
`/summarize`; `/clear` vs `/new` vs `/new-chat`; `/context` vs `/usage` vs
`/status`). This feature defines **three canonical DorkOS command intents** —
`compact`, `clear`, `context` — each with a cross-agent **alias set**, so that
typing any major agent's word for an intent does the right thing on whatever
runtime the session is bound to. The command surface becomes portable: your
fingers keep working when you switch runtimes.

The three intents split across **two execution seams that already ship**, and
getting that split right is the whole design:

- **`compact`** is **runtime-fulfilled** — only the runtime can compact its own
  context. Gated per runtime by a new first-class `RuntimeCapabilities.commandIntents`
  capability (sibling of `permissionModes`, ADR-0256) and dispatched to the
  adapter, which expands the neutral intent into its native mechanism (Claude:
  bare `/compact`; OpenCode: `client.session.summarize`; Codex: unsupported).
- **`clear`** and **`context`** are **DorkOS-native actions** — identical on
  every runtime — routed through the shipped client-side native-command seam
  (ADR-0300). `clear` starts a fresh session in the same project; `context`
  opens/focuses the runtime-neutral usage & cost surface shipped by DOR-100.

The pure **alias → canonical-intent registry** lives in `@dorkos/shared`
(ADR-0273 "neutral down"), consumed by both the client palette (dedupe, alias
hints, honest gating) and the server (compact dispatch + capability gating).

## Background / Problem Statement

DorkOS's Universal Command Interface project already shipped the substrate this
feature composes with (verified against the codebase, 2026-07-16):

- **DOR-107** (`message-sender.ts:343-377`): `/`-prefixed content reaches
  Claude's CLI bare; a command-skip guard (`detectSlashCommandName` +
  `getKnownCommands`) suppresses the additional-context prepend on command
  turns. **This guard lives inside the Claude adapter, keyed to a
  Claude-SDK-specific `getKnownCommands` cache** (wired at
  `claude-code-runtime.ts:294`).
- **DOR-108** (`schemas.ts:1547-1565`): `CommandEntry.aliases?: string[]`,
  populated from the Claude SDK's `supportedCommands()`. These are _runtime-native_
  aliases (e.g. Claude's `/cost`,`/stats` → `/usage`), not cross-agent aliases.
- **DOR-119/120** (`entities/command/lib/rank-command.ts`,
  `features/commands/ui/CommandPalette.tsx:89-93`): a fuzzy ranker
  (name > alias > description) and a "matched /{alias}" hint that already renders.
- **web-chat-native-commands / DOR-128 / ADR-0300**
  (`features/chat/model/native-commands/registry.ts`): a client-side
  native-command seam — `NATIVE_COMMANDS`, `parseNativeCommand`,
  `NATIVE_COMMAND_ENTRIES` — intercepted at `executeSubmission` +
  `useChatQueue.handleQueue`, so a native command never reaches the runtime.
  `/rename` is the sole entry. **The DOR-128 spec explicitly left
  compact/clear/context to DOR-109.**
- **ADR-0273** (runtime-neutral context injection): the load-bearing precedent —
  "Universal command intents (compact / clear / context) translate at the same
  boundary — neutral intent down, per-runtime expansion in the adapter." DOR-109
  is the named command sibling of the context channel.

**The problem the issue's design direction got half-right.** The issue said
"resolve aliases server-side at the message-dispatch chokepoint," naming
`trigger-turn.ts`. Verified: `trigger-turn.ts` does **no** command detection —
it assembles the neutral context bag and passes `content` **pristine** to
`sendMessage` (`trigger-turn.ts:226-239`). Slash-command dispatch physically
lives in the Claude adapter, not the neutral boundary. So the naive reading
("rewrite the string at trigger-turn") is wrong twice over: (1) it would add
command detection to a path that has none and duplicate the DOR-107 guard —
the "no half-migrations" hazard (AGENTS.md); and (2) it cannot fulfill
`compact` uniformly, because OpenCode's compaction is **not** a prompt — it is
an out-of-band SDK call (`client.session.summarize`), verified in
`@opencode-ai/sdk@1.17.13` (`Session.summarize` → `POST /session/{id}/summarize`).
A string rewrite `/compress` → `/compact` sent as content would compact on
Claude and be sent as **literal text to the model** on OpenCode. Fulfillment is
heterogeneous; it must live in each adapter.

This spec resolves the seam split, the capability shape, and the chokepoint,
so DECOMPOSE can proceed without re-litigating architecture.

## Operator Decisions (LOCKED)

Pinned before specifying; not reopened here.

1. **OpenCode `compact` ships now.** OpenCode has native sidecar compaction
   (`event-mapper.ts:239` maps `session.compacted`) and a verified trigger
   (`client.session.summarize`). DOR-109 wires it so all three runtimes fulfill
   `compact` on day one (claude-code + opencode supported; codex honest-disabled).
2. **`context` is a DorkOS-native action, unified with DOR-100.** DOR-100
   (runtime-neutral usage/cost status) is shipped: `UsageStatus`
   (`@dorkos/shared/types`) rendered by `features/status/ui/UsageStatusItem.tsx`
   inside `ChatStatusSection`. `context` opens/focuses that surface — identical
   behavior on every runtime, same philosophy as `clear` (a client-native
   action, **not** a runtime command).
3. **Palette-merge scope is the inline `/` slash palette only.** The global
   Cmd+K palette (`features/command-palette`, command-palette-10x) is out of
   scope — noted as a fast-follow.
4. **Exactly three canonical intents:** `compact`, `clear`, `context`. A fourth
   is a separate issue.

## Goals

- A pure, runtime-neutral **alias → canonical-intent registry** in `@dorkos/shared`,
  consumed by client and server.
- A first-class **`RuntimeCapabilities.commandIntents`** capability gating the
  runtime-fulfilled intent (`compact`) per runtime.
- **`compact`** fulfilled on claude-code (bare `/compact`) and opencode
  (`session.summarize`); **honestly disabled** on codex.
- **`clear`** and **`context`** as DorkOS-native client actions, identical
  across runtimes, routed through the ADR-0300 native-command seam.
- Inline slash-palette shows **one entry per intent** with the native runtime
  command deduped and an "also: /compress, /summarize" alias hint (reusing the
  shipped DOR-108/119/120 aliases field + ranker + "matched /{alias}" hint).
- **Honest unsupported state:** a disabled palette entry "Not supported by
  {runtime}"; the composer refuses to send an unsupported intent as text (never
  a silent no-op).
- `FakeAgentRuntime` + `test-mode` fulfill the new surface so e2e verifies
  per-runtime gating (validation criterion 3).

## Non-Goals

- **Emulated compaction** for runtimes without native compaction (DOR-114 —
  Triage). Codex `compact` stays honestly disabled; DorkOS does not fake it.
- **A fourth+ canonical intent** (`model`, `resume`, `export`, `usage`-as-command).
- **The Cmd+K global-palette merge** (command-palette-10x). Inline `/` palette
  only (Decision 3). Fast-follow.
- **Re-implementing the usage/cost surface.** `context` opens the _existing_
  DOR-100 surface; it does not add new usage metrics.
- **New adapters** for Gemini / Cursor / Copilot. Those rows inform the _alias
  vocabulary_ users type, not runtimes to build.
- **Moving or replacing the DOR-107 command-skip guard.** It stays (see Detailed
  Design → chokepoint decision).

## Technical Dependencies

- `@opencode-ai/sdk@1.17.13` — `client.session.summarize({ path: { id },
body?: { providerID, modelID }, query?: { directory } })` → `/session/{id}/summarize`.
  The compaction trigger. **SDK import confined to `services/runtimes/opencode/`
  (Hard Rule 2).**
- `@anthropic-ai/claude-agent-sdk` — Claude fulfills `compact` by sending the
  bare `/compact` prompt through its existing send path. **Confined to
  `services/runtimes/claude-code/`.**
- `@openai/codex-sdk@0.142.5` — `Thread` exposes only `run(input, turnOptions)`;
  **no compaction/summarize method** (verified). Codex `compact` is unsupported.
- No new external dependencies. All new types are DorkOS Zod/TS in `@dorkos/shared`.

## Detailed Design

### The chokepoint decision — Option (b): layer above the existing seams; the DOR-107 guard stays put

**Decision: (b).** Intent _recognition_ happens client-side (the shipped
native-command seam, extended); the runtime-fulfilled intent (`compact`)
dispatches through a **new capability-gated adapter method**
(`AgentRuntime.executeCommandIntent`) behind a dedicated transport method +
route. **`trigger-turn.ts` stays pristine (no command detection added)** and the
**DOR-107 guard in the Claude adapter is untouched.**

**Rationale.** Option (a) — lift command/alias resolution to `trigger-turn` and
retire the adapter guard — fails on two counts. First, it cannot fulfill
`compact` uniformly: OpenCode compaction is an out-of-band SDK call, not a
prompt, so a neutral string rewrite is wrong for OpenCode and the fulfillment
mechanism must live in each adapter regardless. Second, the DOR-107 guard's job
— pass _arbitrary_ command-shaped content (`/model`, `/agents`, user-authored
`.claude/commands/*`) to Claude's CLI bare — is inherently Claude-runtime
behavior over an open set; lifting it to the neutral boundary would leak Claude
command semantics into `trigger-turn` and could not be "completed" (the neutral
layer can't know Claude's full command list). Option (b) keeps each concern at
its natural altitude: the 3-intent _canonical_ layer above, the open-set Claude
_passthrough_ guard below, with disjoint ownership.

**Migration-completeness rule (no half-migration).** Ownership of the three
canonical tokens (`/compact` + aliases, `/clear` + aliases, `/context` + aliases)
moves **exclusively** to the intent path:

- `/compact` and its aliases typed in the composer are recognized client-side
  and dispatched via `runCommandIntent` — they no longer travel the raw
  message → DOR-107 path.
- `clear` / `context` and their aliases are intercepted client-side by the
  native-command seam and never reach the runtime.
- The DOR-107 guard is **not modified and not dead**: it remains the correct,
  general handler for every _other_ command-shaped string that legitimately
  reaches Claude's CLI. If some non-composer path ever sends a literal
  `/compact` as content, DOR-107 still handles it identically — that is
  by-design layering, not duplication. No `/compact`-specific branch is split
  across two layers, and no code is left superseded.

`trigger-turn.ts` and `message-sender.ts:343-377` are therefore **unchanged** by
this spec. The blast radius is additive.

### Architecture: the two seams

```
                    ┌─────────────────────────────────────────────┐
  user types        │  @dorkos/shared/command-intents (registry)  │
  /compress    ───▶ │  resolveCommandIntent('/compress') → compact │
  (composer or      └───────────────┬─────────────────────────────┘
   inline palette)                  │
                    ┌───────────────┴───────────────┐
       fulfillment: 'runtime'            fulfillment: 'client-native'
                    │                                │
     compact (server dispatch)          clear / context (local, ADR-0300)
                    │                                │
  transport.runCommandIntent   ┌──────────┴──────────┐
                    │          clear: new session     context: focus DOR-100
  POST /api/sessions/:id/       in same project        UsageStatusItem
   command-intents/compact             (native-command seam executors)
                    │
  runtimeRegistry → runtime.executeCommandIntent('compact')
     ├─ claude-code:  send bare '/compact' (reuses existing send + DOR-107)
     ├─ opencode:     client.session.summarize({ path:{id} })
     └─ codex:        gated off (commandIntents.compact.supported = false)
```

### 1. Shared registry — `packages/shared/src/command-intents.ts` (new)

The single source of truth for the canonical intents and their cross-agent
aliases. Pure, no runtime deps. Exported via a new `@dorkos/shared/command-intents`
subpath (add to the `exports` map in `packages/shared/package.json`) and
re-exported from the types barrel.

```ts
/** The closed set of canonical DorkOS command-intent ids. */
export type CommandIntentId = 'compact' | 'clear' | 'context';

/** Which layer fulfills an intent: the runtime, or a DorkOS-native client action. */
export type CommandIntentFulfillment = 'runtime' | 'client-native';

/** Intent ids the runtime must fulfill — the subset gated by RuntimeCapabilities. */
export type RuntimeCommandIntentId = Extract<CommandIntentId, 'compact'>;

export interface CommandIntentDescriptor {
  id: CommandIntentId;
  /** Canonical DorkOS slash token, e.g. '/compact'. */
  canonical: string;
  /** One-line palette description (writing-for-humans; plain, user-facing). */
  description: string;
  /** Argument hint for the palette, if the intent takes arguments. */
  argumentHint?: string;
  /** Cross-agent aliases users may type (muscle memory), each '/'-prefixed. */
  aliases: readonly string[];
  fulfillment: CommandIntentFulfillment;
}

export const COMMAND_INTENTS: readonly CommandIntentDescriptor[] = [
  {
    id: 'compact',
    canonical: '/compact',
    description: 'Shrink the conversation to free up context',
    aliases: ['/compress', '/summarize'],
    fulfillment: 'runtime',
  },
  {
    id: 'clear',
    canonical: '/clear',
    description: 'Start a fresh session in this project',
    aliases: ['/new', '/new-chat'],
    fulfillment: 'client-native',
  },
  {
    id: 'context',
    canonical: '/context',
    description: 'Show context usage and cost',
    aliases: ['/usage', '/cost', '/stats', '/status'],
    fulfillment: 'client-native',
  },
];

/**
 * Resolve a typed slash token (with or without a leading '/') to its canonical
 * intent, matching the canonical token or any alias (case-insensitive).
 * Returns null when the token is not a canonical intent (falls through to the
 * runtime/composer as today).
 */
export function resolveCommandIntent(token: string): CommandIntentDescriptor | null;

/** The set of every canonical + alias token, for the palette's dedupe pass. */
export function commandIntentTokens(): ReadonlySet<string>;
```

Alias vocabulary is drawn verbatim from the ideation's verified cross-agent
table: `compact` ← `/compress` (Gemini/Cursor), `/summarize` (OpenCode);
`clear` ← `/new` (Codex/OpenCode), `/new-chat` (Cursor); `context` ← `/usage`,
`/cost`, `/stats` (Claude/Copilot/Gemini), `/status` (Codex).

### 2. Runtime capability — `RuntimeCapabilities.commandIntents`

New first-class field on `RuntimeCapabilities` (`packages/shared/src/agent-runtime.ts:242-308`),
a **sibling of `permissionModes`**, not the `features` bag (ADR-0256: cross-runtime
structured capability). It gates only the runtime-fulfilled subset.

```ts
/** Per-runtime support for a runtime-fulfilled command intent. */
export interface CommandIntentSupport {
  /** Whether the runtime can fulfill this intent for a session. */
  supported: boolean;
}

// added to RuntimeCapabilities:
/**
 * Support for RUNTIME-fulfilled command intents (currently `compact`).
 * Client-native intents (clear, context) are universal and not gated here.
 * `supported: false` → palette disables the entry ("Not supported by
 * {runtime}") and the composer refuses to send the intent as text.
 * First-class per ADR-0256; the adapter expands the neutral intent per
 * ADR-0273. Required — compile-time forcing so no adapter silently omits it.
 */
commandIntents: Record<RuntimeCommandIntentId, CommandIntentSupport>;
```

Per-runtime values (the honest matrix, verified):

| Runtime     | `commandIntents.compact` | Mechanism                                   |
| ----------- | ------------------------ | ------------------------------------------- |
| claude-code | `{ supported: true }`    | bare `/compact` prompt                      |
| opencode    | `{ supported: true }`    | `client.session.summarize`                  |
| codex       | `{ supported: false }`   | none — `Thread.run` only, no compaction API |
| test-mode   | `{ supported: true }`    | synthetic `compact_boundary`                |

**Compile-time viral change (intended, ADR-0256):** the new required field
forces an edit to every caps constant — `CLAUDE_CODE_CAPABILITIES`,
`CODEX_CAPABILITIES`, `OPENCODE_CAPABILITIES`, `TEST_MODE_CAPABILITIES` — plus
`FakeAgentRuntime.getCapabilities` (`packages/test-utils`). The capabilities DTO
(`GET /api/capabilities`, `routes/capabilities.ts`) serializes the new field
automatically; if `RuntimeCapabilities` has a paired Zod schema for OpenAPI, add
`commandIntents` there too.

### 3. Runtime fulfillment — `AgentRuntime.executeCommandIntent`

New method on the `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`,
near `sendMessage`/`getCommands`). Only ever called for runtime-fulfilled intents
on runtimes that declare support; the server gates before calling.

```ts
/**
 * Fulfill a RUNTIME-fulfilled command intent (currently `compact`) for a
 * session, expanding the neutral intent into the runtime's native mechanism
 * (ADR-0273). Yields the resulting StreamEvents so the server drives them
 * through the durable session projector exactly like a turn — the client
 * learns of a compaction via `GET /:id/events` (e.g. `compact_boundary`).
 * Called only when getCapabilities().commandIntents[intent].supported.
 *
 * @param sessionId - Target session.
 * @param intent - The runtime-fulfilled intent id.
 * @param opts - cwd and per-turn options (reuses MessageOpts shape).
 */
executeCommandIntent(
  sessionId: string,
  intent: RuntimeCommandIntentId,
  opts?: MessageOpts
): AsyncGenerator<StreamEvent>;
```

Per-runtime implementations (SDK-confined):

- **claude-code** (`services/runtimes/claude-code/`): `executeCommandIntent('compact')`
  sends the bare `/compact` through its existing SDK send path (reusing DOR-107's
  bare-passthrough + `getKnownCommands`), yielding the turn's events. No new
  Claude-SDK surface; it wraps the shipped `/compact` mechanism.
- **opencode** (`services/runtimes/opencode/`): `executeCommandIntent('compact')`
  resolves the session's `ses_*` id and calls
  `client.session.summarize({ path: { id: ocSessionId } })`. The compaction is
  reported out-of-band as `session.compacted` → the existing event-mapper
  (`event-mapper.ts:239`) already maps it to `operation_progress` done +
  `compact_boundary` on the session stream, so the generator yields nothing (or a
  single synthetic ack); the boundary arrives via the global event hub. Body
  (`providerID`/`modelID`) is omitted — compaction uses the session's own model.
- **codex** (`services/runtimes/codex/`): implement to `throw` a typed
  "unsupported" error (defensive); it is never reached because
  `commandIntents.compact.supported === false` gates the route.
- **test-mode** + **FakeAgentRuntime**: yield a synthetic `compact_boundary` so
  conformance + e2e can assert dispatch reached the runtime.

The route drives the returned generator through the same durable-projector /
lock lifecycle used for turns (reuse the `triggerTurn` projector + lock
machinery in `services/session/`; a thin `triggerCommandIntent` sibling is
acceptable — it does not need canonical-id rekey or context assembly). This
keeps compaction events on the single delivery path (`/events`, ADR-0264).

### 4. Transport + route

- **Transport** (`packages/shared/src/transport.ts`): add
  `runCommandIntent(sessionId: string, intent: RuntimeCommandIntentId): Promise<{ sessionId: string }>`.
  `HttpTransport` POSTs the route; `DirectTransport` (Obsidian) calls the same
  server service in-process — so all four client surfaces share one path.
- **Route** (`apps/server/src/routes/`): `POST /api/sessions/:id/command-intents/:intent`
  (or a scoped `:id/compact`). Thin handler (server-structure rule): validate
  `:intent` against `RuntimeCommandIntentId` (Zod), resolve the session's runtime
  via `runtimeRegistry`, check `getCapabilities().commandIntents[intent].supported`
  → `409`/`422` honest error when unsupported, else drive
  `runtime.executeCommandIntent` through the projector and return `202`. Register
  in the route table + OpenAPI.

### 5. Client — palette dedupe, alias hints, honest gating, native actions

**a. Inline palette source (`features/chat/ui/ChatPanel.tsx:221-225`).** Extend
the `allCommands` merge to project the shared registry into `CommandEntry` rows
and dedupe against native runtime commands by **canonical token or any alias**
(today it dedupes only by token). Each intent row carries `aliases` from the
shared registry, so the shipped ranker (`rank-command.ts`) and the shipped
"matched /{alias}" hint (`CommandPalette.tsx:89-93`) light up for free
(Decision 6 — mechanism already exists). Result: one row per intent, the native
runtime command (`/compact`, `/context`) folded in, alias hint on match.

```ts
// sketch — intent entries ahead of native + runtime, deduped by token OR alias
const intentTokens = commandIntentTokens(); // shared
const nativeTokens = new Set(NATIVE_COMMAND_ENTRIES.map((e) => e.command));
const runtime = (registry?.commands ?? []).filter(
  (c) => !intentTokens.has(`/${c.command}`) && !nativeTokens.has(c.command)
);
return [...INTENT_ENTRIES, ...NATIVE_COMMAND_ENTRIES, ...runtime];
```

**b. Honest gating.** The palette reads the active runtime's capabilities via
the shipped `useCapabilitiesForRuntime(runtimeChip.runtime)`
(`entities/runtime/model/use-runtime-capabilities.ts`). A runtime-fulfilled
intent with `commandIntents[id].supported === false` renders **disabled** with
"Not supported by {runtime}". Client-native intents (clear/context) are always
enabled. `CommandPalette.tsx` gains a disabled-row style + a non-selectable
state (respecting keyboard nav).

**c. `clear` and `context` as native commands (ADR-0300 seam).** Add both to the
native-command registry (`features/chat/model/native-commands/registry.ts`)
alongside `/rename`, each with a **local executor** (never reaches the runtime):

- **`clear`** — create a fresh session in the same project (same `cwd`) and
  navigate to it (reuse the existing new-session flow; navigation via the
  `use-session-id` setter → `/session?session=<id>`). "Linked back": record the
  prior session id on the new session as a lightweight `continuedFrom` reference
  (minimal; the exact field is a DECOMPOSE detail). Sidesteps
  `/clear`-under-resume-per-message semantics. Extend `NativeCommandContext`
  with a `startFreshSession(fromSessionId: string | null)` capability injected by
  `use-native-commands.ts`.
- **`context`** — open/focus the DOR-100 usage & cost surface. The shipped
  surface is `UsageStatusItem` in `ChatStatusSection` (fed by `streamValues.usage:
UsageStatus`). `context` reveals the usage & cost details (the same content as
  the item's tooltip) in a focused/pinned popover so a keyboard user who typed
  `/context` sees utilization + cost without hovering; when the session has no
  usage yet (`hasRenderableUsage` false — e.g. a cold codex session) it shows an
  honest "No usage data for this session yet." Extend `NativeCommandContext` with
  a `focusUsageSurface()` capability. Identical on every runtime; the _content_
  varies only by what the runtime reports to DOR-100.

**d. `compact` dispatch.** In the same client interception funnel that the
native-command seam already uses (`executeSubmission` in `use-session-submit.ts`
and `handleQueue` in `use-chat-queue.ts`), recognize a runtime-fulfilled intent
via `resolveCommandIntent`. When matched **and** supported by the active runtime:
call `transport.runCommandIntent(sessionId, 'compact')`, clear the composer, do
**not** POST a message. When matched but **unsupported**: `notify` "Compact isn't
supported by {runtime}" and keep the composer text (no silent send-as-text —
resolves the ideation's silent-failure regression). This keeps a single
client-side recognition point for all three canonical intents; only the branch
differs (local executor vs. `runCommandIntent`).

FSD note: recognition + dispatch stay inside `features/chat/model/`; the shared
registry crosses as a package import (not a layer edge). No FSD violation.

### API / data model changes

- `@dorkos/shared`: new `command-intents.ts` module + subpath export;
  `RuntimeCapabilities.commandIntents`; `AgentRuntime.executeCommandIntent`;
  `Transport.runCommandIntent`.
- Server: one new route; `commandIntents` added to four caps constants;
  `executeCommandIntent` on three production adapters + test-mode.
- No SQLite/schema change (compaction is runtime-owned; `clear`'s `continuedFrom`
  link, if persisted, rides the existing session store — DECOMPOSE decides).

## User Experience

- **Discovery:** typing `/` shows the inline palette. Each intent appears once:
  `/compact` "Shrink the conversation to free up context", `/clear` "Start a
  fresh session in this project", `/context` "Show context usage and cost".
  Typing `/comp`, `/summ`, `/usage`, `/new`, `/status` etc. fuzzy-matches the
  right intent and shows a "matched /{alias}" hint.
- **`/compress` (or `/summarize`) on Claude or OpenCode + Enter:** the session
  compacts; the composer clears; a `compact_boundary` renders in the transcript.
- **`/compact` on Codex:** the palette entry is disabled ("Not supported by
  Codex"); typing it + Enter shows "Compact isn't supported by Codex" and leaves
  the text in the composer — never sent to the model.
- **`/new` (or `/clear`) on any runtime + Enter:** a fresh session opens in the
  same project; the sidebar shows it; the prior session is linked. No message
  sent, no model turn.
- **`/usage` (or `/context`, `/status`) on any runtime + Enter:** the usage &
  cost surface opens/focuses; keyboard users see utilization + cost. No message
  sent.

## Testing Strategy

**Unit — shared (`packages/shared/src/__tests__/command-intents.test.ts`):**
`resolveCommandIntent` maps every canonical token and alias (case-insensitive,
with/without leading `/`) to the right intent; returns null for unknowns and for
`/renamefoo`-style near-misses; `commandIntentTokens` contains every canonical +
alias; each descriptor's `fulfillment` is correct (compact=runtime,
clear/context=client-native).

**Unit — ranker/palette (`entities/command`, `features/commands`, `features/chat`):**
an intent entry deduping a colliding native runtime command (by token _and_ by
alias, e.g. Claude's SDK `/usage` does not double with the `context` intent); the
"matched /{alias}" hint on an alias match; a disabled row rendered for an
unsupported runtime-fulfilled intent (keyboard nav skips it).

**Unit — native-command executors (`native-commands/__tests__`):** `clear`
calls `startFreshSession` and navigates, sends no message; `context` calls
`focusUsageSurface`; both return `{ handled: true, ran: true }`; `compact`
recognition calls `transport.runCommandIntent` when supported and `notify` +
no-send when unsupported (mock `useCapabilitiesForRuntime`).

**Server — route (`routes/__tests__/command-intents.test.ts`):** supported
runtime → drives `executeCommandIntent`, returns 202, events reach the projector
(`collectDurableEvents`); unsupported runtime → honest error, adapter not called;
unknown `:intent` → 422.

**Runtime conformance (`packages/test-utils/src/runtime-conformance.ts`):**
extend the capabilities block to assert `commandIntents` is present and every
`RuntimeCommandIntentId` key is a `{ supported: boolean }`; assert that a runtime
declaring `commandIntents.compact.supported` yields a `compact_boundary` (or a
terminal event) from `executeCommandIntent`, and one declaring it unsupported
throws. `FakeAgentRuntime` gains `commandIntents` + `executeCommandIntent`
(synthetic boundary) so every runtime's suite passes and validation criterion 3
is met.

**E2E (`apps/e2e`, optional but recommended):** in the cockpit, open the inline
palette on a claude-code session, assert one `/compact` row with an alias hint;
switch to a codex session, assert the `/compact` row is disabled "Not supported
by Codex". (test-mode runtime backs the browser run.)

Each test carries a purpose comment; no always-pass tests.

## Performance Considerations

Negligible. `resolveCommandIntent` is a lookup over a 3-entry static registry per
submit/keystroke. Capabilities are already cached client-side
(`staleTime: Infinity`). Compaction cost is the runtime's, unchanged. `context`
reads an already-streamed `UsageStatus` — no fetch.

## Security Considerations

None new. Intents are a fixed in-code registry (no user-defined executors — no
injection surface, same posture as ADR-0300). The compact route performs the
same authenticated session dispatch a turn does. OpenCode's `summarize` call is
SDK-confined and operates only on the caller's own session id.

## Documentation

- Inline TSDoc on every new export (Hard Rule 4).
- A short user-facing slash-command reference entry (docs/) once the native set
  is three-plus is worthwhile but optional for this spec; UI microcopy
  (descriptions, disabled reason, unsupported toast) follows `writing-for-humans`.
- Reconcile the stale `specs/sdk-command-discovery` (#133) `04-implementation.md`
  to `superseded`/`implemented` (housekeeping flagged in ideation; not gating).

## Implementation Phases

- **Phase 1 — shared foundation:** `command-intents.ts` (registry + resolver +
  types), subpath export, `RuntimeCapabilities.commandIntents` +
  `CommandIntentSupport`, `AgentRuntime.executeCommandIntent`,
  `Transport.runCommandIntent`. Update `FakeAgentRuntime` + conformance so the
  workspace compiles.
- **Phase 2 — server fulfillment:** four caps constants gain `commandIntents`;
  `executeCommandIntent` on claude-code / opencode / codex / test-mode; the
  compact route + projector wiring; route + OpenAPI registration; server tests.
- **Phase 3 — client:** palette dedupe (token + alias) + intent entries + alias
  hint reuse; honest disabled gating via `useCapabilitiesForRuntime`;
  `clear` + `context` native executors + `NativeCommandContext` capabilities;
  `compact` recognition + `runCommandIntent` dispatch + unsupported toast;
  client tests.
- **Phase 4 — verification:** e2e palette dedupe + gating; docs microcopy;
  #133 04-doc reconciliation.

## Acceptance Criteria

Mapped to DOR-109's three validation criteria:

- [ ] **VC1 — "Typing `/compress` or `/summarize` on the Claude runtime triggers
      compaction."** On a claude-code session, `/compress` or `/summarize` + Enter
      compacts (a `compact_boundary` appears); composer clears. **Extended by
      Decision 1:** the same works on an opencode session (via `session.summarize`).
- [ ] **VC2 — "Palette shows one entry per intent with alias hints, no
      duplicates."** The inline `/` palette lists exactly one row per intent; the
      native runtime command is deduped (by token _and_ alias); an alias query shows
      "matched /{alias}".
- [ ] **VC3 — "`RuntimeCapabilities` cleanly gates intents per runtime (verified
      with `FakeAgentRuntime`)."** `commandIntents` gates `compact`: claude-code +
      opencode enabled, codex disabled ("Not supported by Codex"); conformance +
      `FakeAgentRuntime` verify the gate and dispatch.
- [ ] `clear` opens a fresh session in the same project (linked back), identical
      on all three runtimes, no model turn.
- [ ] `context` opens/focuses the DOR-100 usage & cost surface, identical on all
      three runtimes, no model turn; honest empty state when no usage yet.
- [ ] An unsupported intent typed in the composer surfaces "not supported by
      {runtime}" and is never sent as text (no silent no-op).
- [ ] `trigger-turn.ts` and the DOR-107 guard (`message-sender.ts:343-377`) are
      unchanged; no `/compact`-specific logic is split across two layers.

## Open Questions

All ideation Open Questions were resolved by the LOCKED operator decisions:

- ~~**A. OpenCode `compact` — wire now or defer?**~~ **(RESOLVED — Operator
  Decision 1)** Wire now, via `client.session.summarize` (verified in
  `@opencode-ai/sdk@1.17.13`). Rationale: all three runtimes fulfill `compact`
  day one; higher-value demo; the mechanism is a single confined SDK call.
- ~~**B. `context` intent vs. DOR-100.**~~ **(RESOLVED — Operator Decision 2)**
  `context` is a DorkOS-native action that opens/focuses the shipped DOR-100
  `UsageStatus` surface — identical across runtimes, same philosophy as `clear`.
  Rationale: coherent single surface; avoids a Claude-only command that everyone
  else shows disabled.
- ~~**C. Palette-merge scope — inline vs. global Cmd+K.**~~ **(RESOLVED —
  Operator Decision 3)** Inline `/` slash palette only; global Cmd+K is a
  fast-follow. Rationale: inline is where these tokens are typed; global adds
  surface for little muscle-memory value.

No floor-level blockers remain — direction is fully pinned.

## Related ADRs

- **ADR-0273** (runtime-neutral context injection) — the boundary precedent;
  DOR-109 is its named command sibling ("neutral intent down, per-runtime
  expansion in the adapter"). This spec is its follow-through for commands.
- **ADR-0256** (structured capabilities first-class) — mandates
  `commandIntents` as a first-class sibling of `permissionModes`, not the
  `features` bag.
- **ADR-0300** (client-side native command dispatch) — the seam `clear` +
  `context` route through.
- **ADR-0264** (trigger-only turn / single delivery) — compaction events ride
  `/events` via the projector, consistent with turns.
- **Proposed ADR (extract at `/adr:from-spec`):** _"Canonical command intents +
  cross-agent alias resolution"_ — promotes ADR-0273's command clause from
  principle to contract: the shared alias→intent registry, the two-seam split
  (runtime-fulfilled `compact` via `commandIntents` + `executeCommandIntent`;
  client-native `clear`/`context`), and the Option-(b) chokepoint decision
  (DOR-107 guard retained, disjoint ownership).

## References

- DOR-109 (issue) — the work item; three validation criteria above.
- DOR-100 (`runtime-usage-status`) — the `UsageStatus` surface `context` opens.
- DOR-107 — bare slash dispatch + command-skip guard (`message-sender.ts:343-377`).
- DOR-108 — `CommandEntry.aliases` (SDK-native aliases; reused for cross-agent).
- DOR-119 / DOR-120 — ranker + "matched /{alias}" provenance
  (`rank-command.ts`, `CommandPalette.tsx:89-93`).
- DOR-128 / ADR-0300 — native-command seam (`native-commands/registry.ts`).
- DOR-114 — emulated compaction for non-native runtimes (out of scope).
- `@opencode-ai/sdk@1.17.13` `Session.summarize` — `POST /session/{id}/summarize`.
- `@openai/codex-sdk@0.142.5` `Thread.run` — no compaction API (verified).
- `specs/universal-command-intents/01-ideation.md` — ideation + six decisions.
  </content>
  </invoke>
