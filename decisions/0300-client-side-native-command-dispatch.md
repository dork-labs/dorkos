---
number: 300
title: Client-side native command dispatch in the web chat
status: accepted
created: 2026-06-26
spec: web-chat-native-commands
superseded-by: null
---

# 300. Client-side native command dispatch in the web chat

## Status

Accepted (implemented in spec: web-chat-native-commands)

## Context

The web chat had two command systems and no home for a third. Runtime commands
come from `runtime.getCommands()` (the SDK `supportedCommands()` set plus
filesystem metadata, spec #133); their `CommandEntry` carries display metadata
only, and selecting one inserts text that is POSTed to the runtime. The Cmd+K
command palette (specs #85/#87, ADR-0063) is a separate client system whose
contributions dispatch via a hardcoded action switch for app navigation; its
non-goals explicitly exclude inline slash commands. Neither can host a
**client-only** slash command — one DorkOS executes locally and must never send
to the model (e.g. `/rename`, which only needs the existing session-rename
mutation). All typed text, slash or not, went straight to the runtime
(`use-session-submit.ts`).

## Decision

Introduce a third command category — **native chat commands** — as a minimal,
extensible client-side registry, and intercept it at the chat send funnel:

- A static registry (`features/chat/model/native-commands/registry.ts`, a pure
  no-hooks module): each `NativeCommand` carries
  `{ name, description, argHint, run(args, ctx): boolean }` (the `run` boolean
  reports whether the command performed its action vs was rejected), plus
  `parseNativeCommand` (registry lookup on the leading `/token`) and the
  `NATIVE_COMMAND_ENTRIES` constant (projection to `CommandEntry` for autocomplete).
- A `useNativeCommands(cwd, sessionId)` hook (`native-commands/use-native-commands.ts`)
  that wires command capabilities (for `/rename`: the existing `useRenameSession`
  mutation + a success toast fired from the mutation's `onSuccess`) and returns
  `tryRun(content) → NativeCommandResult` (`{ handled }`, plus `ran` when handled).
- Interception at two points: the **top of `executeSubmission`** (the send funnel
  for the Enter and retry paths) and the **queue decision** (`useChatQueue.handleQueue`)
  so a native command typed while a turn streams runs instantly rather than being
  queued — a queued native command flushes without starting a turn and would stall
  the streaming→idle flush pump. Either way the input clears only when the command
  actually ran, and the command never reaches the model.
- Native entries are **blended into** the existing autocomplete `commands` array;
  selection and ranking are unchanged.

Native commands stay deliberately separate from runtime commands (different
source, never sent to the model) and from the Cmd+K palette (different surface,
no app-nav action model).

## Consequences

### Positive

- Gives client-only commands a real, single home; the next native command is one
  registry entry.
- Reuses the existing rename capability and autocomplete with no server, shared,
  or schema changes.
- Interception at the send funnel guarantees a native command never reaches the
  runtime, on every submit path.

### Negative

- A third command concept now coexists with runtime commands and the palette;
  contributors must know which surface a new command belongs to.
- The registry is in-code only (no user-defined native commands) — intentional
  for now (no injection surface), but a constraint if external extensibility is
  later wanted.

## Alternatives Considered

- **One-off `/rename` branch** (no registry): least code, but leaves the
  "where do native commands live" gap unsolved and repeats the plumbing for the
  next command. Rejected.
- **Unify with the Cmd+K palette**: one command system, but reverses the
  deliberate #85/#87 separation and mixes app-navigation actions with chat-input
  argument parsing. Rejected.

## References

- spec: `specs/web-chat-native-commands/02-specification.md`
- DOR-128; DOR-80 (rename capability); specs #85/#87, #133; ADR-0063, ADR-0085,
  ADR-0089.
