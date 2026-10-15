/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */

import { canonical } from '../writer.js';

import { requireOriginalConsumerControls } from '../channel-store.js';
/** Original fixed canonical controls; no supplied mutable context or original-key issuer. */
export function createOriginalConsumerCanonicalControls(ownerKey: object) {
  const context = requireOriginalConsumerControls(ownerKey);
  const {
    vault,
    hostBootstrap,
    target,
    resume,
    db,
    agentId,
    sessionId,
    rooms,
    documentId,
    resumeRecord,
    getOrCreateProjector,
    scenarioStore,
    queue,
    runtime,
    originalTargetLocked,
    captureTestModeOriginalCanonicalRestart,
    readTestModeOriginalCanonicalRestart,
    readRoomStoreGrantedDocTargetBinding,
    acquireWidgetLock,
    releaseWidgetLock,
    interruptPrivateCanonical,
    DetachedTurnLifecycle,
    sendTestModeOriginalLockedMessage,
  } = context;
  return {
    movePrivateCanonical() {
      if (
        context.closed ||
        target !== 'session' ||
        hostBootstrap ||
        resume ||
        context.privateCanonicalStarted ||
        context.pumpInstalled
      )
        throw new Error('Original private canonical producer unavailable');
      context.privateCanonicalStarted = true;
      context.privateCanonicalOwnerClosed = false;
      context.canonicalSetup = Promise.resolve().then(async () => {
        const {
          readTestModeOriginalCanonicalSessionId,
          moveTestModeOriginalLockedAcquisition,
          readTestModeOriginalScenarioEvidence,
        } = await import('../../../../server/src/services/runtimes/test-mode/test-mode-runtime.js');
        const { interactionGate } =
          await import('../../../../server/src/services/runtimes/test-mode/interaction-gate.js');
        const { createCanonicalRekey } =
          await import('../../../../server/src/services/session/turn-identity/canonical-rekey.js');
        const { rekeyProjector } =
          await import('../../../../server/src/services/session/session-state-projector.js');
        const holder = new DetachedTurnLifecycle(),
          clientId = 'original-private-consumer-rekey',
          lockToken = Symbol(clientId);
        let key = sessionId,
          acquired = false,
          producerClosed = false;
        let stream: ReturnType<typeof sendTestModeOriginalLockedMessage> = undefined;
        let originalReturn: (() => Promise<unknown>) | undefined;
        let failed = false,
          first: unknown;
        const remember = (cause: unknown) => {
          if (!failed) {
            failed = true;
            first = cause;
          }
        };
        const stop = async () => {
          if (originalReturn) {
            try {
              const interrupt = Promise.resolve().then(() => interruptPrivateCanonical(key));
              const returning = Promise.resolve().then(originalReturn);
              await Promise.allSettled([interrupt.catch(remember), returning.catch(remember)]);
              if (failed) throw first;
              if (
                !stream ||
                readTestModeOriginalScenarioEvidence(runtime, stream)?.retired !== true
              )
                throw new Error('Original private canonical stream closure UNKNOWN');
              producerClosed = true;
            } catch (cause) {
              remember(cause);
            }
          } else producerClosed = !acquired;
          if (producerClosed) {
            try {
              if (acquired) releaseWidgetLock(key, clientId, lockToken);
            } catch (cause) {
              remember(cause);
            }
            try {
              holder.close();
            } catch (cause) {
              remember(cause);
            }
          }
          if (
            !failed &&
            (!acquired ||
              (context.canonicalCapture &&
                readTestModeOriginalCanonicalRestart(runtime, context.canonicalCapture, db).closed))
          )
            context.privateCanonicalOwnerClosed = true;
          if (failed) throw first;
        };
        try {
          acquired = acquireWidgetLock(sessionId, clientId, holder, lockToken);
          if (!acquired) throw new Error('Original private canonical producer busy');
          scenarioStore.setForSession(sessionId, 'native-canonical-rekey');
          getOrCreateProjector(sessionId, vault.root);
          stream = sendTestModeOriginalLockedMessage(
            runtime,
            sessionId,
            'Original writer canonical restart',
            { cwd: vault.root },
            holder,
            sessionId
          );
          if (!stream) throw new Error('Original private canonical stream missing');
          originalReturn = stream.return.bind(stream, undefined);
          if ((await stream.next()).value?.type !== 'session_status')
            throw new Error('Original private canonical entry missing');
          context.canonicalCapture = captureTestModeOriginalCanonicalRestart(
            runtime,
            sessionId,
            db
          );
          context.canonicalAnchorStarted = true;
          const waiting = await stream.next();
          if (
            waiting.value?.type !== 'text_delta' ||
            waiting.value.data.text !== 'NATIVE_CANONICAL_REKEY_WAITING'
          )
            throw new Error('Original private canonical barrier missing');
          let moveSettled = false;
          const moving = stream.next().then(
            (value) => {
              moveSettled = true;
              return { value };
            },
            (cause) => {
              moveSettled = true;
              return { cause };
            }
          );
          const stepDeadline = Date.now() + 5000;
          while (!interactionGate.step(sessionId)) {
            if (moveSettled || Date.now() >= stepDeadline) break;
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          if (!moveSettled && Date.now() >= stepDeadline)
            throw new Error('Original canonical interaction barrier unavailable');
          const moved = await moving;
          if ('cause' in moved) throw moved.cause;
          if (moved.value.value?.type !== 'session_status')
            throw new Error('Original native canonical move missing');
          const canonicalId = readTestModeOriginalCanonicalSessionId(
            runtime,
            sessionId
          )?.canonicalId;
          if (!canonicalId || canonicalId === sessionId)
            throw new Error('Original canonical assignment missing');
          createCanonicalRekey({
            sessionId,
            clientId,
            holder,
            lockToken,
            turnKey: () => key,
            onTurnKey: (next) => {
              key = next;
            },
            // This direct locked producer reserves no triggerTurn queue slot. The
            // scheduling link issues no native custody and makes no queued-turn identity claim.
            chain: { link: () => {} },
            deps: {
              getInternalSessionId: (id) =>
                readTestModeOriginalCanonicalSessionId(runtime, id)?.canonicalId,
              rekeyProjector,
              acquireLock: acquireWidgetLock,
              releaseLock: releaseWidgetLock,
              moveNativeLock: (oldId, newId, ownHolder) =>
                moveTestModeOriginalLockedAcquisition(runtime, oldId, newId, ownHolder),
            },
          })();
          if (
            key !== canonicalId ||
            !rooms.canvasDocuments.get('session:' + canonicalId, documentId)
          )
            throw new Error('Original private canonical source movement missing');
          resumeRecord.sessionId = canonicalId;
          resumeRecord.scope = 'session:' + canonicalId;
        } catch (cause) {
          remember(cause);
        }
        await stop();
        if (
          !context.canonicalCapture ||
          !readTestModeOriginalCanonicalRestart(runtime, context.canonicalCapture, db).closed
        )
          throw new Error('Original private canonical owner closure UNKNOWN');
      });
      return context.canonicalSetup;
    },
    prepareCanonicalRecovery() {
      if (
        context.closed ||
        !hostBootstrap ||
        target !== 'room' ||
        !context.roomAgentAuthorId ||
        resume ||
        context.canonicalAnchorStarted
      )
        throw new Error('Original canonical fixture setup unavailable');
      context.canonicalAnchorStarted = true;
      context.canonicalAnchorId = rooms.canvas.open(
        'session:' + sessionId,
        context.roomAgentAuthorId,
        { type: 'markdown', content: 'Original canonical session anchor' },
        {
          tree: {
            resolvedCwd: vault.root,
            treeKind: 'agent-cwd',
            sourceLabel: null,
            aheadOfMain: null,
          },
        }
      ).id;
      return { anchorId: context.canonicalAnchorId };
    },
    pauseCanonicalRoomPump() {
      if (
        context.closed ||
        !context.canonicalAnchorId ||
        context.canonicalPauseStarted ||
        !originalTargetLocked(sessionId) ||
        !context.roomScheduler
      )
        throw new Error('Original held canonical pause unavailable');
      context.canonicalPauseStarted = true;
      context.canonicalCapture = captureTestModeOriginalCanonicalRestart(runtime, sessionId, db);
      context.canonicalSetup = context.roomScheduler.stop().then(() => {
        context.roomSchedulerClosed = true;
      });
      return context.canonicalSetup;
    },
    captureCanonicalRecovery() {
      if (
        context.closed ||
        !context.canonicalAnchorId ||
        !context.canonicalPauseStarted ||
        !context.roomSchedulerClosed ||
        context.canonicalCaptureStarted
      )
        throw new Error('Original canonical capture unavailable');
      context.canonicalCaptureStarted = true;
      if (!context.canonicalCapture) throw new Error('Original canonical producer capture missing');
      const current = readTestModeOriginalCanonicalRestart(runtime, context.canonicalCapture, db);
      if (
        current.closed ||
        current.canonicalId === sessionId ||
        !originalTargetLocked(current.canonicalId) ||
        !readRoomStoreGrantedDocTargetBinding(
          rooms.store,
          db,
          context.roomId!,
          agentId,
          current.canonicalId,
          'claude-code'
        ) ||
        !rooms.canvasDocuments.get('session:' + current.canonicalId, context.canonicalAnchorId)
      )
        throw new Error('Original canonical producer/source movement unconfirmed');
      resumeRecord.sessionId = current.canonicalId;
      return current;
    },
    readCanonicalRecoveryData() {
      if (context.closed || !context.canonicalCapture)
        throw new Error('Original canonical capture unavailable');
      return readTestModeOriginalCanonicalRestart(runtime, context.canonicalCapture, db);
    },
    /** Start original cancellation before joining a save action that awaits the dispatcher. */
  };
}
