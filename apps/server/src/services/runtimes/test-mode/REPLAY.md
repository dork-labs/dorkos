# Recorded demo source

Replay is a scenario source in `TestModeRuntime`. It has no tool dispatcher or model client.
It plays hand-authored, fictional recordings. Never put a real transcript in a recording.

Demo-boot owns creation of a throwaway `DORK_HOME` and its regular, non-symlink
`.dorkos-recorded-demo` marker. The server never creates that marker. Before launching:

- Put a recording JSON inside the demo home, such as `recordings/reply.json`.
- Set `DORKOS_TEST_RUNTIME=true` and `DORKOS_REPLAY_RECORDING=recordings/reply.json`.
- Set `DORK_HOME` to the marked home. Use isolated server/client ports, never 4242, 6242 or 6241.
- Keep every seeded agent and project inside the demo home. Disable outside history and room introductions.

The built-in `test-mode` runtime is registered as itself, `claude-code` and `codex`, so seeded
agent manifests need no new runtime type. All three are instances of `TestModeRuntime`.
A recorded source has a separate turn cursor per chat. A fresh chat starts at turn one;
reusing an exhausted chat refuses rather than calling a model. Test-control reset restarts it.

## Recording format

```json
{
  "version": 1,
  "title": "Sample chat",
  "turns": [{ "events": [{ "type": "text_delta", "data": { "text": "Sample reply" } }] }]
}
```

Allowed events: `text_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end`, `tool_result`.
Tool display data has `toolCallId`, `toolName`, `status` (`pending`, `running`, `complete`, `error`),
and optional string `input` and `result`. Names are display text, never looked up or dispatched.
Session identities and terminal events come from the runtime, never from the file.
Unknown fields, control events, and MCP UI references are rejected. Recorded generative widgets
are rejected, including fences split across events. Limits: 1 MiB/file, 100 turns, 1,000 events/turn, 64 KiB/display string.
Absolute paths, traversal, and symlink escapes are rejected.

The home realpath, home identity and regular marker identity are pinned at creation and checked
before every turn and display event. The real account's `.dork` directory and its descendants
are refused even if the process uses a fake `HOME`. A flag without test mode refuses startup.
A marker without a recording also refuses startup, rather than enabling a live runtime.

Relay and chat-app connections, connection backends, Cloud transports, and both kinds of tunnel
stay off regardless of seeded config. Isolation is latched until process exit. Replies and tool
displays carry `Recorded demo`; tracked chat titles retain that prefix across renames.

`__fixtures__/replay-connection-access.json` shows a fictional exclusion and reversal in two turns.
It changes no actual app access. `replay-codex-chat.json` shows a two-turn fictional Codex chat.

## Minimal demo boot

From a checkout with dependencies installed and workspace packages built:

```sh
pnpm --filter @dorkos/e2e demo:replay
pnpm --filter @dorkos/e2e demo:replay --recording connection-access
```

This e2e script starts the source server and Vite client, following the capture harness's
isolated-home pattern. It creates a fresh private folder under the mounted external drive's
`dork-os/test-homes/<date>-demo-*`, or the system temp directory when that drive is absent.
It never reuses or deletes an existing home. The regular marker is written last.

The fictional Harbor & Pine cast is Scout, Pixel, Atlas, Quill and Penny. Their fixed IDs
produce stable Block Buddy faces. Scout is the default; Atlas uses the test-mode Codex alias.
Maya Okafor is the fictional operator. Seeded fixture text uses this cast too.

The script inherits no model keys or sign-in overrides. Both children get a private account
home inside `DORK_HOME`. Heartbeats, schedules, room introductions, external history, update
checks and telemetry are off. Hello World and Linear Issues stay off. Startup still forces
DorkBot and the non-disableable Marketplace to exist; no extra system-agent work is seeded.
The five replay conditions and outbound guards are unchanged.

Two free loopback ports are chosen automatically. To choose an unused pair explicitly:

```sh
pnpm --filter @dorkos/e2e demo:replay --server-port 4644 --client-port 4643
```

The protected ports 4242, 6242 and 6241 are refused before binding. An occupied port fails;
no existing process is stopped. The printed URL opens the client. Both processes write logs
inside the demo home. Ctrl-C stops only their process groups; the home remains for inspection.
`--check` waits for server and client readiness, then stops them. This checks boot, not a
rendered browser capture. `--home` may name a new direct child of the selected demo-home root;
existing folders, symlinks and the real account's `.dork` (including descendants) are refused.
