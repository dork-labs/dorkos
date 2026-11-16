# Tasks — Web Chat Native Commands (client-side `/rename`)

**Spec:** `specs/web-chat-native-commands/02-specification.md` (#265) · **Slug:**
`web-chat-native-commands` · **Tracker:** DOR-128 · **Mode:** full ·
**Generated:** 2026-06-26

All work is one phase (single-session feature). Tests live alongside source in
`__tests__/`.

## Phase 1 — Native command registry

### Task 1.1: Create the native-command registry module + tests

`apps/client/src/layers/features/chat/model/native-commands.ts` (pure, no hooks):
`NativeCommandContext`, `NativeCommand`, `NATIVE_COMMANDS` (the `rename` command),
`parseNativeCommand`, `nativeCommandEntries`. Plus
`__tests__/native-commands.test.ts` covering parse matches/misses
(case-insensitive, `/renamefoo` → null) and the autocomplete projection.

- size: small · priority: high · deps: none

### Task 1.2: Create the `useNativeCommands` hook + tests

`use-native-commands.ts`: `useNativeCommands(cwd, sessionId) → { tryRun }`, wiring
`useRenameSession` + `sonner` toast into the `NativeCommandContext`. Plus
`__tests__/use-native-commands.test.tsx` (renderHook + mock Transport): rename
with title, no-arg usage hint, null-session guard, unknown/plain → false.

- size: small · priority: high · deps: 1.1

## Phase 2 — Send-path interception

### Task 1.3: Intercept native commands in `executeSubmission`

`use-session-submit.ts`: add `tryNativeCommand` param; at the top of
`executeSubmission`, return early (clearing input) when it handles the content —
covering Enter, queue auto-flush, and retry so a native command never reaches the
runtime.

- size: small · priority: high · deps: 1.1 · parallelWith: 1.2

## Phase 3 — Wiring

### Task 1.4: Wire `useChatSession` + blend autocomplete entries

`use-chat-session.ts`: call `useNativeCommands(selectedCwd, sessionId)`, pass
`tryNativeCommand` into `useSessionSubmit`. `ChatPanel.tsx`: blend
`nativeCommandEntries()` into the `allCommands` autocomplete source.

- size: small · priority: high · deps: 1.2, 1.3

## Verification (VERIFY stage)

`pnpm typecheck`, `pnpm lint`, and the client test suite (`pnpm vitest run` for the
new files + the chat model suite) must pass. Browser smoke of `/rename` is
optional (covered by unit tests of the executor + interception).
