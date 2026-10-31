/** Real Main services and turn bindings; no synthetic serverPrincipal or paid runtime. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { agents, authors, eq, sessionMetadata, createDb, runMigrations, type Db } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import { initAuth } from '../../../core/auth/index.js';
import { ApprovalService } from '../../../core/approvals/approval-service.js';
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/index.js';
import type { AgentIdentity } from '../../../core/agent-identity/index.js';
import { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import type { ConnectorRuntime } from '../../../connectors/runtime-principal-port.js';
import { createRoomSubsystem } from '../../../rooms/index.js';
import { RoomRepoStore } from '../../../rooms/repo/room-repo-store.js';
import { createDocChannelHttpComposition } from '../http-composition.js';
import { createDocChannelDownstreamCapabilities } from '../downstream/capabilities.js';
import { createDocChannelGrantCapabilities } from '../grant-capabilities.js';

/** Portable test boundary; no inferred private database implementation types escape. */
export interface RuntimeDocMcpFixture {
  db: Db;
  dir: string;
  runtime: Extract<ConnectorRuntime, 'claude-code' | 'codex' | 'opencode'>;
  doc: { id: string };
  otherDoc: { id: string };
  http: ReturnType<typeof createDocChannelHttpComposition>;
  canvas: ReturnType<typeof createRoomSubsystem>['canvas'];
  principals: ConnectorRuntimePrincipalService;
  registry: CapabilityRegistry;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  identity: AgentIdentity;
  loseAuthority(): void;
  removeMembership(): void;
  close(): Promise<void>;
}

/** Compose authentic persisted room membership, document policy, grants and runtime authority. */
export async function runtimeDocMcpFixture(
  runtime: Extract<ConnectorRuntime, 'claude-code' | 'codex' | 'opencode'>,
  scope: 'chat' | 'room'
): Promise<RuntimeDocMcpFixture> {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'runtime-doc-tools-')));
  const db = createDb(':memory:');
  try {
    runMigrations(db);
    initAuth(db, dir);
    await fs.mkdir(join(dir, '.dork'));
    await fs.writeFile(
      join(dir, '.dork', 'agent.json'),
      JSON.stringify({ id: 'agent-1', name: 'One', runtime })
    );
    const now = new Date().toISOString();
    db.insert(agents)
      .values({
        id: 'agent-1',
        name: 'One',
        runtime,
        projectPath: dir,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(sessionMetadata)
      .values({ sessionId: 'session-1', runtime, agentPath: dir, createdAt: now })
      .run();
    let live = true;
    const principals = new ConnectorRuntimePrincipalService({
      db,
      authority: {
        async authorizeTurn(input) {
          const agent = db.select().from(agents).where(eq(agents.id, 'agent-1')).get();
          const session = db
            .select()
            .from(sessionMetadata)
            .where(eq(sessionMetadata.sessionId, input.canonicalSessionId))
            .get();
          if (
            !live ||
            agent?.status !== 'active' ||
            agent.runtime !== input.runtime ||
            agent.projectPath !== input.agentPath ||
            session?.runtime !== input.runtime ||
            session.agentPath !== input.agentPath ||
            input.canonicalCwd !== dir
          )
            throw new Error('Unregistered runtime turn');
          return {
            owner: { kind: 'local_install' as const, installationId: 'doc-tools-install' },
            agentId: agent.id,
          };
        },
        async revalidateTurn(claims) {
          const agent = db.select().from(agents).where(eq(agents.id, claims.agentId)).get();
          const session = db
            .select()
            .from(sessionMetadata)
            .where(eq(sessionMetadata.sessionId, claims.canonicalSessionId))
            .get();
          return (
            live &&
            agent?.status === 'active' &&
            agent.runtime === claims.runtime &&
            agent.projectPath === claims.agentPath &&
            session?.runtime === claims.runtime &&
            session.agentPath === claims.agentPath
          );
        },
      },
    });
    await principals.initializeBoot();
    const bootstrap = await principals.openTurn(
      {
        runtime,
        canonicalSessionId: 'session-1',
        agentPath: dir,
        canonicalCwd: dir,
        signal: new AbortController().signal,
      },
      { isCurrent: () => live }
    );
    const resolved = await principals.resolve({
      bearer: bootstrap.bearer,
      expectedRuntime: runtime,
      expectedCanonicalCwd: dir,
    });
    if (resolved.status !== 'resolved') throw new Error('Authentic bootstrap principal missing');
    const rooms = createRoomSubsystem({
      db,
      runtimePrincipalCurrent: (proof) => principals.isPrincipalCurrent(proof),
    });
    const human = rooms.authors.localHuman();
    const room = rooms.service.createRoom(
      { kind: 'channel', slug: 'member-doc', members: [], agentPaths: [dir] },
      human.id
    );
    const author = db.select().from(authors).where(eq(authors.naturalKey, dir)).get();
    if (!author) throw new Error('Persisted member author missing');
    rooms.store.bindRoomSession(room.id, author.id, 'session-1', now);
    const otherRoom = rooms.service.createRoom(
      { kind: 'channel', slug: 'private-doc', members: [], agentPaths: [] },
      human.id
    );
    const doc = rooms.canvas.open(
      scope === 'room' ? `room:${room.id}` : 'session:session-1',
      scope === 'room' ? author.id : 'agent',
      { type: 'markdown', content: 'Original document' },
      { principal: resolved.principal }
    );
    const otherDoc = rooms.canvas.open(`room:${otherRoom.id}`, human.id, {
      type: 'markdown',
      content: 'Private document',
    });
    const http = createDocChannelHttpComposition({
      db,
      documents: rooms.canvasDocuments,
      rooms: rooms.service,
      roomStore: rooms.store,
      roomRepos: new RoomRepoStore(db, dir),
      approvals: new ApprovalService(db),
      installationId: 'doc-tools-install',
      runtimePrincipalCurrent: (proof) => principals.isPrincipalCurrent(proof),
      revalidateRuntime: (proof) => principals.revalidatePrincipal(proof),
    });
    const registry = composeRegistry(
      [
        {
          name: 'ui',
          capabilities: [
            ...createDocChannelGrantCapabilities(http.grants),
            ...createDocChannelDownstreamCapabilities(http.downstream),
          ],
        },
      ],
      {
        logger: noopLogger,
        docChannelGrantDeps: { service: http.grants, authorization: http.authorization },
      }
    );
    const calls = [
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
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
      {
        name: 'canvas_patch_state',
        arguments: {
          documentId: doc.id,
          eventId: randomUUID(),
          expectedStateRev: 0,
          operations: [{ op: 'set', path: '/count', value: 1 }],
        },
      },
      {
        name: 'canvas_send',
        arguments: {
          documentId: doc.id,
          eventId: randomUUID(),
          type: 'app.reply',
          payload: { text: 'Hello' },
        },
      },
    ];
    return {
      db,
      dir,
      runtime,
      doc,
      otherDoc,
      http,
      canvas: rooms.canvas,
      principals,
      registry,
      calls,
      identity: { agentPath: dir, displayName: 'One', createdAt: now },
      loseAuthority: () => {
        live = false;
      },
      removeMembership: () => rooms.service.leaveRoom(room.id, author.id),
      async close() {
        try {
          await principals.revoke(bootstrap.bindingId, 'turn_terminal');
        } finally {
          db.$client.close();
          await fs.rm(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (cause) {
    db.$client.close();
    await fs.rm(dir, { recursive: true, force: true });
    throw cause;
  }
}

/** Extract the actual MCP JSON payload, failing rather than accepting an empty response. */
export function docMcpPayload(result: unknown): Record<string, unknown> {
  const text = (result as { content?: Array<{ type: string; text?: string }> }).content?.find(
    (part) => part.type === 'text'
  )?.text;
  if (!text) throw new Error('MCP result has no JSON text');
  return JSON.parse(text) as Record<string, unknown>;
}
