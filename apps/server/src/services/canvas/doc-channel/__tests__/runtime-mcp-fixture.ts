/** Real document services and server-minted turn authority for MCP boundary tests. */
import { agents, eq, sessionMetadata, type Db } from '@dorkos/db';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import type { CapabilityRegistry } from '../../../core/capabilities/registry.js';
import type { DocChannelStore } from '../store.js';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';
import { resolveOperatorAuthor } from '../../../rooms/index.js';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../../core/capabilities/index.js';
import { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import type { ConnectorRuntime } from '../../../connectors/runtime-principal-port.js';
import { createDocChannelDownstreamCapabilities } from '../downstream/capabilities.js';
import { createDocChannelGrantCapabilities } from '../grant-capabilities.js';
import { databases, fixture, patch, send } from './downstream-fixtures.js';
import { NOW } from './lifecycle-fixtures.js';

const ownedDatabases: Db[] = [];
const ownedRoomCleanups: Array<() => Promise<void>> = [];

/** Close fixture databases after their owning MCP transports and turns have closed. */
export async function closeRuntimeMcpFixtures(): Promise<void> {
  let failed = false;
  let firstCause: unknown;
  for (const cleanup of ownedRoomCleanups.splice(0)) {
    try {
      await cleanup();
    } catch (cause) {
      if (!failed) {
        failed = true;
        firstCause = cause;
      }
    }
  }
  for (const db of ownedDatabases.splice(0)) {
    try {
      db.$client.close();
    } catch (cause) {
      if (!failed) {
        failed = true;
        firstCause = cause;
      }
    }
  }
  if (failed) throw firstCause;
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
        const session = f.db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, input.canonicalSessionId))
          .get();
        if (
          !live ||
          agent?.status !== 'active' ||
          agent.runtime !== input.runtime ||
          agent.projectPath !== input.agentPath ||
          session?.agentPath !== input.agentPath ||
          session.runtime !== input.runtime ||
          input.canonicalCwd !== input.agentPath
        ) {
          throw new Error('Unregistered runtime turn');
        }
        return {
          owner: { kind: 'local_install' as const, installationId: 'installation' },
          agentId: agent.id,
        };
      },
      async revalidateTurn(claims) {
        return (
          live &&
          claims.agentId === 'agent-1' &&
          claims.runtime === runtime &&
          claims.canonicalSessionId === 'session-1' &&
          claims.agentPath === '/agents/one'
        );
      },
    },
  });
  await principals.initializeBoot();
  const registry = composeRegistry(
    [
      {
        name: 'ui',
        capabilities: [
          ...createDocChannelDownstreamCapabilities(f.service),
          ...createDocChannelGrantCapabilities(f.grants),
        ],
      },
    ],
    { logger: noopLogger }
  );
  const route = {
    id: 'route',
    on: 'task.*',
    to: 'agent:owner' as const,
    turn: { mode: 'coalesce' as const, windowMs: 1000, maxBatch: 100 },
  };
  return {
    ...f,
    principals,
    registry,
    runtime,
    identity: { agentPath: '/agents/one', displayName: 'One', createdAt: NOW },
    loseAuthority: () => {
      live = false;
    },
    calls: [
      {
        name: 'configure_doc_channel',
        arguments: { documentId: f.doc.id, channel: { routes: [route] } },
      },
      {
        name: 'approve_doc_route',
        arguments: {
          documentId: f.doc.id,
          routeId: 'route',
          expiresAt: '2026-10-01T13:00:00.000Z',
        },
      },
      { name: 'canvas_patch_state', arguments: patch(f.doc.id) },
      { name: 'canvas_send', arguments: send(f.doc.id) },
    ],
  };
}

/** Portable owning Room fixture shape without inferred private database implementation types. */
export interface RuntimeRoomMcpFixture {
  db: Db;
  doc: CanvasDocument;
  otherDoc: CanvasDocument;
  store: DocChannelStore;
  principals: ConnectorRuntimePrincipalService;
  registry: CapabilityRegistry;
  identity: { agentPath: string; displayName: string; createdAt: string };
  removeMembership(): void;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/** Real persisted Room membership and native principal service, without a paid responder turn. */
export async function runtimeRoomMcpFixture(
  runtime: Extract<ConnectorRuntime, 'claude-code' | 'codex' | 'opencode'> = 'claude-code'
): Promise<RuntimeRoomMcpFixture> {
  const agentPath = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'room-doc-mcp-agent-')));
  let native: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  try {
    await fs.mkdir(join(agentPath, '.dork'));
    await fs.writeFile(
      join(agentPath, '.dork', 'agent.json'),
      JSON.stringify({ id: 'agent-1', name: 'One', runtime })
    );
    native = await nativeRoomAuthorityFixture(agentPath, runtime, 'session-1', 'agent-1');
    const h = native;
    ownedRoomCleanups.push(async () => {
      let failed = false;
      let firstCause: unknown;
      try {
        await h.cleanup();
      } catch (cause) {
        failed = true;
        firstCause = cause;
      }
      try {
        await fs.rm(agentPath, { recursive: true, force: true });
      } catch (cause) {
        if (!failed) {
          failed = true;
          firstCause = cause;
        }
      }
      if (failed) throw firstCause;
    });
    const doc = h.rooms.canvas.open(`room:${h.roomId}`, h.authorId, {
      type: 'markdown',
      content: 'Member-owned editable document',
    });
    const human = resolveOperatorAuthor(h.rooms.authors);
    const otherRoom = h.rooms.service.createRoom(
      { kind: 'channel', slug: 'private-other', members: [], agentPaths: [] },
      human.id
    );
    const otherDoc = h.rooms.canvas.open(`room:${otherRoom.id}`, human.id, {
      type: 'markdown',
      content: 'Nonmember private document',
    });
    const registry = composeRegistry(
      [
        {
          name: 'ui',
          capabilities: [
            ...createDocChannelDownstreamCapabilities(h.http.downstream),
            ...createDocChannelGrantCapabilities(h.http.grants),
          ],
        },
      ],
      { logger: noopLogger }
    );
    return {
      db: h.db,
      doc,
      otherDoc,
      store: h.http.channels,
      principals: h.principals,
      registry,
      identity: { agentPath, displayName: 'One', createdAt: new Date().toISOString() },
      removeMembership: () => h.rooms.service.leaveRoom(h.roomId, h.authorId),
      calls: [
        {
          name: 'configure_doc_channel',
          arguments: {
            documentId: doc.id,
            channel: {
              routes: [
                {
                  id: 'own-route',
                  on: 'task.*',
                  to: 'agent:owner',
                  turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
                },
              ],
            },
          },
        },
        {
          name: 'approve_doc_route',
          arguments: {
            documentId: doc.id,
            routeId: 'own-route',
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        },
        { name: 'canvas_patch_state', arguments: patch(doc.id) },
        { name: 'canvas_send', arguments: send(doc.id) },
      ],
    };
  } catch (cause) {
    if (!native) await fs.rm(agentPath, { recursive: true, force: true });
    throw cause;
  }
}
