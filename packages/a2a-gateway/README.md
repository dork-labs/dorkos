# @dorkos/a2a-gateway

## Purpose

Exposes DorkOS agents as A2A (Agent2Agent) protocol-compliant endpoints so agents from other vendors can discover and talk to them. It generates Agent Cards from the Mesh registry, translates A2A requests into Relay publishes (and Relay status back into A2A task states), and persists task state in SQLite.

This package is the protocol bridge only. It owns no agents and no transport — it sits between an inbound A2A request and the existing Mesh + Relay machinery.

## Exports

Single `.` barrel:

| Export                                                                           | Purpose                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `generateAgentCard`, `generateFleetCard`                                         | Build A2A Agent Cards from the Mesh registry           |
| `a2aMessageToRelayPayload`, `relayPayloadToA2aMessage`, `relayStatusToTaskState` | Translate between the A2A and Relay schemas            |
| `SqliteTaskStore`                                                                | Persist A2A task lifecycle state                       |
| `DorkOSAgentExecutor`                                                            | Execute an inbound A2A request against a DorkOS agent  |
| `createA2aHandlers`                                                              | Express handlers that wire the gateway into the server |

## Usage

Consumed by the server's A2A route (`apps/server/src/routes/a2a.ts`):

```ts
import { createA2aHandlers } from '@dorkos/a2a-gateway';

const handlers = createA2aHandlers({ registry, relay, taskStore });
app.use('/a2a', handlers.router);
```
