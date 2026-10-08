import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initBoundary } from '../../../../lib/boundary.js';
import { stopInstallationFileWrites } from '../writes/installation-file-writes.js';
import { currentRoomDueServicePort } from '../service.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, sessionMetadata, createDb, runMigrations, type Db } from '@dorkos/db';
import { createRoomSubsystem, type RoomSubsystem } from '../../../rooms/index.js';
import { RoomRepoStore } from '../../../rooms/repo/room-repo-store.js';
import { ApprovalService } from '../../../core/approvals/approval-service.js';
import {
  linkSessionId,
  resetSessionKeys,
} from '../../../session/resolution/session-key-registry.js';
import { randomUUID } from 'node:crypto';
import { noopLogger } from '@dorkos/shared/logger';
import { uiDomain } from '../../../session/browser-seat/ui-capabilities.js';
import { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { createDocChannelHttpComposition } from '../http-composition.js';

let db: Db;
let fixtureRoot: string;
let fixtureConstructed = false;
let rooms: RoomSubsystem;
let approvals: ApprovalService;
let http: ReturnType<typeof createDocChannelHttpComposition>;
let documentId: string;
let runtimePrincipalCurrent: (proof: ReturnType<typeof createServerPrincipal>) => boolean;
let revalidateRuntime: (proof: ReturnType<typeof createServerPrincipal>) => Promise<boolean>;
const actor = () => ({
  surface: 'http' as const,
  principal: createServerPrincipal({
    kind: 'operator',
    owner: { kind: 'local_install', installationId: 'test-install' },
  }),
});
beforeEach(async () => {
  fixtureConstructed = false;
  runtimePrincipalCurrent = () => false;
  revalidateRuntime = async () => false;
  fixtureRoot = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'original-http-doc-owner-')));
  await initBoundary(fixtureRoot);
  db = createDb(':memory:');
  runMigrations(db);
  rooms = createRoomSubsystem({ db });
  approvals = new ApprovalService(db);
  http = createDocChannelHttpComposition({
    db,
    documents: rooms.canvasDocuments,
    rooms: rooms.service,
    roomStore: rooms.store,
    roomRepos: new RoomRepoStore(db, '/unused'),
    approvals,
    installationId: 'test-install',
    runtimePrincipalCurrent: (proof) => runtimePrincipalCurrent(proof),
    revalidateRuntime: (proof) => revalidateRuntime(proof),
  });
  fixtureConstructed = true;
  const now = new Date().toISOString();
  for (const id of ['a', 'b']) {
    db.insert(agents)
      .values({
        id,
        name: id,
        projectPath: `/agents/${id}`,
        runtime: 'codex',
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(sessionMetadata)
      .values({
        sessionId: `session-${id}`,
        agentPath: `/agents/${id}`,
        runtime: 'codex',
        createdAt: now,
      })
      .run();
  }
  documentId = rooms.canvas.open('session:session-a', 'owner', {
    type: 'url',
    url: 'https://example.test/app',
  }).id;
  http.grants.configure(
    documentId,
    {
      routes: [
        { id: 'other', on: 'task.*', to: 'agent:b', turn: { mode: 'immediate', maxBatch: 100 } },
      ],
    },
    actor(),
    'a'
  );
});
afterEach(async () => {
  // A failed original constructor may retain custody; never remove an unconfirmed setup root.
  if (!fixtureConstructed) return;
  const drains = await Promise.allSettled([
    Promise.resolve().then(() => stopInstallationFileWrites(http.fileWrites, db, http.channels)),
    Promise.resolve().then(() => currentRoomDueServicePort(http.service).stopPump()),
  ]);
  const failure = drains.find((outcome) => outcome.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  db.$client.close();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  resetSessionKeys();
});
const input = () => ({
  documentId,
  routeId: 'other',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});
describe('production explicit agent target binding', () => {
  it('consumes an operator approval bound to B while the document remains owned by A', () => {
    const request = input();
    const pending = http.grants.grant(request, actor());
    expect(pending.kind).toBe('approval_required');
    if (pending.kind !== 'approval_required') throw new Error('Expected approval');
    approvals.grant(pending.ticket.approvalId);
    const granted = http.grants.grant(request, actor(), pending.ticket.token);
    expect(granted.kind).toBe('granted');
    if (granted.kind !== 'granted') throw new Error('Expected grant');
    expect(granted.grant).toMatchObject({
      targetAgentId: 'b',
      targetSessionId: 'session-b',
      targetRuntime: 'codex',
    });
    expect(granted.grant.approvalEvidence).toMatchObject({
      binding: {
        scope: 'session:session-a',
        target: { agentId: 'b', agentPath: '/agents/b', runtime: 'codex', sessionId: 'session-b' },
      },
    });
    expect(
      db.$client
        .prepare('SELECT consumed_at FROM approvals WHERE id = ?')
        .get(pending.ticket.approvalId)
    ).toMatchObject({ consumed_at: expect.any(String) });
  });
  it('refuses runtime effects when the real binding is revoked during async revalidation', async () => {
    const principals = new ConnectorRuntimePrincipalService({
      db,
      authority: {
        authorizeTurn: async () => ({
          owner: { kind: 'local_install', installationId: 'test-install' },
          agentId: 'a',
        }),
        revalidateTurn: async () => true,
      },
    });
    await principals.initializeBoot();
    const opened = await principals.openTurn(
      {
        runtime: 'codex',
        canonicalSessionId: 'session-a',
        agentPath: '/agents/a',
        signal: new AbortController().signal,
      },
      { isCurrent: () => true }
    );
    const resolved = await principals.resolve({ bearer: opened.bearer, expectedRuntime: 'codex' });
    if (resolved.status !== 'resolved') throw new Error('Expected authenticated turn');
    // Exercise the first original constructor's configured callbacks, not a second installation.
    runtimePrincipalCurrent = (proof) => principals.isPrincipalCurrent(proof);
    revalidateRuntime = async (proof) => {
      await Promise.resolve();
      await principals.revoke(opened.bindingId, 'turn_cancelled');
      return principals.revalidatePrincipal(proof);
    };
    const composition = http;
    const envelope = { v: 1, id: randomUUID(), type: 'task.changed', payload: {} };
    await expect(
      composition.service.ingestEvent(documentId, envelope, {
        surface: 'capability',
        principal: resolved.principal,
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(composition.channels.getEvent(documentId, envelope.id)).toBeUndefined();
  });
  it('deduplicates server-known aliases before requiring one canonical candidate', () => {
    db.insert(sessionMetadata)
      .values({
        sessionId: 'old-b',
        agentPath: '/agents/b',
        runtime: 'codex',
        createdAt: new Date().toISOString(),
      })
      .run();
    linkSessionId('old-b', 'session-b');
    expect(http.grants.grant(input(), actor()).kind).toBe('approval_required');
  });
  it('refuses an ambiguous current execution session and does not select the newest', () => {
    db.insert(sessionMetadata)
      .values({
        sessionId: 'other-b',
        agentPath: '/agents/b',
        runtime: 'codex',
        createdAt: new Date().toISOString(),
      })
      .run();
    expect(() => http.grants.grant(input(), actor())).toThrow('TARGET_UNAVAILABLE');
  });
  it('refuses settlement if another current candidate appears after approval', () => {
    const request = input();
    const pending = http.grants.grant(request, actor());
    if (pending.kind !== 'approval_required') throw new Error('Expected approval');
    approvals.grant(pending.ticket.approvalId);
    db.insert(sessionMetadata)
      .values({
        sessionId: 'other-b',
        agentPath: '/agents/b',
        runtime: 'codex',
        createdAt: new Date().toISOString(),
      })
      .run();
    expect(() => http.grants.grant(request, actor(), pending.ticket.token)).toThrow(
      'TARGET_UNAVAILABLE'
    );
    expect(db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_grants').get()).toEqual({
      n: 0,
    });
  });
});

it('binds declared UI capabilities to the production document services and refuses missing authority', async () => {
  const deps = {
    logger: noopLogger,
    docChannelGrantDeps: { service: http.grants, authorization: http.authorization },
    docChannelDownstream: http.downstream,
  };
  const context = { serverPrincipal: actor().principal };
  const configure = uiDomain.capabilities.find((item) => item.id === 'ui.configure_doc_channel')!;
  await expect(
    configure.invoke(deps, { documentId, channel: { routes: [] } }, context)
  ).resolves.toEqual({ configured: true });
  const send = uiDomain.capabilities.find((item) => item.id === 'ui.send_canvas_event')!;
  const eventId = randomUUID();
  const sent = await send.invoke(
    deps,
    { documentId, eventId, type: 'app.reply', payload: { answer: true } },
    context
  );
  expect(sent).toMatchObject({ receipt: { id: eventId } });
  expect(http.channels.getEvent(documentId, eventId)?.payload).toEqual({ answer: true });
  const patch = uiDomain.capabilities.find((item) => item.id === 'ui.patch_canvas_state')!;
  await expect(
    patch.invoke(
      deps,
      {
        documentId,
        eventId: randomUUID(),
        expectedStateRev: 0,
        operations: [{ op: 'set', path: '/answer', value: true }],
      },
      context
    )
  ).resolves.toMatchObject({ stateRev: 1 });
  expect(http.channels.getChannel(documentId)?.state).toEqual({ answer: true });
  await expect(
    send.invoke(
      { logger: noopLogger },
      { documentId, eventId: randomUUID(), type: 'app.reply', payload: {} },
      context
    )
  ).rejects.toThrow('DOC_CHANNEL_UNAVAILABLE');
  await expect(
    send.invoke(deps, { documentId, eventId: randomUUID(), type: 'app.reply', payload: {} }, {})
  ).rejects.toThrow('CANVAS_DOCUMENT_NOT_FOUND');
});
