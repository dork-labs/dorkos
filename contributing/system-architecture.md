# DorkOS system architecture

## Overview

This is the cross-system map of DorkOS: what runs where, how the pieces communicate, which interfaces are replaceable, and who owns the data. Start here, then use [the implementation guide](architecture.md) for local internals.

**Code snapshot:** `9688d2db0616efb03d503bc105ef40b7541dc30e`, reviewed 2026-09-16. “Implemented” below means present in this public source snapshot, not a claim that a hosted deployment or every platform has passed end-user verification. Cloud is described only through public app code and `packages/cloud-api`.

## Key Files

Paths are relative to this repository. These are evidence pointers for the diagrams, not a complete module inventory.

| Boundary                               | Source of truth                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local composition and routes           | [server startup](../apps/server/src/index.ts), [Express app](../apps/server/src/app.ts)                                                                                                                                                                                                                 |
| Client port and network implementation | [Transport](../packages/shared/src/transport.ts), [HttpTransport](../apps/client/src/layers/shared/lib/transport/http-transport.ts), [WSConnection](../apps/client/src/layers/shared/lib/transport/ws-connection.ts)                                                                                    |
| WebSocket and SSE delivery             | [upgrade router](../apps/server/src/services/core/streams/upgrade-router.ts), [session socket](../apps/server/src/routes/session-events-socket.ts), [room socket](../apps/server/src/routes/room-events-socket.ts), [global socket](../apps/server/src/routes/events-socket.ts)                         |
| Turn acceptance and queueing           | [MessageDispatcher](../apps/server/src/services/session/message-dispatcher.ts), [runtime contract](../packages/shared/src/agent-runtime.ts)                                                                                                                                                             |
| Independent Community                  | [app and route registration](../apps/community/src/app.ts), [SSE route](../apps/community/src/routes/events.ts), [browser](../apps/community/src/browser), [BlobStore](../apps/community/src/storage/blob-store.ts)                                                                                     |
| Community port and actual wiring       | [CommunityAdapter](../packages/shared/src/community-adapter.ts), [registry exports and wiring notes](../apps/server/src/services/communities/index.ts), [room-list aggregation](../apps/server/src/services/communities/list-rooms-across-communities.ts)                                               |
| Optional Cloud boundary                | [public wire contract](../packages/cloud-api/README.md), [existing client](../apps/server/src/services/core/auth/cloud-link-client.ts), [versioned client](../apps/server/src/services/core/cloud/v1-client.ts), [credits opt-in](../apps/server/src/services/core/cloud/credits-inference.ts)          |
| Marketplace delivery                   | [fetcher](../apps/server/src/services/marketplace/package-fetcher.ts), [installer](../apps/server/src/services/marketplace/marketplace-installer.ts), [transaction](../apps/server/src/services/marketplace/transaction.ts), [website reads](../apps/site/src/layers/features/marketplace/lib/fetch.ts) |
| Harness projection                     | [harness package](../packages/harness), [server harness services](../apps/server/src/services/harness)                                                                                                                                                                                                  |
| Messaging and account actions          | [RelayAdapter](../packages/relay/src/types.ts), [ConnectorProvider](../packages/shared/src/connector-provider.ts), [account registry](../apps/server/src/services/connectors/registry.ts)                                                                                                               |
| Memory                                 | [MemoryProvider](../packages/shared/src/memory-provider.ts), [built-in implementation](../packages/memory/src/builtin-provider.ts)                                                                                                                                                                      |

## When to Use What

| Question                                         | View / guide                                                               | Why                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| What do I deploy, and what is optional?          | [System context](#system-context)                                          | Separates processes and data ownership                             |
| Where can I swap implementations?                | [Ports](#replaceable-interfaces)                                           | Separates code interfaces from network protocols                   |
| Where do messages and live updates travel?       | [Session flow](#commands-and-live-events)                                  | Separates acceptance from execution and delivery                   |
| Is Community part of Cloud or local Rooms?       | [Community](#local-rooms-and-independent-community)                        | Shows independent identity and persistence                         |
| Does the website install packages or run agents? | [Marketplace](#marketplace-discovery-and-delivery)                         | Separates discovery, local installation, and activation            |
| What does the app need from Cloud?               | [Cloud boundary](#cloud-public-boundary)                                   | Shows optional public calls without private implementation details |
| How do I change a local subsystem?               | [Implementation architecture](architecture.md) and the linked domain guide | Keeps detailed contracts out of the overview                       |

## Core Patterns

These are architecture patterns, so the examples are diagrams and wire contracts rather than application snippets. In flowcharts, solid arrows show implemented paths; dashed arrows explicitly label unfinished wiring or a schema relationship. The sequence diagram uses dashed arrows for responses and events, following sequence-diagram conventions. An optional path is still drawn solid when the app-side implementation exists. Arrows show the main operation or data direction, not every response packet. Open an image to read it at full size.

### System context

[![DorkOS client and local server, independent Community, optional Cloud, and marketplace sources](../apps/site/public/diagrams/architecture/system-context.svg)](../apps/site/public/diagrams/architecture/system-context.svg)

[Editable diagram](diagrams/architecture/system-context.mmd)

The local server is the execution and coordination host. Rooms, Tasks, Relay, Mesh, memory, workspaces, and installed extensions are subsystems of that host, not separate servers. Agent runtimes can own additional processes. OpenCode, for example, has a managed local sidecar.

There are three different browser experiences: the DorkOS client, the independent Community browser, and the public website. The desktop app wraps the DorkOS client and manages a local server; it does not replace the server with Electron IPC. The phone app reaches the same server over the network, optionally through a tunnel. Obsidian has a separate, in-process `DirectTransport` path with a limited service set; it remains a preview.

| Piece                           | Responsibility and state at this snapshot                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/client` + `apps/server`   | Implemented local app, shared by web and desktop surfaces. Runtime and coordination services live here.                                                                                                            |
| `apps/community`                | Independent Hono service with its own browser, PostgreSQL, sign-in, channels, files, exports, and pairing endpoints. The local app's remote-community experience is still being built.                             |
| Cloud                           | Optional hosted control-plane boundary. App-side clients and a public contract exist; the service is under development. A route in the contract is not proof of deployment.                                        |
| `apps/site`                     | Next.js website, docs, marketplace browsing, and telemetry. Some existing account/device-link routes also remain here during the Cloud separation; do not equate the whole site with the final Cloud architecture. |
| Marketplace source repositories | Package content and registry metadata. The Dork Labs source is a separate public repository; other sources are supported.                                                                                          |
| `packages/cloud-api`            | Public schemas, route definitions, fixtures, and a fetch client. A library shared across the boundary, not a server.                                                                                               |

### Replaceable interfaces

A **port** is a typed boundary in code. An **adapter** implements that boundary. Neither word implies a separate process, and only some implementations make network calls.

[![Six replaceable interfaces and their implementations](../apps/site/public/diagrams/architecture/ports.svg)](../apps/site/public/diagrams/architecture/ports.svg)

[Editable diagram](diagrams/architecture/ports.mmd)

| Interface           | Replaces                                            | Important constraint                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Transport`         | How the React client reaches app operations         | `HttpTransport` uses HTTP and WebSockets; `DirectTransport` calls an in-process subset.                                                                                                                 |
| `AgentRuntime`      | The agent execution engine                          | Claude Code, Codex, and OpenCode implement a shared contract with declared capabilities and conformance tests. Switching runtimes does not migrate an existing conversation.                            |
| `ConnectorProvider` | How authenticated actions reach external services   | Composio, Nango, raw MCP, and managed Cloud implementations sit behind local identity, policy, and execution routing. Account IDs do not expose backend routing.                                        |
| `CommunityAdapter`  | Where a room's shared truth lives                   | A room address includes both community and room ID. Local implementation exists; Buzz exists but is not registered at startup. The independent Community service is not yet connected to the local app. |
| `MemoryProvider`    | How persistent agent notes are stored and retrieved | The built-in store uses files. Capability declarations and conformance govern alternatives; this port does not execute agents.                                                                          |
| `RelayAdapter`      | How messages enter or leave Relay                   | Messaging platforms and agent delivery use this boundary. It is distinct from authenticated service actions and from Community membership.                                                              |

Community's `BlobStore` is another, narrower storage port: filesystem and S3 implementations share the attachment/export contract. Mesh also uses discovery strategies. These do not need to become global registries just because they are replaceable.

### Commands and live events

[![A POST accepts a message while a separate resumable stream delivers the turn](../apps/site/public/diagrams/architecture/session-flow.svg)](../apps/site/public/diagrams/architecture/session-flow.svg)

[Editable diagram](diagrams/architecture/session-flow.mmd)

The message POST returns a receipt, not a token stream. A busy session queues the message. `turn_start` is the reliable signal that execution began; `202` and `queuePosition: 1` cannot distinguish an immediate start from the first queued message. Queued messages survive server restarts. The receipt and live events travel independently and may arrive in either order.

On a cold connection, the session stream sends a snapshot before live events. On reconnection it replays the missing range when possible, otherwise sends a fresh snapshot. Treat the full resume cursor as opaque. A newly created session may receive a canonical runtime ID different from the requested ID; the client must follow that ID.

| Connection                          | Protocol / endpoint                                                             | Purpose                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| DorkOS client → local server        | HTTP JSON, `/api/*`; uploads use multipart/XHR                                  | Queries, commands, settings, uploads, and approvals                                                      |
| Local server → DorkOS client        | WebSocket at `/api/events`, `/api/sessions/:id/events`, `/api/rooms/:id/events` | Global changes, session turns, and room changes. The same route paths also expose SSE to HTTP consumers. |
| Terminal client ↔ local PTY         | WebSocket at `/api/terminal/:id/socket`                                         | Bidirectional terminal bytes; separate from durable app events                                           |
| Community browser → Community       | HTTP `/api/v1/*`, plus its own `/api/auth/*`                                    | Channel operations, sign-in, uploads and exports                                                         |
| Community → its browser             | SSE `/api/v1/channels/:id/events`                                               | Snapshot, replay and live channel updates; the browser uses `EventSource`                                |
| Local server ↔ OpenCode sidecar     | SDK over local HTTP; global SSE subscription                                    | Runtime operations and events. This is separate from the browser's WebSocket connection.                 |
| Local server ↔ Claude Code / Codex  | Their SDKs and managed runtime processes                                        | Agent turns; do not label all runtime links HTTP or SSE                                                  |
| External tool caller → local server | MCP Streamable HTTP at `/mcp`; A2A gateway under `/a2a`                         | Tool access and agent-protocol access, not the browser's chat transport                                  |
| Cloud-linked local server → Cloud   | HTTPS requests, polling, event pull/ack                                         | Device link, heartbeat and optional managed services; details below                                      |
| Messaging platforms ↔ Relay         | Platform-specific API, polling, webhook, or socket                              | Protocol belongs to the concrete messaging implementation                                                |

See [SSE and WebSocket protocol](../docs/integrations/sse-protocol.mdx), [authentication](authentication.md), and [the terminal socket implementation](../apps/server/src/services/terminal/terminal-websocket.ts). WebSocket upgrades have their own credential, origin, and host checks because Express middleware does not run on an upgrade.

### Local rooms and independent Community

[![Local SQLite rooms and independently authenticated Community channels](../apps/site/public/diagrams/architecture/community.svg)](../apps/site/public/diagrams/architecture/community.svg)

[Editable diagram](diagrams/architecture/community.mmd)

Local Rooms and Community solve related problems but do not share a database or login. Community can run without a local DorkOS server or a Cloud account. It owns member and channel authorization, posts, files, and replay cursors. It does not host an `AgentRuntime` or execute agents itself.

The `CommunityAdapter` seam is server-side. Today `GET /api/rooms` returns caller-filtered local rooms and queries any registered remote communities. Remote rooms are not projected into the clickable local room list: the route reports their unavailability through warnings until the app can resolve remote room addresses. Local room listing deliberately bypasses `LocalCommunityAdapter`: its single-identity model cannot express the route's per-caller permissions. Registration of the local implementation does not mean every local room operation flows through the port.

Community pairing and agent credential routes are implemented. A member approves an installation; that installation exchanges a verifier-bound code for a personal bearer. Agent enrollment issues a separate scoped agent bearer. The existence of those endpoints does not establish the missing local app connection.

Slack and Telegram bridges project messages into **local** rooms. They are Relay paths, not remote Community backends. See [Community development](community-server.md) and [implementing the Community port](adding-a-community-adapter.md).

### Marketplace discovery and delivery

[![Marketplace sources feed website discovery and a local transactional installation pipeline](../apps/site/public/diagrams/architecture/marketplace.svg)](../apps/site/public/diagrams/architecture/marketplace.svg)

[Editable diagram](diagrams/architecture/marketplace.mmd)

“Marketplace” names three things: source repositories, a discovery surface on the website, and the local install/activation machinery. There is no required central package-execution server between an installed package and an agent.

The site reads registry metadata and package descriptions. The local installer resolves sources, fetches and caches content, validates it, prepares a permission preview, and installs through a file transaction. Activation depends on the package type. Harness Sync projects agent-facing assets into the layouts each supported harness reads; executable app extensions and messaging packages have their own activation paths.

The install path is covered end to end. That does **not** certify all Claude Code marketplace compatibility claims: full superset compatibility remains behind the project's verification gate. See [registry format](marketplace-registry.md), [installation](marketplace-installs.md), and [Harness Sync](harness-sync.md).

### Cloud public boundary

[![Optional Cloud HTTPS calls, inference endpoint selection, and a separate tunnel data path](../apps/site/public/diagrams/architecture/cloud-boundary.svg)](../apps/site/public/diagrams/architecture/cloud-boundary.svg)

[Editable diagram](diagrams/architecture/cloud-boundary.mmd)

Cloud is not required to build, test, or run the local app or the independent Community server. The public contract belongs in this repository; private service internals do not.

Two API families coexist in the current app. `cloud-link-client.ts` calls existing `/api/auth/device/*` and `/api/instances/*` routes for device linking, heartbeats and managed services. `cloud/v1-client.ts` uses the public versioned contract. Do not draw every existing call as `/v1`, or interpret every `/v1` schema as a completed app feature.

The public contract covers accounts, instances, managed services, entitlements, organizations/seats, remote access, and inference tokens. Its SSE remote command stream (`GET /v1/remote/commands`) is a **contract surface**, not evidence that the current local tunnel manager consumes it. The existing tunnel manager uses the ngrok SDK. Remote browser traffic travels through that tunnel to the local server; it is a different path from Cloud control requests.

Inference is another distinct path. With the explicit credits flag and a linked instance, the app can request a scoped token and endpoint URLs, then configure runtime inference accordingly. Linking an account alone does not enable credits inference. This map does not assert hosted readiness, provider routing, or support parity across every runtime.

### Data ownership and trust boundaries

| Data               | Authority                                                                                                                              | Architectural consequence                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session history    | Runtime-specific history: Claude Code transcripts; Codex thread bindings plus DorkOS-persisted event history; OpenCode sidecar storage | There is no universal transcript store or automatic cross-runtime migration. The Codex SDK cannot list/read threads, so its DorkOS implementation keeps the history it observed. |
| Local coordination | Local SQLite and DorkOS files                                                                                                          | Room posts, durable message queues, schedules and app state do not become Cloud data merely because the app is linked.                                                           |
| Agent identity     | `.dork/agent.json` with a derived SQLite registry                                                                                      | File-first writes; discovery rebuilds the registry.                                                                                                                              |
| Search             | Derived FTS index                                                                                                                      | Rebuildable; not the source of conversation history.                                                                                                                             |
| Community          | Its own PostgreSQL and blob store                                                                                                      | Separate sign-in, grants, membership checks and export lifecycle.                                                                                                                |
| Marketplace        | Source repositories; installed files and local install metadata                                                                        | The website is not the authority for an installed package's execution.                                                                                                           |
| Cloud credentials  | Server-side Cloud client boundary                                                                                                      | Browser UI consumes app responses; server-side credentials stay out of diagrams, logs, and client payloads.                                                                      |

These are ownership boundaries, not a blanket promise that no content leaves the machine. Model calls, external service actions, opted-in telemetry, remote browser access, and Community posts cross different boundaries for different reasons.

## Anti-Patterns

| Avoid                                                                          | Use instead                                                                                              |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| ❌ One box called “backend” for local DorkOS, Community, and Cloud             | ✅ Separate deployment and data-ownership boxes                                                          |
| ❌ Every live arrow labeled SSE                                                | ✅ WebSocket for local app streams, SSE for Community and OpenCode events, with the exact boundary named |
| ❌ `202` drawn as the start of an agent turn                                   | ✅ Acceptance receipt followed by `turn_start` on the event channel                                      |
| ❌ A type or tested implementation drawn as a configured production connection | ✅ A dashed, labeled unfinished path; check composition-root registration                                |
| ❌ Marketplace drawn as a hosted execution service                             | ✅ Source → local transaction → activation/projection                                                    |
| ❌ Cloud inferred from private implementation details                          | ✅ Public contract plus verified app-side callers                                                        |
| ❌ A broad compatibility or platform claim inferred from a build               | ✅ The project's explicit verification status                                                            |

## Updating the diagrams

1. Change the `.mmd` sources in [diagrams/architecture](diagrams/architecture), then regenerate the SVGs. The [rendering instructions](diagrams/architecture/README.md) pin the renderer and configuration.
2. Check the corresponding implementation and startup registration, not just its interface. Record whether each changed path is implemented, optional, unwired, or contract-only.
3. Keep this guide, [the reader overview](../docs/concepts/architecture.mdx), and [the published developer reference](../docs/contributing/architecture.mdx) consistent. Reuse the SVG assets instead of copying diagram definitions.
4. Update the coverage map in [INDEX.md](INDEX.md), then run `node .claude/scripts/docs-coverage-map.mjs --regen` and `--check`.
5. Render and visually inspect every changed diagram. Check referenced paths and the docs build/MDX compilation before claiming the documentation is ready.

## Troubleshooting

**A diagram looks more complete than the feature.** Follow its code pointer to the startup wiring. A registered implementation, a conformance test, a public schema, and an end-user feature are four different kinds of evidence.

**An old document calls chat an SSE connection.** Check which caller it describes. SSE is still supported for HTTP consumers; the DorkOS browser's durable streams use WebSockets. Preserve correct SSE protocol guidance while correcting the browser claim.

**A schema and a deployed service disagree.** Record the discrepancy at the public contract boundary. Do not silently document private behavior as the contract.
