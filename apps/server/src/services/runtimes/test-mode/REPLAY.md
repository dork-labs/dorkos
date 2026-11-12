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
Copy the selected fixture into the marked home before launch. Demo-boot itself is separate work.
