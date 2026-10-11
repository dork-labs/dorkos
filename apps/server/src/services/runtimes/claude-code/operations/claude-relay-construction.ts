import {
  readOriginalClaudeRelayConstructionView,
  retireClaudePreparedRelayDocument,
  sendClaudeOriginalRelayDocument,
} from '../claude-code-runtime.js';
import type { OriginalClaudeRelayClosedTurn } from '../custody/claude-relay-custody.js';
import { readOriginalSessionProjectionSequence } from '../../../session/session-state-projector.js';
import { DetachedTurnLifecycle } from '../../../session/trigger-turn.js';
import { feedProjector } from '../../../session/projection/session-event-normalizer.js';
import { requireOriginalClosedSessionProjectionFeed } from '../../../session/projection/session-event-normalizer.js';
import { stopOriginalRelaySdkQuery } from '../messaging/relay/relay-sdk-launch.js';
import { readOriginalFrozenRelayDocumentTarget } from '../../../canvas/doc-channel/delivery/relay-authority.js';
import type {
  OriginalFrozenRelayDocumentSource,
  PreparedRelayDocumentResponder,
} from '../../../canvas/doc-channel/delivery/relay-native-types.js';
import { captureOriginalRoomDispatchLifecycle } from '../../../session/trigger-turn.js';
import { readOriginalFrozenRoomTarget } from '../../../canvas/doc-channel/operations/room-current-operation.js';
import { isCurrentClaudeNativeSession } from '../sessions/session-store.js';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  SessionLockManager,
  runtimeLockHolder,
  requireOriginalNativeSessionAcquisitionRetired,
  captureNativeSessionAcquisition,
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  isNativeSessionAcquisitionMove,
  type NativeSessionAcquisition,
} from '../../../session/session-lock.js';

/** Install the original constructor relay callbacks only for its actual private runtime key. */
export function assembleOriginalClaudeRelayConstruction(ownerKey: object): void {
  const facet = readOriginalClaudeRelayConstructionView(ownerKey);
  const originalAcquire = SessionLockManager.prototype.acquireRuntimeLock;
  const originalRelease = SessionLockManager.prototype.releaseLock;
  const originalHolderClose = DetachedTurnLifecycle.prototype.close;
  const originalHolderTouch = DetachedTurnLifecycle.prototype.touch;
  const drives = new WeakMap<OriginalFrozenRelayDocumentSource, Promise<'busy' | 'drained'>>();
  // Failed/UNKNOWN drive resources stay retained by their original constructor until genuine closure.
  const heldDrives = new Map<
    OriginalFrozenRelayDocumentSource,
    {
      holder: DetachedTurnLifecycle;
      acquisition?: NativeSessionAcquisition;
      sessionId: string;
      stopping: boolean;
      naturallyCompleted: boolean;
      prepared?: PreparedRelayDocumentResponder;
      stream?: AsyncGenerator<StreamEvent>;
    }
  >();
  const settlements = new WeakMap<
    OriginalFrozenRelayDocumentSource,
    { settled: boolean; closed: boolean }
  >();
  const stops = new WeakMap<OriginalFrozenRelayDocumentSource, Promise<void>>();
  const closedTurns = new WeakMap<
    OriginalFrozenRelayDocumentSource,
    OriginalClaudeRelayClosedTurn
  >();
  facet.originalRelayClosedTurnReaders.set(facet.runtime, (source) => {
    const settled = settlements.get(source),
      token = closedTurns.get(source);
    if (!settled?.settled || !settled.closed || heldDrives.has(source) || !token)
      throw new Error('Original Relay closed terminal remains UNKNOWN');
    return token;
  });
  facet.claudeRelayDriverStops.set(facet.runtime, (source) => {
    const previous = stops.get(source);
    if (previous) return previous;
    const stop = Promise.resolve().then(async () => {
      const drive = drives.get(source),
        settled = settlements.get(source);
      if (!drive || !settled) throw new Error('Original Relay drive identity unavailable');
      const held = heldDrives.get(source);
      let failed = false,
        first: unknown;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      if (held) {
        if (!held.naturallyCompleted) held.stopping = true;
        const preparing = facet.relayPreparing.get(held.sessionId);
        if (preparing) preparing.retired = true;
        if (held.prepared) {
          const own = facet.claudeRelayPrepared.get(held.prepared);
          if (own) {
            try {
              stopOriginalRelaySdkQuery(own.launch, own.session);
            } catch (cause) {
              remember(cause);
            }
          }
        }
        // Invoking original return synchronously reaches owned SDK stop before held next settles.
        let streamDrain: Promise<unknown> | undefined;
        try {
          if (held.stream) streamDrain = held.stream.return(undefined).catch(remember);
        } catch (cause) {
          remember(cause);
        }
        await Promise.allSettled([drive.catch(() => {}), ...(streamDrain ? [streamDrain] : [])]);
      } else await drive.catch(() => {});
      // Only original positive physical/principal/lock closure can absolve an ordinary operation refusal.
      if (!settled.settled || !settled.closed || heldDrives.has(source))
        remember(new Error('Original Relay drive closure UNKNOWN'));
      if (failed) throw first;
    });
    stops.set(source, stop);
    return stop;
  });
  facet.claudeRelayDrivers.set(facet.runtime, (source) => {
    const previous = drives.get(source);
    if (previous) return previous;
    // Memo before source/native/projector access can reenter the original constructor drive.
    const settlement = { settled: false, closed: false };
    settlements.set(source, settlement);
    const pending = Promise.resolve()
      .then(async (): Promise<'busy' | 'drained'> => {
        const tools = facet.connectorRuntimeTools;
        if (!tools) throw new Error('Original Relay native principal assembly unavailable');
        const target = readOriginalFrozenRelayDocumentTarget(
          source,
          tools.principals,
          'claude-code'
        );
        const holder = new DetachedTurnLifecycle();
        const token = Symbol('original-relay-document-lock');
        const held: {
          holder: DetachedTurnLifecycle;
          acquisition?: NativeSessionAcquisition;
          sessionId: string;
          stopping: boolean;
          naturallyCompleted: boolean;
          prepared?: PreparedRelayDocumentResponder;
          stream?: AsyncGenerator<StreamEvent>;
        } = { holder, sessionId: target.sessionId, stopping: false, naturallyCompleted: false };
        heldDrives.set(source, held);
        let acquired = false,
          prepared: PreparedRelayDocumentResponder | undefined,
          stream: AsyncGenerator<StreamEvent> | undefined;
        let preparedOwn: ReturnType<typeof facet.claudeRelayPrepared.get>;
        let failed = false,
          first: unknown,
          nativeClosed = true;
        const remember = (cause: unknown) => {
          if (!failed) {
            failed = true;
            first = cause;
          }
        };
        // Join this scope to its captured cleanup before returning or reporting failure.
        const drainOriginalCleanup = async () => {
          // Start both real drains before awaiting either; no held next can block physical cancellation.
          const drains: Promise<unknown>[] = [];
          if (stream)
            drains.push(
              Promise.resolve()
                .then(() => stream!.return(undefined))
                .catch((cause) => {
                  nativeClosed = false;
                  remember(cause);
                })
            );
          if (prepared)
            drains.push(
              Promise.resolve()
                .then(() => retireClaudePreparedRelayDocument(facet.runtime, prepared!))
                .catch((cause) => {
                  nativeClosed = false;
                  remember(cause);
                })
            );
          await Promise.allSettled(drains);
          // Private preparation itself may have retained an unresolved original setup owner.
          const unresolved = acquired ? facet.relayPreparing.get(target.sessionId) : undefined;
          if (unresolved) {
            nativeClosed = false;
            remember(
              unresolved.cleanupFailed
                ? unresolved.cleanupCause
                : new Error('Original Relay preparation owner remains unresolved')
            );
          }
          if (nativeClosed) {
            try {
              if (acquired)
                originalRelease.call(
                  facet.originalLocks,
                  target.sessionId,
                  runtimeLockHolder(target.sessionId),
                  token
                );
            } catch (cause) {
              nativeClosed = false;
              remember(cause);
            }
            try {
              originalHolderClose.call(holder);
            } catch (cause) {
              nativeClosed = false;
              remember(cause);
            }
            if (acquired) {
              try {
                if (!held.acquisition)
                  throw new Error('Original Relay lock closure witness unavailable');
                requireOriginalNativeSessionAcquisitionRetired(
                  facet.originalLocks,
                  held.acquisition,
                  holder
                );
              } catch (cause) {
                nativeClosed = false;
                remember(cause);
              }
            }
          }
          if (nativeClosed) {
            heldDrives.delete(source);
            settlement.closed = true;
          }
        };
        try {
          acquired = originalAcquire.call(facet.originalLocks, target.sessionId, holder, token);
          if (acquired) {
            held.acquisition = captureNativeSessionAcquisition(
              facet.originalLocks,
              target.sessionId,
              holder
            );
            if (!held.acquisition)
              throw new Error('Original Relay acquired native holder unavailable');
            prepared = await facet.prepareRelayDocument(source, target, held.acquisition);
            held.prepared = prepared;
            if (held.stopping) throw new Error('Original Relay drive stopped during preparation');
            if (!prepared) throw new Error('Original Relay private capacity unavailable');
            const own = facet.claudeRelayPrepared.get(prepared);
            if (!own || own.runtime !== facet.runtime)
              throw new Error('Original Relay prepared drive unavailable');
            preparedOwn = own;
            stream = sendClaudeOriginalRelayDocument(facet.runtime, prepared);
            held.stream = stream;
            const next = stream.next.bind(stream);
            // Keep the exact original iterator identity; this private drive only adds real holder activity.
            stream.next = (...args) => {
              originalHolderTouch.call(holder);
              return next(...args);
            };
            await feedProjector(own.projector!, stream, { origin: 'runtime' });
            held.naturallyCompleted = true;
          }
        } catch (cause) {
          remember(cause);
        } finally {
          await drainOriginalCleanup();
        }
        if (failed) throw first;
        if (!nativeClosed) throw new Error('Original Relay drive closure UNKNOWN');
        if (acquired) {
          const own = preparedOwn;
          if (
            held.stopping ||
            !held.naturallyCompleted ||
            !own?.completed ||
            !own.runOutcome ||
            !own.lastDone ||
            !own.claim ||
            !own.projectedStart ||
            !own.projectedEnd ||
            !own.projectionFeed ||
            !own.projectionStream ||
            !own.projector
          )
            throw new Error('Original Relay terminal evidence unavailable');
          requireOriginalClosedSessionProjectionFeed(
            own.projectionFeed,
            own.projectionStream,
            own.projector,
            own.projectedStart,
            own.projectedEnd
          );
          const turnStartSeq = readOriginalSessionProjectionSequence(
            own.projector,
            own.projectedStart
          );
          const turnEndSeq = readOriginalSessionProjectionSequence(own.projector, own.projectedEnd);
          if (turnEndSeq <= turnStartSeq)
            throw new Error('Original Relay terminal sequence differs');
          const closed: OriginalClaudeRelayClosedTurn = Object.freeze({
            kind: 'original-claude-relay-closed-turn',
          });
          facet.originalRelayClosedTurns.set(closed, {
            runtime: facet.runtime,
            source,
            claim: own.claim,
            turnStartSeq,
            turnEndSeq,
            outcome: own.runOutcome.outcome,
          });
          closedTurns.set(source, closed);
        }
        return acquired ? 'drained' : 'busy'; // Positive original owner closure only, not model outcome/native acceptance.
      })
      .finally(() => {
        settlement.settled = true;
      });
    drives.set(source, pending);
    return pending;
  });

  facet.claudeRelayPreparers.set(facet.runtime, (source, holder, key) => {
    if (!facet.connectorRuntimeTools) return Promise.resolve(undefined);
    const target = readOriginalFrozenRelayDocumentTarget(
      source,
      facet.connectorRuntimeTools.principals,
      'claude-code'
    );
    const acquisition = captureNativeSessionAcquisition(facet.originalLocks, key, holder);
    if (key !== target.sessionId || !acquisition) return Promise.resolve(undefined);
    return facet.prepareRelayDocument(source, target, acquisition);
  });
  facet.claudeRoomPreparers.set(facet.runtime, (source, holder, key) => {
    const target = readOriginalFrozenRoomTarget(source, 'claude-code');
    const acquisition = captureNativeSessionAcquisition(facet.originalLocks, key, holder);
    if (!target || key !== target.sessionId || !acquisition) return Promise.resolve(undefined);
    return facet.prepareRoomResponder(source, target, acquisition);
  });
  facet.claudeLockMoves.set(facet.runtime, (oldKey, canonicalKey, holder) => {
    const entry = facet.claudeRuntimeEntries.get(facet.runtime)?.get(oldKey);
    const canonical = entry && Object.getOwnPropertyDescriptor(entry.session, 'sdkSessionId');
    if (
      !entry ||
      entry.retired ||
      !entry.acquisition ||
      !canonical ||
      !('value' in canonical) ||
      canonical.value !== canonicalKey
    )
      return false;
    const time = Date.now();
    const activity = captureNativeSessionActivity(entry.acquisition, time);
    if (
      !activity ||
      !readNativeSessionAcquisition(entry.acquisition, activity, time, oldKey) ||
      entry.retired ||
      !isCurrentClaudeNativeSession(entry.store, entry.session)
    )
      return false;
    const next = captureNativeSessionAcquisition(facet.originalLocks, canonicalKey, holder);
    if (!next || !isNativeSessionAcquisitionMove(entry.acquisition, next, holder)) return false;
    entry.acquisition = next;
    return true;
  });
  facet.claudeLockedRunners.set(facet.runtime, (sessionId, content, opts, holder, lockKey) => {
    const acquisition = captureNativeSessionAcquisition(facet.originalLocks, lockKey, holder);
    if (!acquisition)
      throw new Error('Native turn requires its exact original session lock acquisition.');
    const custody = captureOriginalRoomDispatchLifecycle(holder, facet.runtime);
    const roomOrigin = custody ? Object.freeze({ holder, custody }) : undefined;
    return facet.createMessage(sessionId, content, opts, acquisition, roomOrigin);
  });
}
