/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */

import { canonical, digest, type WriterOperation } from '../writer.js';

import {
  requireOriginalConsumerControls,
  requireOriginalConsumerPublished,
} from '../channel-store.js';
/** Original fixed common controls; no supplied mutable context or original-key issuer. */
export function createOriginalConsumerCommonControls(ownerKey: object) {
  const context = requireOriginalConsumerControls(ownerKey);
  const {
    vault,
    hostBootstrap,
    clearRoomService,
    clearCanvasService,
    setAgentHomeRegistry,
    replayServiceCurrentDoc,
    submitCurrentDocEvent,
    inspectServiceCurrentDocReceipt,
    file,
    db,
    sessionId,
    principals,
    budget,
    rooms,
    http,
    actor,
    documentId,
    initial,
    resumeRecord,
    condition,
    setMessageQueueStore,
    setPrivateSessionMessageAcceptanceService,
    adoptAcceptedPrivateMessages,
    resetMessageDispatcher,
    suspendPrivateDispatches,
    getOrCreateProjector,
    disposeProjector,
    scenarioStore,
    queue,
    admission,
    runtime,
    captureTestModeOriginalCanonicalRestart,
    readTestModeOriginalCanonicalRestart,
    setSessionEventStore,
    pumpLifetime,
    readTestModeOriginalScenarioCounts,
    managementRouter,
    approvalRouter,
    readRoomScenarioData,
  } = context;
  return {
    readOriginalFrameDeclarationAbsent() {
      if (context.closed) throw new Error('Original frame fixture retired');
      const row = db.$client
        .prepare('SELECT declaration FROM canvas_doc_channels WHERE document_id=?')
        .get(documentId);
      if (!row || typeof row !== 'object' || !('declaration' in row))
        throw new Error('Original frame declaration row unavailable');
      return row.declaration === null;
    },
    file,
    db,
    rooms,
    budget,
    principals,
    http,
    managementRouter,
    approvalRouter,
    actor,
    documentId,
    initial,
    runtime,
    sessionId,
    roomId: context.roomId,
    /** Read-only provider-boundary DATA from this exact native source owner.
     * No supplied batch/principal/counter can select or create evidence.
     */
    /** Parameterless fixture action; the native owner verifies its retained input pair. */
    startNativeEmissionIntegrityObservation: () => {
      if (context.closed || !context.integrityControl)
        throw new Error('Original native integrity observation unavailable');
      context.integrityControl.start();
      return Object.freeze({ started: true as const });
    },
    readNativeEmissionIntegrityData: () => {
      if (context.closed || !context.integrityControl)
        throw new Error('Original native integrity DATA unavailable');
      return context.integrityControl.read(); // Never arms/restores or reads a sabotaged SQL builder.
    },
    readOriginalRoomScenarioData: async () => {
      if (context.closed) throw new Error('Owned native Room evidence unavailable');
      const data = await readRoomScenarioData();
      if (context.closed) throw new Error('Owned native Room evidence retired');
      return data;
    },
    producerCounts: () => {
      if (hostBootstrap)
        throw new Error('Actual host producer evidence requires its original native stream owner');
      const native = readTestModeOriginalScenarioCounts(runtime);
      if (!native) throw new Error('Original direct fixture native producer DATA unavailable');
      return Object.freeze({ physicalStarts: native.scenarioStarts });
    },
    admit: () => {
      if (context.closed) throw new Error('Owned fixture retired');
      if (!admission)
        throw new Error('Native Room admission requires its original COMMIT/FIRST owner');
      const row = db.$client
        .prepare(
          "SELECT batch_id FROM canvas_doc_batches WHERE document_id=? AND status IN ('pending','waiting')"
        )
        .get(documentId) as { batch_id: string } | undefined;
      if (!row) throw new Error('Original pending batch unavailable');
      return admission.admit(row.batch_id);
    },
    startAccepted: () => {
      if (context.closed) throw new Error('Owned fixture retired');
      if (!admission) throw new Error('Private session pump cannot start a Room document turn');
      // Own this assembly in an isolated fixture process; global dispatcher ports
      // are genuine original owners and must not be borrowed from another app.
      setMessageQueueStore(queue);
      setPrivateSessionMessageAcceptanceService(admission.acceptance);
      context.pumpInstalled = true;
      return adoptAcceptedPrivateMessages({
        sessionId,
        runtime,
        cwd: vault.root,
        projector: getOrCreateProjector(sessionId),
        privateDispatchSignal: pumpLifetime.signal,
      });
    },
    replay: () => {
      if (context.closed) throw new Error('Owned fixture retired');
      return replayServiceCurrentDoc(http.service, documentId, actor);
    },
    emit: (event: unknown) => {
      if (context.closed) throw new Error('Owned fixture retired');
      return submitCurrentDocEvent(http.service, documentId, event, actor, condition);
    },
    inspect: (id: string) => {
      if (context.closed) throw new Error('Owned fixture retired');
      return inspectServiceCurrentDocReceipt(http.service, documentId, id, actor, condition);
    },
    confirm: async (op: WriterOperation) => {
      if (context.closed) throw new Error('Owned fixture retired');
      const inspected = await inspectServiceCurrentDocReceipt(
        http.service,
        documentId,
        op.request.operationId,
        actor,
        condition
      );
      if (inspected.kind !== 'receipt') throw new Error('Original receipt unavailable');
      const event = http.channels.getEvent(documentId, op.request.operationId);
      if (
        !event ||
        digest(
          canonical({
            v: 1,
            id: event.eventId,
            type: event.type,
            payload: event.payload,
            ...(event.coalesceKey ? { coalesceKey: event.coalesceKey } : {}),
          })
        ) !== op.envelopeHash
      )
        throw new Error('Original event envelope conflict');
      return inspected.event;
    },
    close: () => {
      if (context.retirement) return context.retirement;
      context.closed = true;
      context.retirement = Promise.resolve().then(async () => {
        let failed = false,
          first: unknown;
        const drain = async (run: () => unknown) => {
          try {
            await run();
          } catch (cause) {
            if (!failed) {
              failed = true;
              first = cause;
            }
          }
        };
        // The checkbox pump can be held in the original private dispatcher.
        // Cancel and positively retire that owner before joining its pump work.
        await drain(() => pumpLifetime.abort());
        let privatePumpClosed = !context.pumpInstalled;
        // Start suspension, but do not join launches before independently stopping
        // the original producers whose retirement may be needed by those launches.
        const privatePumpStop = context.pumpInstalled
          ? drain(async () => {
              await suspendPrivateDispatches(pumpLifetime.signal);
              privatePumpClosed = true;
            })
          : Promise.resolve();
        const originalDocOperationsStop = context.stopDocOperations;
        const docOperationsStop = originalDocOperationsStop
          ? drain(async () => {
              await originalDocOperationsStop();
              context.docOperationsClosed = true;
            })
          : Promise.resolve();
        const initialMcpStop = context.stopMcpAppFixture;
        const mcpStop = initialMcpStop ? drain(initialMcpStop) : Promise.resolve();
        const initialWidgetStop = context.stopWidgetProducer;
        const initialRoomScheduler = context.roomScheduler;
        const initialIntegrityControl = context.integrityControl;
        const widgetStop = initialWidgetStop ? drain(initialWidgetStop) : Promise.resolve();
        const roomStop = initialRoomScheduler
          ? drain(async () => {
              await initialRoomScheduler.stop();
              context.roomSchedulerClosed = true;
            })
          : Promise.resolve();
        const integrityStop = drain(async () => {
          if (initialIntegrityControl) {
            await initialIntegrityControl.stop();
            context.integrityClosed = true;
          }
        });
        if (context.stopDocNotifications) await drain(context.stopDocNotifications);
        if (context.canonicalSetup) await drain(() => context.canonicalSetup);
        let canonicalProducerClosed = !context.canonicalAnchorStarted;
        if (context.canonicalAnchorStarted && !context.canonicalCapture)
          await drain(() => {
            context.canonicalCapture = captureTestModeOriginalCanonicalRestart(
              runtime,
              sessionId,
              db
            );
          });
        if (context.canonicalCapture)
          await drain(() => {
            const observed = readTestModeOriginalCanonicalRestart(
              runtime,
              context.canonicalCapture!,
              db
            );
            if (!observed.closed) throw new Error('Original canonical producer closure UNKNOWN');
            canonicalProducerClosed = true;
          });
        await drain(() => requireOriginalConsumerPublished(ownerKey).stopOriginalReviewedReplay());
        if (context.reviewedSetupWork) await drain(() => context.reviewedSetupWork);
        if (context.savedOpenStarted)
          await drain(() => requireOriginalConsumerPublished(ownerKey).stopOriginalSavedDispatch());
        if (context.savedSetupWork) await drain(() => context.savedSetupWork);
        if (context.savedPumpWork) await drain(() => context.savedPumpWork);
        if (context.selectionOpenStarted)
          await drain(() =>
            requireOriginalConsumerPublished(ownerKey).stopOriginalSelectionDispatch()
          );
        if (context.selectionSetupWork) await drain(() => context.selectionSetupWork);
        if (context.selectionPumpWork) await drain(() => context.selectionPumpWork);
        if (context.checkboxSetupWork) await Promise.allSettled([context.checkboxSetupWork]);
        if (context.checkboxPumpWork) await Promise.allSettled([context.checkboxPumpWork]);
        if (context.mcpSetupWork) await drain(() => context.mcpSetupWork);
        await mcpStop;
        if (context.stopMcpAppFixture && context.stopMcpAppFixture !== initialMcpStop)
          await drain(context.stopMcpAppFixture);
        if (context.mcpPumpWork) await drain(() => context.mcpPumpWork);
        await widgetStop;
        if (context.widgetPatchWork) await Promise.allSettled([context.widgetPatchWork]);
        const lateWidgetStop = context.stopWidgetProducer;
        if (lateWidgetStop && lateWidgetStop !== initialWidgetStop) {
          context.widgetProducerClosed = false;
          await drain(async () => {
            await lateWidgetStop();
            context.widgetProducerClosed = true;
          });
        }
        await roomStop;
        await integrityStop;
        const lateRoomScheduler = context.roomScheduler;
        if (lateRoomScheduler && lateRoomScheduler !== initialRoomScheduler) {
          context.roomSchedulerClosed = false;
          await drain(async () => {
            await lateRoomScheduler.stop();
            context.roomSchedulerClosed = true;
          });
        }
        const lateIntegrityControl = context.integrityControl;
        if (lateIntegrityControl && lateIntegrityControl !== initialIntegrityControl) {
          context.integrityClosed = false;
          await drain(async () => {
            await lateIntegrityControl.stop();
            context.integrityClosed = true;
          });
        }
        await privatePumpStop;
        await docOperationsStop;
        if (context.pumpInstalled) {
          if (privatePumpClosed) {
            await drain(resetMessageDispatcher);
            await drain(() => setPrivateSessionMessageAcceptanceService(undefined));
            await drain(() => setMessageQueueStore(undefined));
          }
        }
        await drain(async () => {
          if (context.stopHttpFileWrites) {
            await context.stopHttpFileWrites();
            context.httpFileWritesClosed = true;
          }
        });
        const nativeOwnersClosed =
          context.mcpFixtureClosed &&
          context.docNotificationsClosed &&
          context.docOperationsClosed &&
          (!context.reviewedControl || context.reviewedControl.isClosed()) &&
          context.selectionDispatchClosed &&
          context.savedDispatchClosed &&
          canonicalProducerClosed &&
          context.privateCanonicalOwnerClosed &&
          context.widgetProducerClosed &&
          privatePumpClosed &&
          (!context.integrityConstructionStarted || context.integrityClosed) &&
          (!context.httpConstructionStarted || context.httpFileWritesClosed) &&
          (!context.roomScheduler || context.roomSchedulerClosed);
        // The owned test trigger is retired only after its original HTTP writer/dispatcher close positively.
        if (nativeOwnersClosed && context.savedFailureArmed)
          await drain(() => {
            db.$client.exec('DROP TRIGGER original_browser_saved_refusal');
            context.savedFailureArmed = false;
          });
        // Positive captured drains decide custody. A raw failure/UNKNOWN retains shared Room/Db/files.
        if (nativeOwnersClosed) {
          await drain(() => context.stopFollowingSessionRekeys?.());
          await drain(() => context.disposeRoomCanvas?.());
          await drain(() => clearRoomService(rooms.service));
          await drain(() => clearCanvasService(rooms.canvas));
        }
        await drain(() => scenarioStore.clearSession(sessionId));
        if (resumeRecord.sessionId !== sessionId)
          await drain(() => scenarioStore.clearSession(resumeRecord.sessionId));
        await drain(() => disposeProjector(sessionId));
        if (resumeRecord.sessionId !== sessionId)
          await drain(() => disposeProjector(resumeRecord.sessionId));
        if (hostBootstrap) await drain(() => setSessionEventStore(undefined));
        if (nativeOwnersClosed && context.agentHomeRegistryInstalled)
          await drain(() => {
            setAgentHomeRegistry(undefined);
            context.agentHomeRegistryInstalled = false;
          });
        if (nativeOwnersClosed) await drain(() => db.$client.close());
        else
          await drain(() => {
            throw new Error('Original native fixture owner closure UNKNOWN');
          });
        if (failed) throw first;
        // Only positively drained native owners and an actual successful Db close permit reopen.
        resumeRecord.closed = true;
      });
      return context.retirement;
    },
  };
}
