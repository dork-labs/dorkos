---
title: 'Codex chat start paths: which ones carry an agent, and who sees the no-tools notice'
date: 2026-11-15
type: internal-architecture
status: active
tags: [codex, agent-identity, dorkos-tools, sessions, dor-4385, dor-4393]
---

# Codex chat start paths: which ones carry an agent

Research date: 2026-11-15. A census of every way a chat can start or continue, done for DOR-4385 (a Codex chat started without an agent gets no DorkOS tools, and nobody was told) and extended for DOR-4393 (a Codex chat that loses its tools partway through). Line numbers are navigation pointers at the time of writing; the function names are the stable part.

## The rule the census checks

Agentless starts stay agentless. DorkOS never infers or assigns an agent to a chat that was not started for one. A Codex chat with no DorkOS tools says so instead:

- **On start:** the receipt of `POST /api/sessions/:id/messages` with `create: true`, and the extension `startWork` result, carry a `NO_DORKOS_TOOLS` warning.
- **On every read:** `GET /api/sessions/:id` carries the same warning, so whoever opens the chat later sees it, however it was started.
- **Partway through (DOR-4393):** the Codex session row's `dorkosTools` field says `lost` when a completed turn's thread never fetched its tool list, and `back` once a later turn does, until the next message.

Whether a chat has its tools is the runtime's own answer (`carriesRoomTools`, the check the room posting guard uses), not "an agent folder exists": a chat bound to an agent Mesh no longer knows, or whose tool connection is down, gets the notice too. Every doubt shows the notice.

## Start paths

| Entry path                         | Where                                                                           | Agent handed over                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| New chat in the app                | `ChatPanel.tsx`, `use-session-submit.ts`                                        | Sends `agentPath` only for an exact registered composer agent; waits for the lookup. An ordinary unowned folder sends none. |
| HTTP message start                 | `routes/sessions.ts` (`POST /:id/messages`), `launch-session.ts`                | Validates a supplied `agentPath` against Mesh. Bound chats use their recorded agent.                                        |
| Spin-off (`session_start`)         | `claude-code/mcp-tools/session-tools.ts`                                        | Carries the calling agent's path; a different identity is refused.                                                          |
| Room seat                          | `rooms/room-turn-runner.ts`                                                     | Carries `request.agentPath` as `forAgent`.                                                                                  |
| Room re-seat                       | `rooms/reseat/seat-mover.ts`                                                    | Rebinds the same author to a fresh chat; the next room turn carries the seat's agent.                                       |
| Scheduled task (direct and relay)  | `tasks/task-scheduler-service.ts`, `relay/adapters/claude-code/task-handler.ts` | Carries `forAgent` when the placement is agent-backed.                                                                      |
| Heartbeat                          | `heartbeats/beat-launch.ts`                                                     | Explicit `agentPath`.                                                                                                       |
| Chat message to an agent           | `chat-messages/chat-message-service.ts`                                         | Carries the target agent's path when the target resolves to one.                                                            |
| Extension agent send               | `extensions/agent-send/agent-send.ts`                                           | Carries the resolved target agent.                                                                                          |
| Extension `startWork`              | `extensions/start-work.ts`                                                      | Names no agent by design; the launch warning is returned to the extension.                                                  |
| Extension browser API              | `extension-api-factory.ts` (`startWork`)                                        | Used to drop every field but `sessionId`; now returns the parsed warnings.                                                  |
| Carry-over to a fresh chat         | `session/fleet/carry-over.ts`                                                   | Verifies the source chat's recorded agent and carries it when present.                                                      |
| Model continuation, account resume | `session/fleet/continue-service.ts`, `resume-service.ts`                        | The existing chat id goes through shared launch, which recovers the recorded agent.                                         |
| Session relay                      | `core/session-relay/relay-request-server.ts`                                    | Shared launch; the receipt is machine-to-machine, so the read-side notice covers it.                                        |
| Relay binding                      | `relay/binding-subsystem.ts`, `relay/adapters/claude-code/agent-handler.ts`     | Supplies the bound agent when present; the read-side notice covers the rest.                                                |
| Fork                               | `routes/sessions.ts` (fork route)                                               | Closed for Codex: `CodexRuntime.forkSession` returns null.                                                                  |

## How Codex resolves identity

`codex-runtime.ts` computes a turn's identity with `identityPathFor(cwd, forAgent)`, which delegates to `resolveAgentHome` (`core/agent-identity/agent-home.ts`): the exact registered home, a managed workspace, a linked worktree, or an explicit `forAgent`. The recorded chat agent is recovered only for an unowned folder. None of this is grounds to assign a default agent.

## Losing the tools partway through (DOR-4393)

The signal is DOR-4384's: the connector listener records each answered `tools/list` on the thread's key, and a completed turn whose key has none means the thread never got its tools. On that signal, the chat row turns `lost` and the thread is marked so the next message reloads it as a fork with a fresh key and a fresh tools connection. That is why the notice says "It tries again with your next message." rather than offering a Reconnect button: nothing can prove the tools work again until a turn asks for them.
