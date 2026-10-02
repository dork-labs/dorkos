/** Real acceptance/queue adoption keeps bounded source selections separate. */
import { afterEach, expect, it } from 'vitest';
import { eq, canvasDocChannels, sessionMessageAcceptanceReceipts, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { randomUUID } from 'node:crypto';
import { DocChannelIngest } from '../../canvas/doc-channel/ingest.js';
import { batchFixture, NOW } from '../../canvas/doc-channel/__tests__/batch-fixtures.js';
import {
  PrivateSessionMessageAcceptanceService,
  setPrivateSessionMessageAcceptanceService,
  type PrivateSessionMessageSourceAdapter,
  type PrivateSessionMessageSourceRef,
} from '../private-messages/acceptance.js';
import { PrivateSessionMessageRefusalError } from '../private-messages/refusal.js';
import {
  adoptAcceptedPrivateMessages,
  dispatchMessage,
  noteRuntimeTurnOpen,
  noteRuntimeTurnClosed,
  resetMessageDispatcher,
} from '../message-dispatcher.js';
import { setMessageQueueStore } from '../message-queue-store.js';
import { disposeProjector, getOrCreateProjector } from '../session-state-projector.js';

const databases: Db[] = [];
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
}
afterEach(async () => {
  await settle();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  setPrivateSessionMessageAcceptanceService(undefined);
  disposeProjector('session-1');
  for (const db of databases.splice(0)) db.$client.close();
});
type ConnectionRef = Extract<PrivateSessionMessageSourceRef, { kind: 'connector_agent_request' }>;
type SourceRow = {
  id: string;
  generation: string;
  session_id: string;
  state: string;
  authorized: number;
};

function setup() {
  const f = batchFixture();
  databases.push(f.db);
  // The Connections engine is represented by a confined source port, not mocked
  // acceptance queries: consume and final authority both read/write real SQLite.
  f.db.$client.exec(
    'CREATE TABLE fixture_connection_sources (id TEXT PRIMARY KEY, generation TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL, authorized INTEGER NOT NULL)'
  );
  const revalidated: string[] = [];
  const source: PrivateSessionMessageSourceAdapter<ConnectionRef> = {
    kind: 'connector_agent_request',
    consume(_tx, ref) {
      const changed = f.db.$client
        .prepare(
          "UPDATE fixture_connection_sources SET state='consumed' WHERE id=? AND generation=? AND state='ready' AND authorized=1"
        )
        .run(ref.requestId, ref.sourceGeneration).changes;
      if (changed !== 1) throw new Error('Source consumption refused');
      const current = f.db.$client
        .prepare('SELECT * FROM fixture_connection_sources WHERE id=?')
        .get(ref.requestId) as SourceRow;
      return {
        sourceKind: ref.kind,
        sourceId: ref.requestId,
        sourceGeneration: ref.sourceGeneration,
        sessionId: current.session_id,
        agentId: 'agent-1',
        originRuntime: 'claude-code',
        originAgentPath: '/agents/one',
        originAuthorityDigest: 'connection-authority',
        queuePlaceholder: '[Private connection update]',
      };
    },
    async prepare(receipt) {
      return {
        sourceKind: 'connector_agent_request',
        sourceId: receipt.sourceId,
        sourceGeneration: receipt.sourceGeneration,
        content: `Connection ready: ${receipt.sourceId}`,
      };
    },
    revalidate(_tx, receipt) {
      const current = f.db.$client
        .prepare('SELECT * FROM fixture_connection_sources WHERE id=?')
        .get(receipt.sourceId) as SourceRow | undefined;
      if (
        !current ||
        current.state !== 'consumed' ||
        current.generation !== receipt.sourceGeneration ||
        current.session_id !== receipt.sessionId ||
        current.authorized !== 1
      )
        throw new PrivateSessionMessageRefusalError(
          'authority_expired',
          'Source authority expired.'
        );
      revalidated.push(receipt.sourceId);
    },
    isPreclaimRefusal: (error) =>
      error instanceof PrivateSessionMessageRefusalError && error.code === 'authority_expired',
  };
  const service = new PrivateSessionMessageAcceptanceService(
    f.db,
    f.queue,
    [f.admission.source, source],
    'boot-1',
    () => new Date(NOW)
  );
  const runtime = new FakeAgentRuntime('claude-code');
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtime.withScenarios([
    async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'done', data: {} };
    },
  ]);
  setMessageQueueStore(f.queue);
  setPrivateSessionMessageAcceptanceService(service);
  const options = { sessionId: 'session-1', projector: getOrCreateProjector('session-1'), runtime };
  function connection(id: string, sessionId = 'session-1') {
    f.db.$client
      .prepare('INSERT INTO fixture_connection_sources VALUES (?,?,?,?,1)')
      .run(id, `generation:${id}`, sessionId, 'ready');
    return service.accept({
      kind: 'connector_agent_request',
      requestId: id,
      sourceGeneration: `generation:${id}`,
      resumeToken: `token:${id}`,
    }).receipt;
  }
  function document() {
    const id = f.canvas.open('session:session-1', 'agent-1', {
      type: 'markdown',
      title: 'Selected document',
      content: 'Private',
    }).id;
    f.db
      .update(canvasDocChannels)
      .set({ openerAgentId: 'agent-1' })
      .where(eq(canvasDocChannels.documentId, id))
      .run();
    f.grants.configure(
      id,
      {
        routes: [
          {
            id: 'route',
            on: 'task.*',
            to: 'agent:owner',
            turn: { mode: 'immediate', maxBatch: 100 },
          },
        ],
      },
      f.actor
    );
    const grant = f.grants.grant(
      { documentId: id, routeId: 'route', expiresAt: '2026-10-02T00:00:00.000Z' },
      f.actor
    );
    if (grant.kind !== 'granted') throw new Error('Actual opener grant required');
    const event = new DocChannelIngest(f.store, () => new Date(NOW)).accept(
      { v: 1, id: randomUUID(), type: 'task.toggle', payload: { checked: true } },
      (tx) => ({
        documentId: id,
        scope: 'session:session-1',
        documentLabel: 'Selected document',
        provenance: { trust: 'app_untrusted' },
        routes: f.grants.getCurrentRoutes(id, 'task.toggle', f.actor, tx),
      })
    );
    return f.admission.admit(event.deliveries[0]!.batchId!).receipt;
  }
  const receipt = (id: string) =>
    f.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, id))
      .get();
  return { ...f, service, runtime, options, connection, document, revalidated, receipt };
}

it('bounds a session with more than 100 actual accepted receipts to one 100-row adoption page', async () => {
  const h = setup();
  for (let i = 0; i < 105; i++) h.connection(`connection-${i.toString().padStart(3, '0')}`);
  const selected = h.service.listAcceptedForDispatch('session-1');
  expect(selected).toHaveLength(100);
  expect(h.service.listAccepted('session-1')).toHaveLength(105);
  noteRuntimeTurnOpen('session-1');
  expect(adoptAcceptedPrivateMessages(h.options)).toBe(100);
  expect(adoptAcceptedPrivateMessages(h.options)).toBe(0);
  await settle();
  expect(h.runtime.sendMessage).not.toHaveBeenCalled();
  expect(h.queue.list('session-1')).toHaveLength(105);
});

it('dispatches only the exact selected document receipt and leaves wrong source/session/state untouched', async () => {
  const h = setup();
  const document = h.document();
  const wrongSource = h.connection('wrong-source');
  const wrongSession = h.document();
  h.db
    .update(sessionMessageAcceptanceReceipts)
    .set({ sessionId: 'other-session' })
    .where(eq(sessionMessageAcceptanceReceipts.id, wrongSession.id))
    .run();
  const wrongState = h.document();
  h.db
    .update(sessionMessageAcceptanceReceipts)
    .set({ state: 'cancelled' })
    .where(eq(sessionMessageAcceptanceReceipts.id, wrongState.id))
    .run();
  const ignored = [wrongSource.id, wrongSession.id, wrongState.id];
  const before = ignored.map((id) => h.receipt(id));
  const selection = {
    sourceKind: 'document_event_batch' as const,
    receiptIds: [document.id, ...ignored],
  };
  expect(h.service.listAcceptedForDispatch('session-1', selection).map((row) => row.id)).toEqual([
    document.id,
  ]);
  expect(adoptAcceptedPrivateMessages({ ...h.options, privateReceiptSelection: selection })).toBe(
    1
  );
  await settle();
  expect(h.runtime.sendMessage).toHaveBeenCalledTimes(1);
  expect(h.runtime.sendMessage.mock.calls[0]?.[2]?.additionalContext).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'doc_events',
        data: expect.objectContaining({ batchId: document.sourceId }),
      }),
    ])
  );
  expect(h.receipt(document.id)?.state).toBe('settled');
  expect(ignored.map((id) => h.receipt(id))).toEqual(before);
  expect(h.queue.get(document.queueMessageId)).toBeUndefined();
  for (const row of [wrongSource, wrongSession, wrongState])
    expect(h.queue.get(row.queueMessageId)).toBeDefined();
});

it('rejects duplicate and oversized selections before adoption, and empty selection has zero effects', async () => {
  const h = setup();
  const document = h.document();
  const before = h.db.select().from(sessionMessageAcceptanceReceipts).all();
  for (const receiptIds of [
    [document.id, document.id],
    Array.from({ length: 101 }, (_, i) => `receipt-${i}`),
  ]) {
    expect(() =>
      adoptAcceptedPrivateMessages({
        ...h.options,
        privateReceiptSelection: { sourceKind: 'document_event_batch', receiptIds },
      })
    ).toThrow('Invalid private message receipt selection');
  }
  expect(
    adoptAcceptedPrivateMessages({
      ...h.options,
      privateReceiptSelection: { sourceKind: 'document_event_batch', receiptIds: [] },
    })
  ).toBe(0);
  await settle();
  expect(h.runtime.sendMessage).not.toHaveBeenCalled();
  expect(h.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(before);
  expect(h.queue.get(document.queueMessageId)).toBeDefined();
});

it('generic Connections recovery excludes document work while revalidating and dispatching its own source', async () => {
  const h = setup();
  const document = h.document();
  const connection = h.connection('generic');
  const before = h.receipt(document.id);
  expect(
    h.service.listAcceptedForDispatch('session-1', undefined, true).map((row) => row.id)
  ).toEqual([connection.id]);
  expect(adoptAcceptedPrivateMessages({ ...h.options, excludeDocumentMessages: true })).toBe(1);
  await settle();
  expect(h.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith(
    'session-1',
    'Connection ready: generic',
    expect.any(Object)
  );
  expect(h.revalidated).toContain('generic');
  expect(h.receipt(connection.id)?.state).toBe('settled');
  expect(h.receipt(document.id)).toEqual(before);
  expect(h.queue.get(document.queueMessageId)).toBeDefined();
  expect(h.queue.get(connection.queueMessageId)).toBeUndefined();
});

it('selected document admission still revalidates actual grant revocation before any runtime effect', async () => {
  const h = setup();
  const document = h.document();
  const batch = h.store.getBatch(document.sourceId)!;
  h.grants.revoke(batch.documentId, batch.grantId, h.actor);
  adoptAcceptedPrivateMessages({
    ...h.options,
    privateReceiptSelection: { sourceKind: 'document_event_batch', receiptIds: [document.id] },
  });
  await settle();
  expect(h.runtime.sendMessage).not.toHaveBeenCalled();
  expect(h.receipt(document.id)?.state).toBe('cancelled');
  expect(h.queue.get(document.queueMessageId)).toBeUndefined();
});

it('ordinary message recovery runs Connections and leaves Docs for the later selected runner', async () => {
  const h = setup();
  const document = h.document();
  const connection = h.connection('ordinary-recovery');
  const documentBefore = h.receipt(document.id);
  const batchBefore = h.store.getBatch(document.sourceId);
  const queueBefore = h.queue.get(document.queueMessageId);
  const done = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'done', data: {} };
  };
  h.runtime.withScenarios([done, done, done]);
  noteRuntimeTurnOpen('session-1');
  const ordinary = await dispatchMessage({
    ...h.options,
    clientId: 'person',
    content: 'Ordinary message',
    whenBusy: 'queue',
  });
  expect(ordinary.accepted).toBe(true);
  expect(ordinary.queued).toBe(true);
  await settle();
  expect(h.runtime.sendMessage).not.toHaveBeenCalled();
  expect(h.receipt(document.id)).toEqual(documentBefore);
  expect(h.store.getBatch(document.sourceId)).toEqual(batchBefore);
  noteRuntimeTurnClosed('session-1');
  await settle();
  expect(h.runtime.sendMessage.mock.calls.map((call) => call[1])).toEqual([
    'Connection ready: ordinary-recovery',
    'Ordinary message',
  ]);
  expect(h.revalidated).toContain('ordinary-recovery');
  expect(h.receipt(connection.id)?.state).toBe('settled');
  expect(h.receipt(document.id)).toEqual(documentBefore);
  expect(h.store.getBatch(document.sourceId)).toEqual(batchBefore);
  expect(h.queue.get(document.queueMessageId)).toEqual(queueBefore);
  expect(
    h.runtime.sendMessage.mock.calls.every(
      (call) => !call[2]?.additionalContext?.some((context) => context.kind === 'doc_events')
    )
  ).toBe(true);
  expect(
    adoptAcceptedPrivateMessages({
      ...h.options,
      privateReceiptSelection: { sourceKind: 'document_event_batch', receiptIds: [document.id] },
    })
  ).toBe(1);
  await settle();
  expect(h.runtime.sendMessage).toHaveBeenCalledTimes(3);
  expect(h.runtime.sendMessage.mock.calls[2]?.[2]?.additionalContext).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'doc_events',
        data: expect.objectContaining({ batchId: document.sourceId }),
      }),
    ])
  );
  expect(h.receipt(document.id)?.state).toBe('settled');
  expect(
    adoptAcceptedPrivateMessages({
      ...h.options,
      privateReceiptSelection: { sourceKind: 'document_event_batch', receiptIds: [document.id] },
    })
  ).toBe(0);
  await settle();
  expect(h.runtime.sendMessage).toHaveBeenCalledTimes(3);
});
