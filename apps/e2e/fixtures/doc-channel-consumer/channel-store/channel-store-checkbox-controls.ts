/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */

import { join } from 'node:path';

import { requireOriginalConsumerControls } from '../channel-store.js';
/** Original fixed checkbox controls; no supplied mutable context or original-key issuer. */
export function createOriginalConsumerCheckboxControls(ownerKey: object) {
  const context = requireOriginalConsumerControls(ownerKey);
  const {
    vault,
    hostBootstrap,
    target,
    currentRoomDueServicePort,
    file,
    db,
    agentId,
    sessionId,
    rooms,
    approvals,
    http,
    actor,
    readOriginalApprovalBindings,
    documentId,
    granted,
    initial,
    setMessageQueueStore,
    setPrivateSessionMessageAcceptanceService,
    adoptAcceptedPrivateMessages,
    getOrCreateProjector,
    queue,
    admission,
    runtime,
    originalTargetLocked,
    runtimeRegistry,
    pumpLifetime,
    checkboxBaseline,
    readFile,
    writeFile,
    rawByteHash,
    readTestModeOriginalScenarioCounts,
  } = context;
  return {
    openCheckboxFile() {
      if (
        !hostBootstrap ||
        context.closed ||
        (target === 'room' && !context.roomAgentAuthorId) ||
        context.checkboxOpenStarted
      )
        throw new Error('Original browser checkbox setup unavailable');
      context.checkboxOpenStarted = true;
      context.checkboxSetupWork = (async () => {
        context.checkboxPath = join(vault.root, 'native-browser-checkbox.md');
        await writeFile(context.checkboxPath, checkboxBaseline);
        if (context.closed) throw new Error('Original checkbox setup retired');
        const { SESSION_AGENT_AUTHOR } =
          await import('../../../../server/src/services/canvas/scopes.js');
        context.checkboxDocumentId = rooms.canvas.open(
          context.scope,
          target === 'room' ? context.roomAgentAuthorId! : SESSION_AGENT_AUTHOR,
          {
            type: 'file',
            sourcePath: context.checkboxPath,
            language: 'markdown',
            title: 'Native checkbox file',
          },
          {
            tree: {
              resolvedCwd: vault.root,
              treeKind: 'agent-cwd',
              sourceLabel: null,
              aheadOfMain: null,
            },
          }
        ).id;
        http.grants.configure(
          context.checkboxDocumentId,
          {
            routes: [
              {
                id: 'native-checkbox',
                on: 'md.*',
                to: target === 'room' ? 'room:self' : 'agent:owner',
                turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 10 },
              },
            ],
          },
          actor,
          agentId
        );
        const request = {
          documentId: context.checkboxDocumentId,
          routeId: 'native-checkbox',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
        const pending = await http.grantCheckboxRoute(request, actor);
        if (pending.kind !== 'approval_required')
          throw new Error('Original FILE approval unavailable');
        approvals.grant(pending.ticket.approvalId);
        const granted = await http.grantCheckboxRoute(request, actor, pending.ticket.token);
        if (context.closed || granted.kind !== 'granted')
          throw new Error('Original FILE consumed approval unavailable');
        return { documentId: context.checkboxDocumentId };
      })();
      return context.checkboxSetupWork;
    },
    /** Explicit original pump action after the actual interactive holder is released. */
    pumpCheckboxAfterRelease() {
      if (
        !hostBootstrap ||
        context.closed ||
        !context.checkboxDocumentId ||
        context.checkboxPumpStarted ||
        originalTargetLocked(sessionId)
      )
        throw new Error('Original checkbox release/pump unavailable');
      context.checkboxPumpStarted = true;
      context.checkboxPumpWork = (async () => {
        if (target === 'session') {
          if (!admission) throw new Error('Original private session admission unavailable');
          // Consume the actual already-accepted private queue through its original owner.
          // The inverse pair must have cancelled its batch before any acceptance.
          setMessageQueueStore(queue);
          setPrivateSessionMessageAcceptanceService(admission.acceptance);
          context.pumpInstalled = true;
          await adoptAcceptedPrivateMessages({
            sessionId,
            runtime,
            cwd: vault.root,
            projector: getOrCreateProjector(sessionId),
            privateDispatchSignal: pumpLifetime.signal,
          });
          if (context.closed) throw new Error('Original private checkbox dispatcher retired');
          return { pumped: true };
        }
        const port = currentRoomDueServicePort(http.service);
        port.wake();
        await port.pump(runtimeRegistry);
        if (context.closed) throw new Error('Original checkbox pump retired');
        await port.pump(runtimeRegistry);
        return { pumped: true };
      })();
      return context.checkboxPumpWork;
    },
    /** Fixed bounded DATA audit of this own original FILE; supplied IDs/counters cannot select it. */
    async readOriginalCheckboxPairData() {
      if (context.closed || !context.checkboxDocumentId || !context.checkboxPath)
        throw new Error('Original checkbox DATA unavailable');
      const physical = await readFile(context.checkboxPath);
      if (context.closed) throw new Error('Original checkbox DATA retired');
      const events = db.$client
        .prepare(
          "SELECT event_id AS eventId, doc_seq AS docSeq, payload FROM canvas_doc_events WHERE document_id=? AND type='md.task.toggled' AND direction='upstream' ORDER BY doc_seq LIMIT 3"
        )
        .all(context.checkboxDocumentId) as { eventId: string; docSeq: number; payload: string }[];
      if (events.length > 2) throw new Error('Original checkbox event bound');
      const receipts = [];
      for (const event of events)
        receipts.push(await http.service.receipt(context.checkboxDocumentId, event.eventId, actor));
      const deliveries = db.$client
        .prepare(
          'SELECT event_id AS eventId, status FROM canvas_doc_deliveries WHERE document_id=? ORDER BY event_id LIMIT 3'
        )
        .all(context.checkboxDocumentId) as { eventId: string; status: string }[];
      const batches = db.$client
        .prepare(
          'SELECT batch_id AS batchId, generation, status, error_code AS errorCode FROM canvas_doc_batches WHERE document_id=? ORDER BY batch_id LIMIT 3'
        )
        .all(context.checkboxDocumentId) as {
        batchId: string;
        generation: number;
        status: string;
        errorCode: string | null;
      }[];
      // Two native marker inputs remain the original bound. Trusted service statuses
      // share their durable log but are not additional checkbox operations.
      const systemStatuses = db.$client
        .prepare(
          `SELECT event_id AS eventId, doc_seq AS docSeq,
          direction, provenance, payload FROM canvas_doc_events
          WHERE document_id=? AND type='event.status' ORDER BY doc_seq LIMIT 9`
        )
        .all(context.checkboxDocumentId) as {
        eventId: string;
        docSeq: number;
        direction: string;
        provenance: string;
        payload: string;
      }[];
      // This fixture permits one genuine long-draft ordinary save, independently
      // audited against its original FILE baseline and subsequent marker hash chain.
      const savedRows = db.$client
        .prepare(
          `SELECT event_id AS eventId, doc_seq AS docSeq,
          payload, provenance, envelope_hash AS envelopeHash, envelope_bytes AS envelopeBytes,
          coalesce_key AS coalesceKey, client_ts AS clientTs, payload_pruned_at AS pruned
          FROM canvas_doc_events WHERE document_id=? AND type='doc.saved' AND direction='upstream'
          ORDER BY doc_seq LIMIT 2`
        )
        .all(context.checkboxDocumentId) as {
        eventId: string;
        docSeq: number;
        payload: string;
        provenance: string;
        envelopeHash: string;
        envelopeBytes: number;
        coalesceKey: string | null;
        clientTs: string | null;
        pruned: string | null;
      }[];
      if (savedRows.length > 1) throw new Error('Original checkbox ordinary-save census bound');
      const savedEvents = [];
      if (savedRows.length === 1) {
        const saved = savedRows[0];
        const { StoredPageEventSchema } = await import('@dorkos/shared/canvas-channel-schemas');
        const { envelopeIdentity } =
          await import('../../../../server/src/services/canvas/doc-channel/envelope.js');
        if (context.closed) throw new Error('Original saved FILE audit retired');
        const payload: unknown = JSON.parse(saved.payload),
          provenance: unknown = JSON.parse(saved.provenance);
        if (
          !payload ||
          typeof payload !== 'object' ||
          Object.keys(payload).length !== 2 ||
          !('previousFileHash' in payload) ||
          payload.previousFileHash !== rawByteHash(Buffer.from(checkboxBaseline)) ||
          !('fileHash' in payload) ||
          typeof payload.fileHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(payload.fileHash) ||
          !provenance ||
          typeof provenance !== 'object' ||
          Object.keys(provenance).length !== 2 ||
          !('transport' in provenance) ||
          provenance.transport !== 'http' ||
          !('trust' in provenance) ||
          provenance.trust !== 'app_untrusted' ||
          saved.coalesceKey !== null ||
          saved.clientTs !== null ||
          saved.pruned !== null
        )
          throw new Error('Original ordinary-save envelope/source differs');
        const original = StoredPageEventSchema.parse({
          v: 1,
          id: saved.eventId,
          type: 'doc.saved',
          payload,
        });
        const identity = envelopeIdentity(original);
        if (identity.hash !== saved.envelopeHash || identity.bytes !== saved.envelopeBytes)
          throw new Error('Original ordinary-save envelope identity differs');
        let expectedHash = payload.fileHash;
        for (const marker of events) {
          const changed: unknown = JSON.parse(marker.payload);
          if (
            marker.docSeq <= saved.docSeq ||
            !changed ||
            typeof changed !== 'object' ||
            !('beforeFileVersion' in changed) ||
            changed.beforeFileVersion !== expectedHash ||
            !('afterFileVersion' in changed) ||
            typeof changed.afterFileVersion !== 'string' ||
            !/^[a-f0-9]{64}$/.test(changed.afterFileVersion)
          )
            throw new Error('Original saved FILE marker hash chain differs');
          expectedHash = changed.afterFileVersion;
        }
        if (
          expectedHash !== rawByteHash(physical) ||
          deliveries.some((delivery) => delivery.eventId === saved.eventId)
        )
          throw new Error('Original saved FILE physical/log-only audit differs');
        const receipt = await http.service.receipt(
          context.checkboxDocumentId,
          saved.eventId,
          actor
        );
        if (
          context.closed ||
          receipt.receipt.id !== saved.eventId ||
          receipt.receipt.docSeq !== saved.docSeq ||
          receipt.deliveries.length !== 0
        )
          throw new Error('Original saved FILE retained receipt differs');
        savedEvents.push({
          eventId: saved.eventId,
          docSeq: saved.docSeq,
          payload: original.payload,
          receipt,
        });
      }
      // Quiet native presence shares this FILE log; it is not another marker input.
      // Audit the complete reserved rows, including their native envelope identity,
      // before admitting them into the unchanged whole-document event census.
      const presenceRows = db.$client
        .prepare(
          `SELECT event_id AS eventId, doc_seq AS docSeq,
          type, direction, payload, provenance, envelope_hash AS envelopeHash,
          envelope_bytes AS envelopeBytes, received_at AS receivedAt,
          coalesce_key AS coalesceKey, client_ts AS clientTs, payload_pruned_at AS pruned
          FROM canvas_doc_events WHERE document_id=?
          AND type IN ('host.opened','host.closed','doc.viewers','host.focus')
          ORDER BY doc_seq LIMIT 33`
        )
        .all(context.checkboxDocumentId) as {
        eventId: string;
        docSeq: number;
        type: string;
        direction: string;
        payload: string;
        provenance: string;
        envelopeHash: string;
        envelopeBytes: number;
        receivedAt: string;
        coalesceKey: string | null;
        clientTs: string | null;
        pruned: string | null;
      }[];
      if (presenceRows.length > 32) throw new Error('Original checkbox presence census bound');
      if (presenceRows.length) {
        const { StoredPageEventSchema } = await import('@dorkos/shared/canvas-channel-schemas');
        const { envelopeIdentity } =
          await import('../../../../server/src/services/canvas/doc-channel/envelope.js');
        if (context.closed) throw new Error('Original checkbox presence audit retired');
        let views = 0,
          publishedViews = 0,
          sequence = 0;
        const ids = new Set<string>();
        for (const row of presenceRows) {
          const payload: unknown = JSON.parse(row.payload),
            provenance: unknown = JSON.parse(row.provenance);
          const focus = row.type === 'host.focus';
          if (
            !Number.isSafeInteger(row.docSeq) ||
            row.docSeq <= sequence ||
            ids.has(row.eventId) ||
            row.coalesceKey !== null ||
            row.clientTs !== null ||
            row.pruned !== null ||
            typeof row.receivedAt !== 'string' ||
            !Number.isFinite(Date.parse(row.receivedAt)) ||
            new Date(row.receivedAt).toISOString() !== row.receivedAt ||
            !payload ||
            typeof payload !== 'object' ||
            Object.keys(payload).length !== 1 ||
            !provenance ||
            typeof provenance !== 'object' ||
            (focus
              ? row.direction !== 'upstream' ||
                Object.keys(provenance).length !== 2 ||
                !('transport' in provenance) ||
                provenance.transport !== 'http' ||
                !('trust' in provenance) ||
                provenance.trust !== 'app_untrusted'
              : row.direction !== 'system' ||
                Object.keys(provenance).length !== 1 ||
                !('source' in provenance) ||
                provenance.source !== 'doc-channel-presence') ||
            deliveries.some((delivery) => delivery.eventId === row.eventId)
          )
            throw new Error('Original checkbox native presence identity differs');
          const original = StoredPageEventSchema.parse({
            v: 1,
            id: row.eventId,
            type: row.type,
            payload,
          });
          const identity = envelopeIdentity(original);
          if (identity.hash !== row.envelopeHash || identity.bytes !== row.envelopeBytes)
            throw new Error('Original checkbox presence envelope differs');
          if (focus) {
            if (!('focused' in payload) || typeof payload.focused !== 'boolean')
              throw new Error('Original checkbox native focus payload differs');
          } else if (row.type === 'doc.viewers') {
            if (!('views' in payload) || payload.views !== views || views === publishedViews)
              throw new Error('Original checkbox native viewer transition differs');
            publishedViews = views;
          } else {
            if (
              !('mounts' in payload) ||
              typeof payload.mounts !== 'number' ||
              !Number.isSafeInteger(payload.mounts) ||
              payload.mounts < 1 ||
              (row.type === 'host.opened' && payload.mounts !== 1)
            )
              throw new Error('Original checkbox native mount payload differs');
            views += row.type === 'host.opened' ? payload.mounts : -payload.mounts;
            if (!Number.isSafeInteger(views) || views < 0)
              throw new Error('Original checkbox native mount count differs');
          }
          sequence = row.docSeq;
          ids.add(row.eventId);
        }
        if (views !== publishedViews)
          throw new Error('Original checkbox native viewer publication missing');
      }
      const census = db.$client
        .prepare('SELECT count(*) AS n FROM canvas_doc_events WHERE document_id=?')
        .get(context.checkboxDocumentId) as { n: number };
      // One initial status per input and at most routed/start/done per each of
      // the two original batches. No other event kind or provenance is ignored.
      if (
        systemStatuses.length > 8 ||
        census.n !== events.length + systemStatuses.length + savedRows.length + presenceRows.length
      )
        throw new Error('Original checkbox full event census differs');
      const statusReceipts = db.$client
        .prepare(
          `SELECT receipt.id AS receiptId, batch.batch_id AS batchId
          FROM canvas_doc_batches AS batch JOIN session_message_acceptance_receipts AS receipt
          ON receipt.id=batch.admission_receipt_id WHERE batch.document_id=?
          AND receipt.source_kind='document_event_batch' AND receipt.source_id=batch.batch_id
          AND receipt.source_generation=batch.generation LIMIT 3`
        )
        .all(context.checkboxDocumentId) as { receiptId: string; batchId: string }[];
      if (statusReceipts.length > 2) throw new Error('Original checkbox receipt census bound');
      for (const row of systemStatuses) {
        const provenance: unknown = JSON.parse(row.provenance);
        const payload: unknown = JSON.parse(row.payload);
        if (
          row.direction !== 'system' ||
          !provenance ||
          typeof provenance !== 'object' ||
          Object.keys(provenance).length !== 1 ||
          !('source' in provenance) ||
          provenance.source !== 'doc-channel-service' ||
          !payload ||
          typeof payload !== 'object' ||
          !('routeId' in payload) ||
          payload.routeId !== 'native-checkbox' ||
          !('status' in payload) ||
          typeof payload.status !== 'string' ||
          !['pending', 'waiting', 'routed', 'turn_started', 'turn_done'].includes(payload.status) ||
          'eventId' in payload === 'receiptId' in payload ||
          ('eventId' in payload && !events.some((event) => event.eventId === payload.eventId)) ||
          !('batchId' in payload) ||
          !batches.some((batch) => batch.batchId === payload.batchId) ||
          ('receiptId' in payload &&
            (typeof payload.receiptId !== 'string' ||
              !statusReceipts.some(
                (receipt) =>
                  receipt.receiptId === payload.receiptId && receipt.batchId === payload.batchId
              )))
        )
          throw new Error('Original checkbox service status correlation differs');
      }
      const admissions = db.$client
        .prepare('SELECT count(*) AS n FROM room_doc_admissions WHERE document_id=?')
        .get(context.checkboxDocumentId) as { n: number };
      const spend = db.$client
        .prepare(
          `SELECT count(*) AS n FROM room_turn_spend AS spend
            WHERE EXISTS (SELECT 1 FROM room_doc_admissions AS admission
              WHERE admission.document_id=? AND admission.room_id=spend.room_id
                AND admission.claimed_at_ms=spend.at)`
        )
        .get(context.checkboxDocumentId) as { n: number };
      const privateAdmissions = db.$client
        .prepare(
          `SELECT count(*) AS n FROM canvas_doc_batches AS batch
            JOIN session_message_acceptance_receipts AS receipt ON receipt.id=batch.admission_receipt_id
            WHERE batch.document_id=?`
        )
        .get(context.checkboxDocumentId) as { n: number };
      const native = readTestModeOriginalScenarioCounts(runtime);
      if (!native || context.closed || deliveries.length > 2 || batches.length > 2)
        throw new Error('Original checkbox native DATA unavailable');
      return {
        documentId: context.checkboxDocumentId,
        approvalBindings: readOriginalApprovalBindings(context.checkboxDocumentId),
        baselineRestored: rawByteHash(physical) === rawByteHash(Buffer.from(checkboxBaseline)),
        events: events.map(({ eventId, docSeq }) => ({ eventId, docSeq })),
        receipts,
        savedEvents,
        systemStatuses: systemStatuses.map(({ eventId, docSeq }) => ({ eventId, docSeq })),
        deliveries,
        batches,
        admissions: admissions.n,
        spend: spend.n,
        privateAdmissions: privateAdmissions.n,
        scenarioStarts: native.scenarioStarts,
        targetLocked: originalTargetLocked(sessionId),
      };
    },
  };
}
