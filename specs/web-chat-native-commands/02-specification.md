---
slug: web-chat-native-commands
number: 265
created: 2026-06-26
status: implemented
linearIssue: DOR-128
---

# Web Chat Native Commands (client-side `/rename`)

**Status:** Implemented
**Author:** Dorian Collier
**Date:** 2026-06-26
**Tracker:** DOR-128 (Universal Command Interface project)

## Overview

Add a seam for **client-side ("DorkOS-native") chat commands** — slash commands
that DorkOS executes locally and never sends to the runtime/model — and ship
`/rename` as the first such command. `/rename <new title>` renames the current
session by reusing the existing rename capability (DOR-80), producing no user
message and no model turn.

Today the web chat has no client-side command dispatch: every typed line, slash
or not, is POSTed to the runtime (`use-session-submit.ts`), and the slash
autocomplete entries (`CommandEntry`) carry only display metadata, no executor.
This spec introduces a minimal, extensible **native-command registry**, a
**send-path interception** branch, and an **autocomplete blend**.

## Background / Problem Statement

Typing `/rename` in the web chat does nothing useful: it is a Claude Code
terminal-CLI local command with no SDK/runtime executor, so the literal text is
sent to the model, which replies "I don't have a `/rename` command…" (verified in
transcript `e323877c`, entrypoint `sdk-ts`: the `/rename` was recorded as a plain
`user` message with zero `system/local_command` records).

The rename **capability** already exists — sidebar right-click → Rename (DOR-80),
backed by `useRenameSession` → `transport.updateSession(sessionId, { title })`.
What is missing is a way to trigger it from the chat input without the text
reaching the model. More fundamentally, DorkOS has no home for a client-only
command. This work establishes that seam (the gap the DOR-128 design note flagged,
overlapping DOR-104 `ui_command` and DOR-119/120 palette).

## Goals

- A reusable client-side native-command registry: each command carries a name,
  description, argument hint, and an executor; adding a future native command is
  a single registry entry.
- `/rename <new title>` renames the current session via the existing
  `useRenameSession` path — no user bubble, no model turn.
- `/rename` appears in the chat slash autocomplete with a description and an
  argument hint.
- Empty/whitespace title is rejected gracefully with a usage hint (no rename, no
  send).
- The rename reflects immediately in the sidebar (optimistic update, parity with
  sidebar rename).

## Non-Goals

- Other local commands (`/usage`, `/resume`, `/export`, `/model`, …) — only the
  registry + `/rename`.
- Runtime command aliasing / canonical cross-agent intents (DOR-109).
- Unifying with the Cmd+K command palette (specs #85/#87) — deliberately kept
  separate.
- A no-argument inline-rename affordance. **Decision 2 (ideation): `/rename` with
  no title is a no-op with a usage hint.** This overrides DOR-128's original
  acceptance criterion "no-arg opens the inline rename UI" — the issue's ACs are
  updated to match (see User Experience).
- A chat-panel session-title header (none exists today).
- Visual badging of native vs runtime commands in the autocomplete (optional
  future polish).

## Technical Dependencies

- `sonner` (`toast`) — already used by `useRenameSession`; reused for command
  feedback (success + usage hint).
- `@dorkos/shared/types` — `CommandEntry` (autocomplete entry shape).
- No new external dependencies.

## Detailed Design

### Architecture changes

A new, third command category sits beside the two existing ones (runtime commands
from `runtime.getCommands()`, spec #133; Cmd+K palette actions, specs #85/#87):
**native chat commands**, executed entirely in the client. They are intercepted
at the chat send funnel before any runtime POST.

### Code structure & file organization

New — a `native-commands/` sub-module under
`apps/client/src/layers/features/chat/model/` (`registry.ts`,
`use-native-commands.ts`, `index.ts` barrel, `__tests__/`):

- `native-commands/registry.ts` — pure, no hooks:
  - `interface NativeCommandContext { sessionId: string | null; renameSession: (title: string) => void; notify: (message: string, kind?: 'error' | 'success') => void; }`
  - `interface NativeCommand { name: string; description: string; argHint?: string; run: (args: string, ctx: NativeCommandContext) => boolean; }` —
    `run` returns `true` when it performed its action and `false` when rejected
    (e.g. a missing argument), so the send path can keep the composer text on a
    rejection. The `rename` executor collapses internal whitespace and caps the
    title length before renaming.
  - `const NATIVE_COMMANDS: NativeCommand[]` — the `rename` command only.
  - `parseNativeCommand(content: string): { command: NativeCommand; args: string } | null`
    — matches a leading `/<token>` against the registry (case-insensitive),
    returns the command + trimmed remainder, or `null` when the token is not a
    registered native command (so unknown `/...` falls through to the runtime).
  - `const NATIVE_COMMAND_ENTRIES: CommandEntry[]` — `NATIVE_COMMANDS` projected
    into `CommandEntry` rows (`fullCommand: '/rename'`, `description`,
    `argumentHint`) for the autocomplete blend. A module-level constant (stable
    reference) so the blend memo does not rebuild it each render.
- `native-commands/use-native-commands.ts`:
  - `useNativeCommands(cwd: string | null, sessionId: string | null): { tryRun: (content: string) => NativeCommandResult }`
    where `NativeCommandResult = { handled: false } | { handled: true; ran: boolean }`
    — calls `useRenameSession(cwd)`, builds a `NativeCommandContext` (the
    `renameSession` capability fires the mutation and a success toast from the
    mutation's `onSuccess`, so a failed rename does not flash a false success;
    `notify` wraps `toast`), and returns `tryRun`, which parses `content` and, on
    a match, runs the executor and returns `{ handled: true, ran }`; otherwise
    `{ handled: false }` (falls through to the runtime).

Modified:

- `use-session-submit.ts` — add
  `tryNativeCommand: (content: string) => NativeCommandResult` to
  `UseSessionSubmitParams`; at the **top of `executeSubmission`**, before any
  optimistic state or POST:
  ```ts
  // Native (client-side) command: runs locally, never reaches the runtime/model.
  const native = tryNativeCommand(content);
  if (native.handled) {
    if (clearInput && native.ran) setInput('');
    return;
  }
  ```
  This is the funnel safety net for the non-streaming paths — `handleSubmit`
  (Enter) and `retryMessage`. The input clears only when the command actually
  ran, so a rejected `/rename` keeps its text.
- `use-chat-queue.ts` — intercept native commands at the **queue decision**
  (`handleQueue`) before enqueuing, so a `/rename` typed while a turn streams runs
  instantly and never enters the queue. (A queued native command would flush
  without starting a turn, breaking the streaming→idle flush pump and stalling
  every message queued behind it.)
- `use-chat-session.ts` — call `useNativeCommands(selectedCwd, sessionId)`, pass
  `tryNativeCommand: native.tryRun` into `useSessionSubmit`, and expose it on the
  hook's return so the queue path (via `ChatInputContainer` → `useChatQueue`) can
  reach it.
- `ChatPanel.tsx` — blend native entries into the autocomplete source, native
  first, dropping any runtime command whose token collides with a native one so
  the palette never lists it twice:
  ```ts
  const allCommands = useMemo(() => {
    const nativeTokens = new Set(NATIVE_COMMAND_ENTRIES.map((e) => e.command));
    const runtime = (registry?.commands ?? []).filter((c) => !nativeTokens.has(c.command));
    return [...NATIVE_COMMAND_ENTRIES, ...runtime];
  }, [registry]);
  ```

### Parsing semantics

`parseNativeCommand` uses `^\/(\S+)(?:\s+([\s\S]*))?$` on the already-trimmed
content. `/rename My Title` → `{ name: 'rename', args: 'My Title' }`; `/rename` →
`{ name: 'rename', args: '' }`; `/renamefoo` → token `renamefoo`, not in the
registry → `null` (falls through). Token match is case-insensitive.

### `/rename` executor

```ts
run: (args, ctx) => {
  // Collapse internal whitespace (Shift+Enter newlines included) + cap length.
  const title = args.replace(/\s+/g, ' ').trim().slice(0, MAX_RENAME_TITLE_LENGTH).trim();
  if (!title) {
    ctx.notify('Usage: /rename <new title>', 'error');
    return false; // rejected — caller keeps the composer text
  }
  if (!ctx.sessionId) {
    ctx.notify('No active session to rename', 'error');
    return false;
  }
  ctx.renameSession(title); // useRenameSession.mutate(...) + success toast on onSuccess
  return true;
};
```

`useRenameSession` already does the optimistic cache update, rollback, and error
toast; the `renameSession` capability adds a success toast
(`Renamed session to "…"`) from the mutation's `onSuccess`, so a failed rename
shows only the rollback error — never a false success.

### API / data model changes

None. No server, shared-package, or schema changes. `transport.updateSession`
(the existing rename transport) is reused unchanged.

## User Experience

- **Discovery:** typing `/` shows the slash autocomplete; `/rename` appears with
  description "Rename the current session" and hint `<new title>`. Selecting it
  inserts `/rename ` (existing autocomplete behavior).
- **`/rename My Title` + Enter:** the session is renamed to "My Title"
  immediately (optimistic); the sidebar row updates; a success toast confirms. No
  user bubble, no assistant turn.
- **`/rename` (no title) + Enter:** no rename, no message sent; a toast shows
  `Usage: /rename <new title>`. (Overrides the original no-arg AC.)
- **Whitespace-only title:** treated as empty (usage hint).
- **Unknown `/foo`:** unchanged — sent to the runtime as today.

### Acceptance criteria (updated)

- [x] `/rename` appears in the chat slash autocomplete with a description and an
      argument hint.
- [x] `/rename My Title` renames the current session with no message sent to the
      model (no user bubble, no assistant turn).
- [x] `/rename` with **no argument** is a no-op that shows a usage hint
      (`Usage: /rename <new title>`). _(Replaces the original "opens inline rename UI"
      criterion per ideation Decision 2.)_
- [x] The rename reflects immediately in the sidebar (parity with sidebar rename).
- [x] Empty/whitespace title is rejected gracefully (usage hint), matching
      sidebar validation.

## Testing Strategy

- **Unit — registry** (`native-commands/__tests__/registry.test.ts`):
  - `parseNativeCommand`: `/rename Foo` → command + `args: 'Foo'`; `/rename` →
    `args: ''`; `/renamefoo` → `null`; `/RENAME Foo` → matches (case-insensitive);
    non-slash text → `null`; leading/trailing whitespace handled.
  - `NATIVE_COMMAND_ENTRIES`: one entry with `fullCommand '/rename'`, a
    description, and an `argumentHint`; a stable module-level reference.
- **Unit — `useNativeCommands`** (`native-commands/__tests__/use-native-commands.test.tsx`,
  `renderHook` + mock transport):
  - `/rename Foo` → calls `transport.updateSession(sessionId, { title: 'Foo' })`,
    returns `{ handled: true, ran: true }`, success toast fires after success.
  - Failed `updateSession` → error toast, **no** success toast.
  - Multi-line title → collapsed to a single line before renaming.
  - `/rename` (no arg) → no `updateSession`, `{ handled: true, ran: false }`, usage toast.
  - `/rename Foo` with `sessionId === null` → no `updateSession`,
    `{ handled: true, ran: false }`, error toast.
  - `/unknown` and plain text → `{ handled: false }` (falls through).
- **Mocking:** mock `Transport` via `createMockTransport`; assert `updateSession`
  / `postMessage` spy calls. Each test carries a purpose comment.

## Performance Considerations

Negligible. One synchronous registry lookup (`parseNativeCommand`) per submit;
the registry is a tiny static array.

## Security Considerations

None new. The command performs the same authenticated `updateSession` the sidebar
rename already performs. Native commands are a fixed in-code registry (no
user-defined executors), so there is no injection surface.

## Documentation

Inline TSDoc on the new exports. No external doc changes required for a single
command; a user-facing slash-command reference can follow when the native set
grows.

## Implementation Phases

- **Phase 1 — registry + `/rename` (this spec):** the `native-commands/`
  sub-module (`registry.ts`, `use-native-commands.ts`, `index.ts`), the
  `executeSubmission` + `useChatQueue` interceptions, the `useChatSession` wiring,
  the autocomplete blend, and tests.

## Open Questions

None. Ideation Decisions 1–4 resolved the architecture, no-arg behavior,
execution semantics, and empty-title handling.

## Related ADRs

- ADR-0300 (draft, seeded by this spec) — Client-side native command dispatch in
  the web chat.
- ADR-0085 (Agent Runtime Interface), ADR-0089 (SDK Import Confinement) — context
  for why runtime commands are server/runtime-owned and native commands are
  client-only.

## References

- DOR-128 (issue) — the work item.
- DOR-80 — existing sidebar session rename (capability reused).
- DOR-126 — render local-command output (surfaced this gap).
- DOR-109 — canonical cross-agent intents (the 3-intent scope `/rename` sits
  outside of).
- DOR-104 — producer-less `ui_command` event (agent→client; separate direction).
- DOR-119 / DOR-120 — command palette ranking & alias provenance.
- specs/sdk-command-discovery (#133) — runtime command source.
- `specs/web-chat-native-commands/01-ideation.md` — ideation + decisions.
