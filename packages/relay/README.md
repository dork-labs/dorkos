# @dorkos/relay

## Purpose

The inter-agent message bus — Relay, the "communication" half of DorkOS. It lets agents reach the channels you already use (Telegram, Slack, webhooks, the browser) and reach each other across project boundaries, with delivery that survives a closed terminal.

`RelayCore` composes the building blocks: NATS-style subject matching, Maildir-based persistence, a SQLite index, budget-envelope enforcement, ephemeral signals, pattern-based access control, and a pluggable adapter registry. Reliability is first-class — rate limiting, circuit breaking, backpressure, and a dead-letter queue all ship in the box.

This package is transport and storage; the higher-level wiring (which agents, which endpoints) lives in `@dorkos/mesh` and the server.

## Exports

| Export      | Purpose                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `.`         | `RelayCore` + the full public surface (stores, adapters, reliability, types) |
| `./testing` | Compliance suite and mocks for adapter authors and integration tests         |

Key pieces under the `.` barrel:

| Area          | Exports                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Core          | `RelayCore`, `RELAY_ADAPTER_API_VERSION`                                                                                          |
| Persistence   | `MaildirStore`, `SqliteIndex`, `DeadLetterQueue`                                                                                  |
| Routing       | `validateSubject`, `matchesPattern`, `parseAgentSubject`                                                                          |
| Access/budget | `AccessControl`, `enforceBudget`, `createDefaultBudget`, `SignalEmitter`                                                          |
| Reliability   | `checkRateLimit`, `CircuitBreakerManager`, `checkBackpressure`                                                                    |
| Adapters      | `AdapterRegistry`, `BaseRelayAdapter`, `RuntimeAdapter`, `TelegramAdapter`, `SlackAdapter`, `WebhookAdapter`, `ClaudeCodeAdapter` |
| Plugin loader | `loadAdapters`, `validateAdapterShape`                                                                                            |

## Usage

```ts
import { RelayCore } from '@dorkos/relay';

const relay = new RelayCore({ dorkHome: '/abs/path/.dork' });
await relay.publish('relay.agent.<sessionId>', { text: 'CI is green' });
const unsubscribe = relay.subscribe('relay.agent.>', (msg) => handle(msg));
```

Authoring a channel adapter? Extend `BaseRelayAdapter` and validate it against the shared compliance suite:

```ts
import { runComplianceSuite } from '@dorkos/relay/testing';
```

## Conventions

- Subjects are NATS-style and dot-delimited; agent subjects tolerate both legacy (`relay.agent.<sessionId>`) and runtime-scoped (`relay.agent.<runtimeType>.<sessionId>`) shapes — always go through `parseAgentSubject`.
- Adapters must declare a manifest and pass the compliance suite. The `TestModeAdapter` is a permanent CI fixture proving the `RuntimeAdapter` base stays runtime-agnostic (ADR 0257).
