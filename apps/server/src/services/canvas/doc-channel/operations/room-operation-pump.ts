import {
  readOriginalRuntimeRegistrySelection,
  readOriginalRegisteredRuntime,
  acquireOriginalRegisteredRuntime,
  releaseOriginalRegisteredRuntime,
  observeOriginalRegisteredRuntimeStream,
  type RuntimeRegistry,
} from '../../../core/runtime-registry.js';
import { DetachedTurnLifecycle } from '../../../session/trigger-turn.js';
import { feedProjector } from '../../../session/projection/session-event-normalizer.js';
import { getOrCreateProjector } from '../../../session/session-state-projector.js';
import { startClaudeCommittedRoomResponder } from '../../../runtimes/claude-code/claude-code-runtime.js';
import { startCodexCommittedRoomResponder } from '../../../runtimes/codex/codex-runtime.js';
import { startOpenCodeCommittedRoomResponder } from '../../../runtimes/opencode/opencode-runtime.js';
import {
  isOriginalNativeTestModeRuntime,
  startTestModeCommittedRoomResponder,
  readTestModeOriginalScenarioEvidence,
  requireTestModeOriginalRoomEmissionClosed,
} from '../../../runtimes/test-mode/test-mode-runtime.js';
import type { PreparedRoomResponder } from '../current/current-operation-types.js';
import { readOriginalRoomOperationView } from './room-current-operation.js';

/** Owned due pump: fixed source selection, real lock acquisition, native claim/FIRST then same-entry stream. */
export function pump(operationOwner: object, registry: RuntimeRegistry): Promise<void> {
  const facet = readOriginalRoomOperationView(operationOwner);
  if (facet.pumpClosed) return Promise.resolve();
  // Own the continuation before its first native call or observable setup.
  const work = Promise.resolve().then(() => facet.runPump(registry));
  facet.pumpWork.add(work);
  void work.then(
    () => facet.pumpWork.delete(work),
    () => facet.pumpWork.delete(work)
  );
  return work;
}

/** Original private room-operation responsibility; exact constructor identity is required first. */
export function stopPump(operationOwner: object): Promise<void> {
  const facet = readOriginalRoomOperationView(operationOwner);
  if (facet.pumpStop) return facet.pumpStop;
  facet.pumpClosed = true;
  facet.relayListeners.clear();
  let resolve!: () => void, reject!: (cause: unknown) => void;
  facet.pumpStop = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let failed = false,
    first: unknown;
  const pending: Promise<unknown>[] = [];
  for (const holder of facet.pumpHolders) {
    try {
      holder.close();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  for (const stream of facet.pumpStreams) {
    try {
      pending.push(stream.return(undefined));
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  const admitted = [...facet.pumpWork];
  void (async () => {
    for (const result of await Promise.allSettled([...pending, ...admitted]))
      if (result.status === 'rejected' && !failed) {
        failed = true;
        first = result.reason;
      }
    if (failed) throw first;
  })().then(resolve, reject);
  return facet.pumpStop;
}

/** Original private room-operation responsibility; exact constructor identity is required first. */
export async function runPump(operationOwner: object, registry: RuntimeRegistry): Promise<void> {
  const facet = readOriginalRoomOperationView(operationOwner);
  const sources = [...facet.frozen.entries()].sort((a, b) => {
    const left = facet.frozenRoomSources.get(a[1])!,
      right = facet.frozenRoomSources.get(b[1])!;
    return left.dueAt.localeCompare(right.dueAt) || a[0].localeCompare(b[0]);
  });
  for (const [id, source] of sources) {
    if (facet.pumpClosed) break;
    if (
      facet.frozen.get(id) !== source ||
      facet.preparing.has(id) ||
      facet.preparationUnknown.has(id)
    )
      continue;
    const original = facet.frozenRoomSources.get(source);
    if (
      !original ||
      original.engine !== facet.engine ||
      original.db !== facet.db ||
      original.facade !== facet.facade
    )
      throw new Error('Due pump lacks original frozen custody.');
    const target = original.source;
    const effectiveTargetSessionId = facet.readCurrentFrozenRoomDestination(original);
    const selected = readOriginalRuntimeRegistrySelection(registry, facet.db, target.targetRuntime);
    if (!selected) continue; // No model or source loss for known pre-effect unavailable selection.
    const holder = new DetachedTurnLifecycle();
    facet.pumpHolders.add(holder);
    const clientId = `original-doc-room:${target.admissionId}`,
      lockToken = Symbol(clientId);
    let acquired = false;
    let prepared: PreparedRoomResponder | undefined;
    let stream: AsyncGenerator<import('@dorkos/shared/types').StreamEvent> | undefined;
    let failed = false,
      first: unknown;
    let cleanupFailed = false;
    const cleanup = async (work: () => unknown | Promise<unknown>) => {
      try {
        await work();
      } catch (cause) {
        cleanupFailed = true;
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    };
    try {
      acquired = acquireOriginalRegisteredRuntime(
        selected,
        effectiveTargetSessionId,
        clientId,
        holder,
        lockToken
      );
      if (acquired) {
        if (facet.pumpClosed) throw new Error('Original due pump closed during acquisition.');
        prepared = await facet.prepareFrozenResponder(selected, holder, effectiveTargetSessionId, [
          id,
          source,
        ]);
        if (prepared) {
          if (facet.pumpClosed) throw new Error('Original due pump closed before claim.');
          if (!readOriginalRegisteredRuntime(selected))
            throw new Error('Original due runtime selection retired.');
          if (facet.frozenRoomSources.get(source) !== original)
            throw new Error('Original due source changed during preparation.');
          facet.responder.requirePreparedSource(selected, prepared, source);
          const committed = facet.commitResponder(selected, prepared);
          const raw = readOriginalRegisteredRuntime(selected);
          if (!raw) throw new Error('Original due runtime selection retired after claim.');
          facet.responder.requirePreparedSource(selected, prepared, source);
          stream = isOriginalNativeTestModeRuntime(raw)
            ? startTestModeCommittedRoomResponder(raw, prepared, committed)
            : target.targetRuntime === 'claude-code'
              ? startClaudeCommittedRoomResponder(raw, prepared, committed)
              : target.targetRuntime === 'codex'
                ? startCodexCommittedRoomResponder(raw, prepared, committed)
                : startOpenCodeCommittedRoomResponder(raw, prepared, committed);
          facet.pumpStreams.add(stream);
          if (isOriginalNativeTestModeRuntime(raw))
            facet.pumpScenarioEvidence.set(target.documentId, {
              documentId: target.documentId,
              batchId: target.batchId,
              generation: target.generation,
              sessionId: effectiveTargetSessionId,
              runtime: new WeakRef(raw),
              stream: new WeakRef(stream),
            });
          const observed = observeOriginalRegisteredRuntimeStream(
            selected,
            effectiveTargetSessionId,
            stream
          );
          await feedProjector(
            getOrCreateProjector(effectiveTargetSessionId, target.targetAgentPath),
            observed,
            { originalRoomStream: stream }
          );
        }
      }
    } catch (cause) {
      failed = true;
      first = cause;
      const diagnostic = facet.pumpScenarioEvidence.get(target.documentId);
      if (
        diagnostic &&
        diagnostic.batchId === target.batchId &&
        diagnostic.generation === target.generation &&
        !diagnostic.operationFailure
      )
        diagnostic.operationFailure = { cause };
    } finally {
      await cleanup(() => stream?.return(undefined));
      // Original prepared cleanup is idempotent only for facet.originalOwner actual native tuple.
      if (prepared) await cleanup(() => facet.responder.retirePrepared(selected, prepared!));
      if (acquired)
        await cleanup(() =>
          releaseOriginalRegisteredRuntime(selected, effectiveTargetSessionId, clientId, lockToken)
        );
      await cleanup(() => holder.close());
      if (stream) facet.pumpStreams.delete(stream);
      const diagnostic = facet.pumpScenarioEvidence.get(target.documentId);
      const originalRuntime = diagnostic?.runtime?.deref();
      if (
        diagnostic &&
        diagnostic.batchId === target.batchId &&
        diagnostic.generation === target.generation &&
        stream &&
        originalRuntime
      ) {
        const actual = readTestModeOriginalScenarioEvidence(originalRuntime, stream);
        if (actual) {
          diagnostic.scenarioStarts = actual.scenarioStarts;
          diagnostic.retired = actual.retired;
        }
        diagnostic.runtime = undefined;
        diagnostic.stream = undefined;
      }
      facet.pumpHolders.delete(holder);
    }
    if (failed && !cleanupFailed && stream && prepared && acquired) {
      const raw = readOriginalRegisteredRuntime(selected);
      if (raw && isOriginalNativeTestModeRuntime(raw)) {
        // A refused original emission is operational DATA only after actual
        // stream/prepared/acquisition/holder drains and native child closure.
        // UNKNOWN, missing evidence and all non-TestMode failures still throw.
        const diagnostic = facet.pumpScenarioEvidence.get(target.documentId);
        try {
          requireTestModeOriginalRoomEmissionClosed(raw, stream, facet.db);
          if (
            !diagnostic ||
            diagnostic.batchId !== target.batchId ||
            diagnostic.generation !== target.generation ||
            diagnostic.scenarioStarts !== 1 ||
            diagnostic.retired !== true
          )
            throw new Error('Original closed Room refusal evidence missing');
          diagnostic.operationFailure = { cause: first };
          diagnostic.cleanupClosed = true;
          failed = false;
        } catch {
          /* Original operational cause remains first; closure is not established. */
        }
      }
    }
    if (!failed && !cleanupFailed && stream && prepared && acquired) {
      const raw = readOriginalRegisteredRuntime(selected);
      if (raw && isOriginalNativeTestModeRuntime(raw)) {
        // Successful turns need the same positive native closure witness as refusals.
        // All owned stream/prepared/acquisition/holder cleanup has settled above.
        requireTestModeOriginalRoomEmissionClosed(raw, stream, facet.db);
        const diagnostic = facet.pumpScenarioEvidence.get(target.documentId);
        if (
          !diagnostic ||
          diagnostic.batchId !== target.batchId ||
          diagnostic.generation !== target.generation ||
          diagnostic.scenarioStarts !== 1 ||
          diagnostic.retired !== true
        )
          throw new Error('Original successful Room closure evidence missing');
        diagnostic.cleanupClosed = true;
      }
    }
    if (failed) throw first;
  }
}

/** Exact original source diagnostics only; absent/collected/non-TestMode evidence is UNKNOWN, never zero. */
export function readScenarioEvidence(
  operationOwner: object,
  documentId: string,
  batchId: string,
  generation: string
):
  | Readonly<{
      documentId: string;
      batchId: string;
      generation: string;
      sessionId: string;
      scenarioStarts: number;
      retired: boolean | undefined;
      operationFailed: boolean;
      cleanupClosed: boolean;
    }>
  | undefined {
  const facet = readOriginalRoomOperationView(operationOwner);
  const own = facet.pumpScenarioEvidence.get(documentId);
  if (!own || own.batchId !== batchId || own.generation !== generation) return undefined;
  const runtime = own.runtime?.deref(),
    stream = own.stream?.deref();
  const current =
    runtime && stream ? readTestModeOriginalScenarioEvidence(runtime, stream) : undefined;
  const count = current?.scenarioStarts ?? own.scenarioStarts;
  if (count === undefined) return undefined;
  return Object.freeze({
    documentId,
    batchId,
    generation,
    sessionId: own.sessionId,
    scenarioStarts: count,
    retired: current?.retired ?? own.retired,
    operationFailed: own.operationFailure !== undefined,
    cleanupClosed: own.cleanupClosed === true,
  });
}
