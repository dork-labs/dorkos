# @dorkos/a2a-gateway

## Purpose

Exposes DorkOS agents as A2A (Agent2Agent) protocol-compliant endpoints so agents from other vendors can discover and talk to them. It generates Agent Cards from the Mesh registry, bridges each inbound A2A request onto the Relay bus (translating the message to a Relay `StandardPayload`, publishing it to the target agent's subject, and accumulating the streamed reply events into an A2A task result), and persists task state in SQLite.

This package is the protocol bridge only. It owns no agents and no transport — it sits between an inbound A2A request and the existing Mesh + Relay machinery.

## Exports

Single `.` barrel:

| Export                                                                                      | Purpose                                                                                  |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `createA2aHandlers`                                                                         | Express handlers (fleet card, per-agent card, JSON-RPC) wiring the gateway into a server |
| `DorkOSAgentExecutor`                                                                       | `AgentExecutor` bridging one A2A request to a Relay publish + reply stream               |
| `SqliteTaskStore`                                                                           | `TaskStore` implementation persisting A2A task lifecycle state via Drizzle               |
| `generateAgentCard`, `generateFleetCard`                                                    | Build A2A Agent Cards from Mesh `AgentManifest`s                                         |
| `a2aMessageToRelayPayload`                                                                  | Translate an inbound A2A Message into a Relay `StandardPayload`                          |
| `AgentRegistryLike`, `CardGeneratorConfig`, `ExecutorDeps`, `A2aHandlerDeps`, `A2aHandlers` | Supporting types                                                                         |

## Usage

Consumed by the server's A2A route (`apps/server/src/routes/a2a.ts`):

```ts
import { createA2aHandlers } from '@dorkos/a2a-gateway';

const handlers = createA2aHandlers({
  agentRegistry: meshCore, // MeshCore, or anything AgentRegistryLike
  relay: relayCore,
  db,
  config: { baseUrl: 'http://localhost:4242', version: '0.0.0' },
});

app.get('/.well-known/agent-card.json', handlers.fleetCard); // A2A spec discovery path
app.get('/a2a/agents/:id/card', handlers.agentCard); // per-agent cards
app.use('/a2a', handlers.jsonRpc); // JSON-RPC 2.0 (message/send, message/stream, tasks/*)
```

`handlers.jsonRpc` is an Express router with an internal `POST /` route — mount it with `app.use()` (or as a handler on a router whose own path has already been stripped), not `app.post('/a2a', ...)`.

## How a request flows

1. `message/send` / `message/stream` arrives at the JSON-RPC handler and the SDK's `DefaultRequestHandler` invokes `DorkOSAgentExecutor.execute()`.
2. The executor publishes the initial A2A `Task` event (state `submitted`) so the task is persisted before anything else, resolves the target agent (`message.metadata.agentId`, then `task.metadata.agentId`, then the first registered agent), and subscribes to a per-execution reply subject `relay.a2a.reply.{taskId}.{nonce}`.
3. The translated payload is published to `relay.agent.{namespace}.{agentId}`; the responding adapter streams one Relay envelope per StreamEvent back to the reply subject, terminated by a `done` event.
4. The executor accumulates `text_delta` events (validated with Zod in `reply-events.ts`) and completes the task exactly once with the full response text; stream errors, delivery failures, and the 2-minute timeout fail the task with the real diagnostic in the status message.
