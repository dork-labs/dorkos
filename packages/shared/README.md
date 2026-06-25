# @dorkos/shared

## Purpose

The contract layer for DorkOS. Every cross-cutting type, Zod schema, and interface that more than one app or package depends on lives here, so the boundary between the React client, the Express server, the CLI, and the runtimes is defined in exactly one place. This package holds the two seams the whole architecture pivots on — the `Transport` interface (HTTP vs. in-process Obsidian) and the `AgentRuntime` interface (the backend-agnostic agent contract) — alongside the shared schemas they exchange.

It ships types, schemas, and interfaces only. No HTTP server, no database, no UI.

## Consumption

There is no `.` barrel. Import the exact subpath you need — this keeps the client bundle from pulling in Node-only code:

```ts
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { Transport } from '@dorkos/shared/transport';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
```

## Exports

| Subpath                 | Purpose                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `./agent-runtime`       | The `AgentRuntime` interface — abstracts every agent backend                  |
| `./transport`           | The `Transport` seam — `HttpTransport` (web) and `DirectTransport` (Obsidian) |
| `./types`               | Shared domain types (sessions, messages, agents)                              |
| `./constants`           | Ports, filenames, and other true constants                                    |
| `./schemas`             | Core Zod schemas                                                              |
| `./config-schema`       | `UserConfigSchema` — the authoritative `~/.dork/config.json` schema           |
| `./relay-schemas`       | Relay envelope, access, trace, and adapter schemas                            |
| `./mesh-schemas`        | Mesh agent and topology schemas                                               |
| `./activity-schemas`    | Activity-feed event schemas                                                   |
| `./marketplace-schemas` | Marketplace-facing schemas shared with the client                             |
| `./manifest`            | Package/agent manifest schema                                                 |
| `./validation`          | Shared validation helpers                                                     |
| `./session-stream`      | Session SSE event shapes (snapshot / replay / live)                           |
| `./convention-files`    | Convention-file parsing (isomorphic)                                          |
| `./convention-files-io` | Node-only `fs` reader/writer for convention files                             |
| `./extension-secrets`   | Extension secret declaration + resolution types                               |
| `./extension-settings`  | Extension settings declaration types                                          |
| `./trait-renderer`      | Renders an agent's identity traits (name, color, icon)                        |
| `./template-catalog`    | Built-in agent/template catalog                                               |
| `./dorkbot-templates`   | DorkBot system-agent templates                                                |
| `./logger`              | Shared structured logger                                                      |

`./convention-files-io` and other `-io` modules touch `fs` and are Node-only; everything else is safe to import from the browser client.

## Conventions

- Zod is the authoritative source for any shape that crosses a boundary — derive TypeScript types with `z.infer`, never hand-maintain a parallel `interface`.
- `UserConfigSchema` changes require a semver-keyed config migration. See `contributing/configuration.md` and the `adding-config-fields` skill.

## See also

- `contributing/architecture.md` — the hexagonal `Transport` seam
- `packages/shared/src/agent-runtime.ts` — the `AgentRuntime` contract
