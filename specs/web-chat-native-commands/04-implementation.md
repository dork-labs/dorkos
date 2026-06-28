# Implementation Summary: Web Chat Native Commands (client-side `/rename`)

**Created:** 2026-06-27
**Last Updated:** 2026-06-27
**Spec:** specs/web-chat-native-commands/02-specification.md
**Tracker:** DOR-128 (Universal Command Interface project)
**PR:** #55

## Progress

**Status:** Complete

Shipped the client-side native-command seam and `/rename` as the first command.
Native commands run entirely in the browser and never reach the runtime/model.

## What shipped

- A `native-commands/` sub-module under
  `apps/client/src/layers/features/chat/model/`: a pure `registry.ts` (the
  `NativeCommand` interface, the `NATIVE_COMMANDS` registry, `parseNativeCommand`,
  and the `NATIVE_COMMAND_ENTRIES` autocomplete projection), a
  `use-native-commands.ts` hook wiring the executor to `useRenameSession` + toast,
  and an `index.ts` barrel.
- Interception at two points so a native command never reaches the model: the
  `executeSubmission` funnel (Enter + retry) and the `useChatQueue.handleQueue`
  queue decision (so a command typed mid-stream runs instantly instead of being
  queued).
- `/rename <new title>` renames the current session via the existing optimistic
  rename mutation, with `/rename` blended into the slash autocomplete.

## Files created

- `apps/client/src/layers/features/chat/model/native-commands/registry.ts`
- `apps/client/src/layers/features/chat/model/native-commands/use-native-commands.ts`
- `apps/client/src/layers/features/chat/model/native-commands/index.ts`
- `apps/client/src/layers/features/chat/model/native-commands/__tests__/registry.test.ts`
- `apps/client/src/layers/features/chat/model/native-commands/__tests__/use-native-commands.test.tsx`
- `decisions/0300-client-side-native-command-dispatch.md`

## Files modified

- `apps/client/src/layers/features/chat/model/use-session-submit.ts` — native
  interceptor at the top of `executeSubmission` (clears input only when the
  command ran).
- `apps/client/src/layers/features/chat/model/use-chat-queue.ts` — native
  interceptor at the queue decision (`handleQueue`).
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — wires
  `useNativeCommands` and exposes `tryNativeCommand` for the queue path.
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — autocomplete blend
  (native-first, deduped) + passes `tryNativeCommand` down.
- `apps/client/src/layers/features/chat/ui/input/ChatInputContainer.tsx` — threads
  `tryNativeCommand` into `useChatQueue`.

## Acceptance criteria

All criteria in `02-specification.md` are met (autocomplete entry, message-free
rename, no-arg usage hint, immediate sidebar reflection, whitespace rejection).

## Review-driven refinements (PR #55 code review)

The shipped form incorporates fixes from the `/code-review` pass:

1. **Queue stall (high):** native commands are intercepted at the queue decision,
   so a command queued mid-stream no longer flushes without starting a turn and
   stalling messages behind it.
2. **Toast on success only:** the success toast fires from the rename mutation's
   `onSuccess`, so a failed rename shows only the rollback error, never a false
   success.
3. **Composer preserved on rejection:** `run` returns whether it acted; the input
   clears only when the command actually ran (a no-arg `/rename` keeps its text).
4. **Title normalization:** internal whitespace/newlines collapse to a single
   line and the title is length-capped.
5. **Autocomplete dedup + stable reference:** `NATIVE_COMMAND_ENTRIES` is a
   module constant blended native-first, dropping any colliding runtime command.

## Tests

- `registry.test.ts` — parser + `NATIVE_COMMAND_ENTRIES` (9 tests).
- `use-native-commands.test.tsx` — dispatch, success-toast-on-success-only,
  multi-line collapse, no-arg, no-session, fall-through (6 tests).
- `ChatInputContainer.test.tsx` updated for the new `tryNativeCommand` prop.

All client typecheck, lint, and the affected Vitest suites pass.
