# @dorkos/mesh

## Purpose

Agent discovery, registration, and the registry — Mesh, the "coordination" half of DorkOS. It scans your projects for agent-capable directories (Claude Code, Cursor, Codex, and more), lets you approve which agents join the network, gives each one an identity, and tracks how they reach each other.

`MeshCore` ties it together: pluggable discovery strategies, the unified filesystem scanner, SQLite-backed persistence, manifest management, topology/namespace resolution, health, reconciliation, and an optional bridge into `@dorkos/relay`.

## Exports

Single `.` barrel. Key pieces:

| Area        | Exports                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core        | `MeshCore`                                                                                                                                                                                                                                             |
| Discovery   | `unifiedScan`, `DiscoveryStrategy` + per-tool strategies (`ClaudeCodeStrategy`, `CursorStrategy`, `CodexStrategy`, `WindsurfStrategy`, `GeminiStrategy`, `ClineStrategy`, `RooCodeStrategy`, `CopilotStrategy`, `AmazonQStrategy`, `ContinueStrategy`) |
| Persistence | `AgentRegistry`, `DenialList`                                                                                                                                                                                                                          |
| Manifest    | `readManifest`, `writeManifest`, `removeManifest`                                                                                                                                                                                                      |
| Namespace   | `resolveNamespace`, `normalizeNamespace`, `validateNamespace`                                                                                                                                                                                          |
| Topology    | `TopologyManager`                                                                                                                                                                                                                                      |
| Budget      | `BudgetMapper`                                                                                                                                                                                                                                         |
| Health      | `computeHealthStatus`                                                                                                                                                                                                                                  |
| Lifecycle   | `reconcile`, `RelayBridge`                                                                                                                                                                                                                             |

## Usage

```ts
import { unifiedScan } from '@dorkos/mesh';

for await (const event of unifiedScan({ roots: ['/abs/projects'] })) {
  if (event.type === 'agent-found') console.log(event.agent.name);
}
```

## Notes

- The unified scanner (`discovery/unified-scanner.ts`) is the broad, filesystem-based registry — distinct from the marketplace's narrower installed-scanner. They back different APIs; don't conflate them.
- Agent storage is file-first (`.dork/agent.json` is the source of truth) with the SQLite `agents` table as a derived cache. See ADR-0043.
