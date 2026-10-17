/** Real document services and server-minted turn authority for MCP boundary tests. */
import { agents, eq, sessionMetadata, type Db } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../../core/capabilities/index.js';
import { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import type { ConnectorRuntime } from '../../../connectors/runtime-principal-port.js';
import { createDocChannelDownstreamCapabilities } from '../downstream/capabilities.js';
import { createDocChannelGrantCapabilities } from '../grant-capabilities.js';
import { databases, fixture, patch, send } from './downstream-fixtures.js';
import { NOW } from './lifecycle-fixtures.js';

const ownedDatabases: Db[] = [];

/** Close fixture databases after their owning MCP transports and turns have closed. */
export function closeRuntimeMcpFixtures(): void {
  for (const db of ownedDatabases.splice(0)) db.$client.close();
}

/** Compose the real Doc handlers with one verified agent's durable runtime binding. */
export async function runtimeMcpFixture(runtime: ConnectorRuntime = 'claude-code') {
  const f = fixture();
  // This fixture owns async MCP resources. Remove the DB from the synchronous
  // downstream fixture hook so its caller can close transports and revoke turns
  // before closing SQLite, independently of Vitest's hook ordering.
  databases.splice(databases.indexOf(f.db), 1);
  ownedDatabases.push(f.db);
  f.db.update(agents).set({ runtime }).where(eq(agents.id, 'agent-1')).run();
  f.db.update(sessionMetadata).set({ runtime }).run();
  let live = true;
  const principals = new ConnectorRuntimePrincipalService({
    db: f.db,
    now: () => new Date(NOW),
    authority: {
      async authorizeTurn(input) {
        const agent = f.db.select().from(agents).where(eq(agents.id, 'agent-1')).get();
        const session = f.db.select().from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, input.canonicalSessionId)).get();
        if (!live || agent?.status !== 'active' || agent.runtime !== input.runtime ||
          agent.projectPath !== input.agentPath || session?.agentPath !== input.agentPath ||
          session.runtime !== input.runtime || input.canonicalCwd !== input.agentPath) {
          throw new Error('Unregistered runtime turn');
        }
        return { owner: { kind: 'local_install' as const, installationId: 'installation' }, agentId: agent.id };
      },
      async revalidateTurn(claims) {
        return live && claims.agentId === 'agent-1' && claims.runtime === runtime &&
          claims.canonicalSessionId === 'session-1' && claims.agentPath === '/agents/one';
      },
    },
  });
  await principals.initializeBoot();
  const registry = composeRegistry([{
    name: 'ui',
    capabilities: [
      ...createDocChannelDownstreamCapabilities(f.service),
      ...createDocChannelGrantCapabilities(f.grants),
    ],
  }], { logger: noopLogger });
  const route = {
    id: 'route', on: 'task.*', to: 'agent:owner' as const,
    turn: { mode: 'coalesce' as const, windowMs: 1000, maxBatch: 100 },
  };
  return {
    ...f, principals, registry, runtime,
    identity: { agentPath: '/agents/one', displayName: 'One', createdAt: NOW },
    loseAuthority: () => { live = false; },
    calls: [
      { name: 'configure_doc_channel', arguments: { documentId: f.doc.id, channel: { routes: [route] } } },
      { name: 'approve_doc_route', arguments: { documentId: f.doc.id, routeId: 'route', expiresAt: '2026-10-01T13:00:00.000Z' } },
      { name: 'canvas_patch_state', arguments: patch(f.doc.id) },
      { name: 'canvas_send', arguments: send(f.doc.id) },
    ],
  };
}
