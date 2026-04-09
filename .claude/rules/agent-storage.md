---
paths: packages/mesh/src/**/*.ts, packages/shared/src/manifest.ts, apps/server/src/routes/agents.ts, apps/server/src/routes/mesh.ts
---

# Agent Storage: File-First Write-Through (ADR-0043)

## Installed vs Discovered

The file-first write-through rule below applies to every `.dork/agent.json` manifest regardless of where it lives on disk. But **where** the files live splits by purpose, and the two cases are populated by different subsystems:

- **`${dorkHome}/agents/*/.dork/agent.json`** — marketplace-installed agents. Managed by the install pipeline in `apps/server/src/services/marketplace/flows/install-agent.ts` and scanned by `installed-scanner.ts`. Have an `.dork/install-metadata.json` provenance sidecar.
- **Arbitrary user paths** — discovered agents. Walked by the unified scanner in `packages/mesh/src/discovery/unified-scanner.ts` starting from `mesh.scanRoots` in `~/.dork/config.json` or from roots passed to `mesh_discover`. No provenance sidecar unless the user added one manually.

Both populate the same SQLite `agents` table and both must follow the write-through rule below. See [`docs/guides/agent-discovery.mdx`](../../docs/guides/agent-discovery.mdx) for the full two-registry framing and when to use each API.

## Canonical Source of Truth

`.dork/agent.json` files on disk are the canonical source of truth for agent data. The SQLite `agents` table is a **derived cache/index** maintained by the Mesh module.

## Write-Through Rule

Every mutation to agent data must follow this order:

1. **Write to disk** — `writeManifest(projectPath, manifest)`
2. **Update DB** — `registry.upsert()` or `registry.update()`
3. **Sync subsystems** — Relay endpoint registration (if applicable)

## Delete Rule

When unregistering an agent:

1. **Delete manifest file** — `removeManifest(projectPath)` (prevents re-discovery)
2. **Remove from DB** — `registry.remove(agentId)`
3. **Unregister Relay** — `relayBridge.unregisterAgent()`

## Cross-Route Sync

The agents routes (`routes/agents.ts`) write directly to disk. When MeshCore is available, they call `meshCore.syncFromDisk(path)` after each write for immediate DB sync. Without MeshCore (Mesh disabled), agents routes still work — the reconciler will sync on next run.

## Anti-Patterns

```typescript
// BAD: DB-only update (data lost on next reconcile)
registry.update(agentId, { name: 'new-name' });

// BAD: unregister without deleting manifest (agent reappears on scan)
registry.remove(agentId);

// GOOD: write file first, then update DB
await writeManifest(projectPath, manifest);
registry.update(agentId, partial);

// GOOD: delete file before removing from DB
await removeManifest(projectPath);
registry.remove(agentId);
```

## Reconciliation

The reconciler (`reconciler.ts`) runs every 5 minutes and syncs **file → DB**. It compares all manifest fields (including `persona`, `personaEnabled`, `color`, `icon`) and updates the DB when they differ.
