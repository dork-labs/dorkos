import { executeDocumentWork } from '../storage/store-transaction.js';
import { sendOriginalDownstreamRoomInsideFrame } from '../downstream/native-room-emitter.js';
import { readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { projectOriginalRoomDestinationData } from '../current/current-operation-data.js';
import { projectOriginalRoomClaimData } from '../current/current-operation-data.js';
import {
  peekProjector,
  requireOriginalSessionProjection,
} from '../../../session/session-state-projector.js';
import { createRoomStoreDocBudgetCompanion } from '../../../rooms/service/room-core.js';
import { readRoomDocBudgetFirst } from '../../../rooms/limits/turn-budget.js';
import {
  captureOriginalPreparedNativeTime,
  resolveOriginalNativePrincipal,
  captureOriginalRoomEmissionPrincipal,
} from '../../../connectors/principal/runtime-principal-service.js';
import { randomUUID } from 'node:crypto';
import { type DbTransaction } from '@dorkos/db';
import type {
  OriginalCommittedRoomResponder,
  OriginalRoomEmissionStage,
  PreparedRoomResponder,
} from '../current/current-operation-types.js';
import { readOriginalRoomResponderCommitView } from './room-responder-operation.js';

/** Genuine native frame and private SAMEbudget FIRST precede any model start. */
export function commitOriginalRoomResponder(
  engineOwner: object,
  runtime: object,
  prepared: PreparedRoomResponder
): OriginalCommittedRoomResponder {
  const facet = readOriginalRoomResponderCommitView(engineOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = facet.readPrepared(runtime, prepared),
    source = own.own.source;
  const effectiveTargetSessionId = own.own.effectiveTargetSessionId;
  if (!effectiveTargetSessionId)
    throw new Error('Original Room preparation has no captured destination.');
  if (facet.claiming.has(prepared)) throw new Error('Original Room claim has already begun.');
  facet.claiming.add(prepared);
  const companion = createRoomStoreDocBudgetCompanion(
    facet.roomStore,
    facet.db,
    source.roomId,
    source.targetAgentId,
    effectiveTargetSessionId,
    source.targetRuntime
  );
  const owner = companion.begin(source.originalSourceHash, source.roomId);
  const policy = companion.readDestinationPolicy(owner);
  companion.readGlobal(owner);
  companion.readRoom(owner);
  // Destination membership, never the historical producer cursor.
  const membership = facet.facade.readCurrentRoomMembership(source.roomId, source.targetAgentPath);
  const destination = projectOriginalRoomDestinationData(
    membership,
    facet.facade.readCurrentRoomMembership(source.roomId, 'system'),
    source.targetAuthorId
  );
  const entryId = randomUUID(),
    dispatchId = randomUUID();
  const at = facet.now(),
    nowIso = facet.iso.call(new facet.Date(at));
  const data = projectOriginalRoomClaimData(source, own.own.producerRoomFacts, {
    nowIso,
    at,
    effectiveTargetSessionId,
    systemAuthorId: destination.systemAuthorId,
    entryId,
    dispatchId,
    maxAgentDepth: policy.maxAgentDepth,
    expectedReadSeq: destination.expectedReadSeq,
  });
  facet.requireCurrentResponder(runtime, prepared, data.expectedReadSeq);
  const barrier = companion.prepare(owner, data);
  if (barrier.state !== 'confirmed')
    throw new Error('Original Room claim barrier was not confirmed.');
  // A new fixed capture after every observable pre-frame cut; native repeats full SQL/CAS inside BEGIN.
  facet.requireCurrentResponder(runtime, prepared, data.expectedReadSeq);
  // Capture the owning budget clock after the native barrier, so its commit window includes it.
  companion.readClock(owner);
  const result = companion.commit(owner, data);
  if (result.state !== 'confirmed') throw new Error('Original Room commit was not confirmed.');
  const commit = result.value;
  const committedMember = facet.facade
    .readCurrentRoomMembership(source.roomId, source.targetAgentPath)
    .members.find((row) => row.author_id === source.targetAuthorId);
  const committedCursor = committedMember?.last_read_seq;
  if (!Number.isSafeInteger(committedCursor) || Number(committedCursor) < 0) {
    try {
      facet.facade.markClaimUnknown(commit);
    } catch {}
    throw new Error('Original committed destination cursor is unavailable.');
  }
  if (!readRoomDocBudgetFirst(companion, commit)) {
    facet.facade.markClaimUnknown(commit);
    throw new Error('Original Room commit lacks SAMEbudget FIRST.');
  }
  try {
    facet.requireCurrentResponder(runtime, prepared, Number(committedCursor));
  } catch (cause) {
    try {
      facet.facade.markClaimUnknown(commit);
    } catch {}
    throw cause;
  }
  const token: OriginalCommittedRoomResponder = Object.freeze({
    kind: 'original-committed-room-responder',
  });
  facet.committedRoomResponders.set(token, {
    runtime,
    prepared,
    operation: own.nativeOperation,
    requireCurrent: () => {
      facet.requireCurrentResponder(runtime, prepared, Number(committedCursor));
      if (!readRoomDocBudgetFirst(companion, commit))
        throw new Error('Original Room FIRST recognition changed.');
    },
    project: (projector, event) => {
      requireOriginalSessionProjection(projector, event);
      if (peekProjector(effectiveTargetSessionId) !== projector || event.type !== 'turn_start')
        throw new Error('Original destination projection changed.');
      facet.requireCurrentResponder(runtime, prepared, Number(committedCursor));
      const result = facet.facade.observeProjectedStart(
        commit,
        `${effectiveTargetSessionId}:${event.seq}`
      );
      if (result.state !== 'confirmed')
        throw new Error('Original projected start was not confirmed.');
    },
    terminal: (projector, event, outcome) => {
      requireOriginalSessionProjection(projector, event);
      try {
        if (
          peekProjector(effectiveTargetSessionId) !== projector ||
          event.type !== 'turn_end' ||
          outcome === undefined
        )
          throw new Error('Original terminal evidence is unavailable.');
        facet.requireCurrentResponder(runtime, prepared, Number(committedCursor));
        const result = facet.facade.settleKnownTerminal(commit, outcome);
        if (result.state !== 'confirmed')
          throw new Error('Original terminal settlement was not confirmed.');
      } catch (cause) {
        try {
          facet.facade.markClaimUnknown(commit);
        } catch {}
        throw cause;
      } finally {
        facet.closePrepared(prepared);
      }
    },
    retire: () => {
      facet.closePrepared(prepared);
      facet.facade.markClaimUnknown(commit);
    },
    consume: () => {
      try {
        facet.requireCurrentResponder(runtime, prepared, Number(committedCursor));
        if (!readRoomDocBudgetFirst(companion, commit))
          throw new Error('Original Room FIRST recognition changed.');
        return Object.freeze({ content: 'Document update', commit });
      } catch (cause) {
        try {
          facet.facade.markClaimUnknown(commit);
        } catch {}
        throw cause;
      }
    },
  });
  const committedOwner = facet.committedRoomResponders.get(token)!;
  facet.activeEmissionOwners.set(token, {
    db: facet.db,
    prepare: async () => {
      if (
        facet.db.$client.inTransaction ||
        facet.committedRoomResponders.get(token) !== committedOwner ||
        committedOwner.consumed !== true
      )
        throw new Error('Original Room emission cannot prepare.');
      committedOwner.requireCurrent();
      const resolved = await resolveOriginalNativePrincipal(facet.principals, own.nativeOperation);
      if (resolved.status !== 'resolved')
        throw new Error('Original Room emission principal retired.');
      committedOwner.requireCurrent();
      let time = captureOriginalPreparedNativeTime(facet.principals, facet.db, own.nativeOperation);
      const stage: OriginalRoomEmissionStage = Object.freeze({
        kind: 'original-room-emission-stage',
      });
      const requireFixed = () => {
        // Clock capture exists during preparation too; only the actual private frame selects native SQL.
        const original = facet.emissionStages.get(stage),
          frame = facet.originalEmissionFrames.get(stage);
        if (original?.frameState === 'unknown') throw original.closeFailure?.cause;
        if (
          (original?.frameState === 'open' && !frame) ||
          (frame && original?.frameState !== 'open')
        )
          throw new Error('Original emission frame lifecycle changed.');
        facet.requireCurrentResponder(
          runtime,
          prepared,
          Number(committedCursor),
          time,
          frame ? stage : undefined
        );
        if (!readRoomDocBudgetFirst(companion, commit))
          throw new Error('Original Room emission FIRST retired.');
      };
      requireFixed();
      facet.emissionStages.set(stage, {
        db: facet.db,
        token,
        committed: committedOwner,
        principal: resolved.principal,
        source: source,
        effectiveTargetSessionId,
        principals: facet.principals,
        phase: 'prepared',
        frameState: 'not_started',
        run: (actualStage, emitter, request) => {
          const activeStage = facet.requireEmissionStage(actualStage, facet.db);
          activeStage.frameState = 'open';
          try {
            const outcome = facet.facade.runOriginalCommittedRoomEmission(
              commit,
              (queryDb, sourceDb) => {
                if (sourceDb !== facet.db)
                  throw new Error('Original Room emission database changed.');
                return executeDocumentWork(queryDb as DbTransaction, (tx) => {
                  facet.originalEmissionFrames.set(actualStage, { db: facet.db, tx, emitter });
                  try {
                    return sendOriginalDownstreamRoomInsideFrame(emitter, actualStage, tx, request);
                  } finally {
                    facet.originalEmissionFrames.delete(actualStage);
                  }
                });
              }
            );
            activeStage.frameState = outcome.state === 'unknown' ? 'unknown' : 'closed';
            if (outcome.state !== 'confirmed') {
              if (outcome.state === 'unknown')
                activeStage.closeFailure = Object.freeze({ cause: outcome.cause });
              throw outcome.cause;
            }
            return outcome.value;
          } catch (cause) {
            if (activeStage.frameState === 'open') {
              activeStage.frameState = 'unknown';
              activeStage.closeFailure = Object.freeze({ cause });
            }
            throw cause;
          } finally {
            facet.originalEmissionFrames.delete(actualStage);
          }
        },
        refresh: () => {
          committedOwner.requireCurrent();
          time = captureOriginalPreparedNativeTime(facet.principals, facet.db, own.nativeOperation);
          requireFixed();
          time = captureOriginalRoomEmissionPrincipal(
            facet.principals,
            facet.db,
            own.nativeOperation,
            stage
          );
        },
        require: requireFixed,
        readNativeBinding: (bindingId) => facet.facade.readOriginalRuntimeBinding(bindingId),
        readNativeTarget: () => facet.facade.readOriginalEmissionTargetBinding(source),
      });
      return stage;
    },
  });
  return token;
}
