import {
  readOriginalRegisteredNativeStream,
  readOriginalRegisteredRuntime,
} from '../../../core/runtime-registry.js';
import { isAbsolvingTerminalReason } from '@dorkos/shared/run-outcome';
import { isInterruptedTerminalReason } from '@dorkos/shared/schemas';
import {
  retireOriginalCommittedRoomResponder,
  requireOriginalCommittedRoomResponder,
} from '../../../canvas/doc-channel/operations/room-current-operation.js';
import type {
  OriginalCommittedRoomResponder,
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
} from '../../../canvas/doc-channel/current/current-operation-types.js';
import { readOriginalRoomDispatchLifecycle } from '../../../session/trigger-turn.js';
import type { OriginalRoomDispatchCustody } from '../../../rooms/service/room-core.js';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  type NativeSessionAcquisition,
} from '../../../session/session-lock.js';
import type { StreamEvent } from '@dorkos/shared/types';
import type { MessageOpts, SseResponse } from '@dorkos/shared/agent-runtime';

/** Original constructor-recorded native turn DATA; cannot register custody. */
export type CodexNativeEntry = {
  roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
  acquisition?: NativeSessionAcquisition;
  instance: object;
  active: Map<string, AbortController>;
  key: string;
  entry: AbortController;
  signal: AbortSignal;
  retired: boolean;
  runtime: 'codex';
  agentPath: string | undefined;
  cwd: string;
};
/** Allocate unrelated native custody; the runtime module alone retains its actual instance. */
export function createIsolatedCodexNativeCustody(
  nativeMapGet: typeof Map.prototype.get,
  nativeSignalAborted: (this: AbortSignal) => boolean
) {
  const originalCodexLockedStreams = new WeakMap<
    object,
    { runtime: object; sessionId: string; options: Readonly<MessageOpts>; current(): boolean }
  >();
  /** Fixed constructor-created stream identity plus the original live acquisition; never a supplied stream matcher. */
  function readCodexOriginalLockedStream(
    runtime: object,
    sessionId: string,
    stream: object
  ): boolean {
    const own = originalCodexLockedStreams.get(stream);
    return !!own && own.runtime === runtime && own.sessionId === sessionId && own.current();
  }
  /** Exact original opened turn DATA; a supplied observer cannot replace these options. */
  function readCodexOriginalLockedTurnOptions(runtime: object, sessionId: string, stream: object) {
    const own = originalCodexLockedStreams.get(stream);
    return own && own.runtime === runtime && own.sessionId === sessionId && own.current()
      ? { options: own.options }
      : undefined;
  }
  const originalCodexRoomStreams = new WeakMap<
    object,
    {
      runtime: object;
      prepared: PreparedRoomResponder;
      operation: object;
      committed: OriginalCommittedRoomResponder;
      emitted: WeakSet<object>;
      close(): Promise<IteratorResult<StreamEvent, void>>;
      reason?: string;
      failed: boolean;
      done: boolean;
    }
  >();
  /** Retire the original Codex Room responder stream and its captured lifecycle. */
  async function retireCodexOriginalRoomResponderStream(stream: object): Promise<void> {
    const own = originalCodexRoomStreams.get(stream);
    if (!own) return;
    originalCodexRoomStreams.delete(stream);
    let failed = false,
      first: unknown;
    try {
      retireOriginalCommittedRoomResponder(own.committed, own.runtime, own.prepared, own.operation);
    } catch (cause) {
      failed = true;
      first = cause;
    }
    try {
      await own.close();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    if (failed) throw first;
  }
  /** Read evidence from the original Codex Room responder stream. */
  function readCodexOriginalRoomResponderStream(
    runtime: object | undefined,
    stream: object,
    event?: StreamEvent
  ) {
    stream = readOriginalRegisteredNativeStream(stream) ?? stream;
    if (runtime) runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;

    const own = originalCodexRoomStreams.get(stream);
    if (!own) return undefined;
    if (
      (runtime !== undefined && own.runtime !== runtime) ||
      readCodexPreparedRoomResponder(own.runtime, own.prepared)?.nativeOperation !==
        own.operation ||
      (event !== undefined && !own.emitted.has(event))
    )
      throw new Error('Original Room stream retired or changed.');
    return Object.freeze({
      runtime: own.runtime,
      prepared: own.prepared,
      operation: own.operation,
      committed: own.committed,
      outcome: own.done
        ? own.reason === 'error' || (own.failed && !isAbsolvingTerminalReason(own.reason))
          ? ('failed' as const)
          : isInterruptedTerminalReason(own.reason)
            ? ('cancelled' as const)
            : ('turn_done' as const)
        : undefined,
    });
  }
  const codexLockedRunners = new WeakMap<
    object,
    (
      sessionId: string,
      content: string,
      opts: MessageOpts | undefined,
      holder: SseResponse,
      lockKey: string
    ) => AsyncGenerator<StreamEvent>
  >();
  /** Original constructor-owned turn entry. A holder selects data; it cannot issue lock/principal authority. */
  function sendCodexOriginalLockedMessage(
    runtime: object,
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    holder: SseResponse,
    lockKey: string
  ): AsyncGenerator<StreamEvent> | undefined {
    return codexLockedRunners.get(runtime)?.(sessionId, content, opts, holder, lockKey);
  }
  const codexRoomPreparers = new WeakMap<
    object,
    (
      source: OriginalFrozenRoomSource,
      holder: SseResponse,
      key: string
    ) => Promise<PreparedRoomResponder | undefined>
  >();
  const codexRoomPrepared = new WeakMap<
    PreparedRoomResponder,
    {
      runtime: object;
      retire: () => Promise<void>;
      source: OriginalFrozenRoomSource;
      nativeOperation: object;
      acquisition: NativeSessionAcquisition;
      start: (committed: OriginalCommittedRoomResponder) => AsyncGenerator<StreamEvent>;
    }
  >();
  /** Genuine constructor preparation only; no generator pull or model invocation. */
  function prepareCodexOriginalLockedRoomResponder(
    runtime: object,
    holder: SseResponse,
    key: string,
    source: OriginalFrozenRoomSource
  ): Promise<PreparedRoomResponder | undefined> {
    const prepare = codexRoomPreparers.get(runtime);
    if (!prepare) return Promise.resolve(undefined);
    return prepare(source, holder, key);
  }
  /** Retire this exact prepared entry before awaited revocation; never selects a successor by key. */
  function retireCodexPreparedRoomResponder(
    runtime: object,
    prepared: PreparedRoomResponder
  ): Promise<void> {
    const own = codexRoomPrepared.get(prepared);
    if (!own || own.runtime !== runtime)
      throw new Error('Room responder preparation is not original.');
    codexRoomPrepared.delete(prepared);
    return own.retire();
  }
  /** Fixed lookup of one genuinely constructor-prepared entry; returned identities never register authority. */
  function readCodexPreparedRoomResponder(runtime: object, prepared: PreparedRoomResponder) {
    const own = codexRoomPrepared.get(prepared);
    if (!own || own.runtime !== runtime) return undefined;
    const at = Date.now(),
      activity = captureNativeSessionActivity(own.acquisition, at);
    const native = readCodexNativeOperation(own.nativeOperation);
    if (
      !activity ||
      !native ||
      native.acquisition !== own.acquisition ||
      !readNativeSessionAcquisition(own.acquisition, activity, at, native.canonicalSessionId) ||
      codexRoomPrepared.get(prepared) !== own ||
      !readCodexNativeOperation(own.nativeOperation)
    )
      return undefined;
    return Object.freeze({
      source: own.source,
      nativeOperation: own.nativeOperation,
      acquisition: own.acquisition,
      native,
    });
  }

  /** The original preparation continues only with genuine native COMMIT/private FIRST custody. */
  function startCodexCommittedRoomResponder(
    runtime: object,
    prepared: PreparedRoomResponder,
    committed?: OriginalCommittedRoomResponder
  ): AsyncGenerator<StreamEvent> {
    const own = codexRoomPrepared.get(prepared);
    if (!own || own.runtime !== runtime)
      throw new Error('Room responder preparation is not original.');
    requireOriginalCommittedRoomResponder(committed, runtime, prepared, own.nativeOperation);
    if (!committed) throw new Error('Room committed start authority is not available.');
    return own.start(committed);
  }
  const codexOriginalActiveSlots = new WeakMap<object, Map<string, AbortController>>();
  const codexNativeConstructors = new WeakSet<object>();
  const codexNativeOperations = new WeakMap<object, CodexNativeEntry>();
  const codexNativeControllers = new WeakMap<AbortController, CodexNativeEntry>();
  /** Fixed native lifetime read: tokens are installed only by a real runtime turn. */
  function readCodexNativeOperation(token: object) {
    const entry = codexNativeOperations.get(token);
    if (
      entry?.roomOrigin &&
      readOriginalRoomDispatchLifecycle(entry.roomOrigin.holder, entry.instance) !==
        entry.roomOrigin.custody
    ) {
      entry.retired = true;
      return undefined;
    }
    const slot = entry ? Object.getOwnPropertyDescriptor(entry.instance, 'activeTurns') : undefined;
    if (
      entry &&
      (!codexNativeConstructors.has(entry.instance) ||
        !slot ||
        !('value' in slot) ||
        slot.value !== entry.active)
    ) {
      entry.retired = true;
      return undefined;
    }
    if (
      !entry ||
      entry.retired ||
      nativeSignalAborted.call(entry.signal) ||
      nativeMapGet.call(entry.active, entry.key) !== entry.entry
    )
      return undefined;
    return {
      roomCustody: entry.roomOrigin?.custody,
      acquisition: entry.acquisition,
      runtime: entry.runtime,
      canonicalSessionId: entry.key,
      agentPath: entry.agentPath,
      canonicalCwd: entry.cwd,
      signal: entry.signal,
    };
  }

  return Object.freeze({
    originalCodexLockedStreams,
    originalCodexRoomStreams,
    codexLockedRunners,
    codexRoomPreparers,
    codexRoomPrepared,
    codexOriginalActiveSlots,
    codexNativeConstructors,
    codexNativeOperations,
    codexNativeControllers,
    readCodexOriginalLockedStream,
    readCodexOriginalLockedTurnOptions,
    retireCodexOriginalRoomResponderStream,
    readCodexOriginalRoomResponderStream,
    sendCodexOriginalLockedMessage,
    prepareCodexOriginalLockedRoomResponder,
    retireCodexPreparedRoomResponder,
    readCodexPreparedRoomResponder,
    startCodexCommittedRoomResponder,
    readCodexNativeOperation,
  });
}
