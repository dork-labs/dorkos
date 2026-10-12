# @dorkos/a2a-gateway

## Purpose

Exposes DorkOS agents as A2A (Agent2Agent) protocol-compliant endpoints so agents from other vendors can discover and talk to them. It generates Agent Cards from the Mesh registry, bridges each inbound A2A request onto the Relay bus (translating the message to a Relay `StandardPayload`, publishing it to the target agent's subject, and accumulating the streamed reply events into an A2A task result), and persists task state in SQLite.

This package is the protocol bridge only. It owns no agents and no transport — it sits between an inbound A2A request and the existing Mesh + Relay machinery.

## Exports

Single `.` barrel:

| Export                                                                                                      | Purpose                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `createA2aGateway`                                                                                          | Fetch-style handlers (fleet card, per-agent card, both JSON-RPC endpoints), no web framework |
| `DorkOSAgentExecutor`                                                                                       | `AgentExecutor` bridging one A2A request to a Relay publish + reply stream                   |
| `SqliteTaskStore`                                                                                           | `TaskStore` implementation persisting A2A task lifecycle state via Drizzle                   |
| `generateAgentCard`, `generateFleetCard`                                                                    | Build A2A Agent Cards from Mesh `AgentManifest`s                                             |
| `a2aMessageToRelayPayload`                                                                                  | Translate an inbound A2A Message into a Relay `StandardPayload`                              |
| `AgentRegistryLike`, `CardGeneratorConfig`, `ExecutorDeps`, `A2aGateway`, `A2aGatewayDeps`, `A2aRpcOptions` | Supporting types                                                                             |

## Usage

Consumed by the server's A2A routes (`apps/server/src/routes/a2a.ts`), which mount it on Hono. Each handler takes a web `Request` and returns a web `Response`, so any router that speaks fetch can host it:

```ts
import { createA2aGateway } from '@dorkos/a2a-gateway';

const gateway = createA2aGateway({
  agentRegistry: meshCore, // MeshCore, or anything AgentRegistryLike
  relay: relayCore,
  db,
  config: { baseUrl: 'http://localhost:4242', version: '0.0.0' },
});

app.get('/.well-known/agent-card.json', () => gateway.fleetCard()); // A2A spec discovery path
app.get('/a2a/agents/:id/card', (c) => gateway.agentCard(c.req.param('id'))); // per-agent cards
app.post('/a2a/agents/:id', (c) => gateway.agentJsonRpc(c.req.param('id'), c.req.raw)); // one agent
app.post('/a2a', (c) => gateway.jsonRpc(c.req.raw)); // the fleet: needs metadata.agentId
```

A host that already parsed the JSON body passes it as `{ parsedBody }`, and the gateway never reads the request stream. Streaming methods answer with an SSE `Response` whose body is read as the agent replies.

## How a request flows

1. `message/send` / `message/stream` arrives at the JSON-RPC handler and the SDK's `DefaultRequestHandler` invokes `DorkOSAgentExecutor.execute()`.
2. The executor publishes the initial A2A `Task` event (state `submitted`) so the task is persisted before anything else, resolves the target agent (`message.metadata.agentId`, then `task.metadata.agentId`, then the first registered agent), and subscribes to a per-execution reply subject `relay.a2a.reply.{taskId}.{nonce}`.
3. The translated payload is published to `relay.agent.{namespace}.{agentId}`; the responding adapter streams one Relay envelope per StreamEvent back to the reply subject, terminated by a `done` event.
4. The executor accumulates `text_delta` events (validated with Zod in `reply-events.ts`) and completes the task exactly once with the full response text; stream errors, delivery failures, and the 2-minute timeout fail the task with the real diagnostic in the status message.
