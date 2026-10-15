/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */

import { join } from 'node:path';

import { requireOriginalConsumerControls } from '../channel-store.js';
/** Original fixed selection controls; no supplied mutable context or original-key issuer. */
export function createOriginalConsumerSelectionControls(ownerKey: object) {
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
    suspendPrivateDispatches,
    getOrCreateProjector,
    queue,
    admission,
    runtime,
    originalTargetLocked,
    pumpLifetime,
    selectionBaseline,
    readFile,
    writeFile,
    rawByteHash,
    readTestModeOriginalScenarioCounts,
  } = context;
  return {
    stopOriginalSelectionDispatch() {
      if (context.selectionRetirement) return context.selectionRetirement;
      context.selectionRetired = true;
      context.selectionRetirement = (async () => {
        if (!context.selectionOpenStarted) return;
        let failed = false,
          first: unknown;
        const remember = (cause: unknown) => {
          if (!failed) {
            failed = true;
            first = cause;
          }
        };
        try {
          pumpLifetime.abort();
        } catch (cause) {
          remember(cause);
        }
        if (context.selectionPumpStarted) {
          try {
            await suspendPrivateDispatches(pumpLifetime.signal);
            context.selectionDispatchClosed = true;
          } catch (cause) {
            remember(cause);
          }
        }
        if (failed) throw first;
      })();
      return context.selectionRetirement;
    },
    /** Agent-born FILE declaration only. Its route is approved by the actual operator UI. */
    openSelectionFile() {
      if (
        !hostBootstrap ||
        target !== 'session' ||
        context.closed ||
        context.selectionRetired ||
        context.selectionOpenStarted
      )
        throw new Error('Original selected FILE setup unavailable');
      context.selectionOpenStarted = true;
      context.selectionSetupWork = (async () => {
        context.selectionPath = join(vault.root, 'native-browser-selection.md');
        await writeFile(context.selectionPath, selectionBaseline);
        if (context.closed || context.selectionRetired)
          throw new Error('Original selected FILE setup retired');
        const { SESSION_AGENT_AUTHOR } =
          await import('../../../../server/src/services/canvas/scopes.js');
        if (context.closed || context.selectionRetired)
          throw new Error('Original selected FILE setup retired');
        context.selectionDocumentId = rooms.canvas.open(
          context.scope,
          SESSION_AGENT_AUTHOR,
          {
            type: 'file',
            sourcePath: context.selectionPath,
            language: 'markdown',
            title: 'Native selected source',
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
          context.selectionDocumentId,
          {
            routes: [
              {
                id: 'native-selection',
                on: 'selection.ask',
                to: 'agent:owner',
                turn: { mode: 'immediate', maxBatch: 1 },
              },
            ],
          },
          actor,
          agentId
        );
        return { documentId: context.selectionDocumentId };
      })();
      return context.selectionSetupWork;
    },
    /** Exact opened selected-source DATA; no supplied document/event/receipt chooses this audit. */
    async readOriginalSelectionData() {
      if (context.closed || !context.selectionDocumentId || !context.selectionPath)
        throw new Error('Original selected-source audit unavailable');
      const physical = await readFile(context.selectionPath);
      if (context.closed) throw new Error('Original selected-source audit retired');
      const events = db.$client
        .prepare(
          `SELECT event_id AS eventId, doc_seq AS docSeq,
          payload FROM canvas_doc_events WHERE document_id=? AND type='selection.ask' ORDER BY doc_seq LIMIT 2`
        )
        .all(context.selectionDocumentId) as { eventId: string; docSeq: number; payload: string }[];
      if (events.length > 1) throw new Error('Original selection event census bound');
      const deliveries = db.$client
        .prepare(
          `SELECT event_id AS eventId, route_id AS routeId,
          batch_id AS batchId, status FROM canvas_doc_deliveries WHERE document_id=? LIMIT 2`
        )
        .all(context.selectionDocumentId) as {
        eventId: string;
        routeId: string;
        batchId: string | null;
        status: string;
      }[];
      const admissions = db.$client
        .prepare(
          `SELECT receipt.id, receipt.state,
          receipt.source_id AS batchId, receipt.source_generation AS generation,
          receipt.turn_start_seq AS turnStartSeq FROM session_message_acceptance_receipts AS receipt
          JOIN canvas_doc_batches AS batch ON batch.admission_receipt_id=receipt.id
          WHERE batch.document_id=? LIMIT 2`
        )
        .all(context.selectionDocumentId) as {
        id: string;
        state: string;
        batchId: string;
        generation: string;
        turnStartSeq: number | null;
      }[];
      const counts = readTestModeOriginalScenarioCounts(runtime);
      if (!counts || deliveries.length > 1 || admissions.length > 1 || context.closed)
        throw new Error('Original selection native census unavailable');
      return {
        documentId: context.selectionDocumentId,
        approvalBindings: readOriginalApprovalBindings(context.selectionDocumentId),
        fileUnchanged: rawByteHash(physical) === rawByteHash(Buffer.from(selectionBaseline)),
        events: events.map((event) => ({
          ...event,
          payload: JSON.parse(event.payload) as unknown,
        })),
        deliveries,
        admissions,
        scenarioStarts: counts.scenarioStarts,
      };
    },
    /** Same original private admission and dispatcher; the receipt itself never creates FIRST. */
    pumpOriginalSelection() {
      if (
        !hostBootstrap ||
        target !== 'session' ||
        context.closed ||
        !context.selectionDocumentId ||
        !admission ||
        context.selectionRetired ||
        context.selectionPumpStarted ||
        originalTargetLocked(sessionId)
      )
        throw new Error('Original selection dispatch unavailable');
      context.selectionPumpStarted = true;
      context.selectionDispatchClosed = false;
      context.selectionPumpWork = (async () => {
        const rows = db.$client
          .prepare(
            `SELECT batch_id AS batchId FROM canvas_doc_batches
            WHERE document_id=? AND route_id='native-selection' AND status IN ('pending','waiting') LIMIT 2`
          )
          .all(context.selectionDocumentId) as { batchId: string }[];
        if (rows.length !== 1) throw new Error('Original selected batch unavailable');
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
        if (context.closed) throw new Error('Original selection dispatcher retired');
        return { pumped: true };
      })();
      return context.selectionPumpWork;
    },
    /** Original agent-born FILE source and consumed operator approval; no replacement writer. */
  };
}
