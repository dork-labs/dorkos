/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */

import { join } from 'node:path';

import { requireOriginalConsumerControls } from '../channel-store.js';
/** Original fixed saved controls; no supplied mutable context or original-key issuer. */
export function createOriginalConsumerSavedControls(ownerKey: object) {
  const context = requireOriginalConsumerControls(ownerKey);
  const {
    vault,
    hostBootstrap,
    target,
    file,
    opened,
    db,
    agentId,
    sessionId,
    rooms,
    http,
    actor,
    readOriginalApprovalBindings,
    documentId,
    setMessageQueueStore,
    setPrivateSessionMessageAcceptanceService,
    adoptAcceptedPrivateMessages,
    getOrCreateProjector,
    queue,
    admission,
    runtime,
    originalTargetLocked,
    pumpLifetime,
    savedBaseline,
    readFile,
    writeFile,
    rawByteHash,
    readTestModeOriginalScenarioCounts,
  } = context;
  return {
    openDocumentSaveFile() {
      if (
        !hostBootstrap ||
        target !== 'session' ||
        context.closed ||
        context.savedRetired ||
        context.savedOpenStarted
      )
        throw new Error('Original saved FILE setup unavailable');
      context.savedOpenStarted = true;
      context.savedSetupWork = (async () => {
        context.savedPath = join(vault.root, 'native-browser-document-save.md');
        await writeFile(context.savedPath, savedBaseline);
        if (context.closed || context.savedRetired)
          throw new Error('Original saved FILE setup retired');
        const { SESSION_AGENT_AUTHOR } =
          await import('../../../../server/src/services/canvas/scopes.js');
        if (context.closed || context.savedRetired)
          throw new Error('Original saved FILE setup retired');
        context.savedDocumentId = rooms.canvas.open(
          context.scope,
          SESSION_AGENT_AUTHOR,
          {
            type: 'file',
            sourcePath: context.savedPath,
            language: 'markdown',
            title: 'Native ordinary save file',
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
          context.savedDocumentId,
          {
            routes: [
              {
                id: 'native-saved',
                on: 'doc.saved',
                to: 'agent:owner',
                turn: { mode: 'immediate', maxBatch: 1 },
              },
            ],
          },
          actor,
          agentId
        );
        return { documentId: context.savedDocumentId };
      })();
      return context.savedSetupWork;
    },
    /** Fixed real SQLite failure of only this original FILE's next saved-event INSERT. */
    armOriginalSavedInsertFailure() {
      if (
        !hostBootstrap ||
        target !== 'session' ||
        context.closed ||
        context.savedRetired ||
        !context.savedDocumentId ||
        context.savedFailureStarted ||
        !context.savedPumpStarted
      )
        throw new Error('Original saved-event refusal unavailable');
      context.savedFailureStarted = true;
      const literal = context.savedDocumentId.replace(/'/g, "''");
      db.$client
        .exec(`CREATE TEMP TRIGGER original_browser_saved_refusal BEFORE INSERT ON canvas_doc_events
          WHEN NEW.document_id='${literal}' AND NEW.type='doc.saved'
          BEGIN SELECT RAISE(ABORT,'original browser doc.saved INSERT refusal'); END`);
      context.savedFailureArmed = true;
      return { armed: true };
    },
    /** No caller-supplied selector: audit only the same original opened FILE/event/native batch. */
    async readOriginalSavedData() {
      if (context.closed || !context.savedDocumentId || !context.savedPath)
        throw new Error('Original saved FILE audit unavailable');
      const bytes = await readFile(context.savedPath);
      if (context.closed) throw new Error('Original saved FILE audit retired');
      const events = db.$client
        .prepare(
          `SELECT event_id AS eventId, doc_seq AS docSeq, payload
          FROM canvas_doc_events WHERE document_id=? AND type='doc.saved' AND direction='upstream'
          ORDER BY doc_seq LIMIT 2`
        )
        .all(context.savedDocumentId) as { eventId: string; docSeq: number; payload: string }[];
      const deliveries = db.$client
        .prepare(
          `SELECT delivery.event_id AS eventId, delivery.route_id AS routeId,
          delivery.batch_id AS batchId, batch.grant_id AS grantId, delivery.status
          FROM canvas_doc_deliveries AS delivery LEFT JOIN canvas_doc_batches AS batch
          ON batch.document_id=delivery.document_id AND batch.batch_id=delivery.batch_id
          WHERE delivery.document_id=? LIMIT 2`
        )
        .all(context.savedDocumentId) as {
        eventId: string;
        routeId: string;
        batchId: string | null;
        grantId: string | null;
        status: string;
      }[];
      const admissions = db.$client
        .prepare(
          `SELECT receipt.id, receipt.state, receipt.source_id AS batchId,
          receipt.source_generation AS generation, receipt.turn_start_seq AS turnStartSeq
          FROM session_message_acceptance_receipts AS receipt JOIN canvas_doc_batches AS batch
          ON batch.admission_receipt_id=receipt.id WHERE batch.document_id=?
          AND receipt.source_kind='document_event_batch' AND receipt.source_id=batch.batch_id
          AND receipt.source_generation=batch.generation LIMIT 2`
        )
        .all(context.savedDocumentId) as {
        id: string;
        state: string;
        batchId: string;
        generation: string;
        turnStartSeq: number | null;
      }[];
      const counts = readTestModeOriginalScenarioCounts(runtime);
      if (
        !counts ||
        context.closed ||
        events.length > 1 ||
        deliveries.length > 1 ||
        admissions.length > 1
      )
        throw new Error('Original saved FILE native census unavailable');
      return {
        documentId: context.savedDocumentId,
        approvalBindings: readOriginalApprovalBindings(context.savedDocumentId),
        fileHash: rawByteHash(bytes),
        baselineHash: rawByteHash(Buffer.from(savedBaseline)),
        failureArmed: context.savedFailureArmed,
        events: events.map((event) => ({
          ...event,
          payload: JSON.parse(event.payload) as unknown,
        })),
        deliveries,
        admissions,
        scenarioStarts: counts.scenarioStarts,
      };
    },
    /** Original acceptance/private dispatcher proves FIRST separately from the saved-event receipt. */
    pumpOriginalSavedDocument() {
      if (
        !hostBootstrap ||
        target !== 'session' ||
        context.closed ||
        context.savedRetired ||
        !context.savedDocumentId ||
        !admission ||
        context.savedPumpStarted ||
        originalTargetLocked(sessionId)
      )
        throw new Error('Original saved FILE dispatch unavailable');
      context.savedPumpStarted = true;
      context.savedDispatchClosed = false;
      context.savedPumpWork = (async () => {
        const rows = db.$client
          .prepare(
            `SELECT batch_id AS batchId FROM canvas_doc_batches
            WHERE document_id=? AND route_id='native-saved' AND status IN ('pending','waiting') LIMIT 2`
          )
          .all(context.savedDocumentId) as { batchId: string }[];
        if (rows.length !== 1) throw new Error('Original saved FILE batch unavailable');
        admission.admit(rows[0].batchId);
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
        if (context.closed || context.savedRetired)
          throw new Error('Original saved FILE dispatcher retired');
        return { pumped: true };
      })();
      return context.savedPumpWork;
    },
    /** Cancel the original selection pump before any owning action joins its settlement. */
  };
}
