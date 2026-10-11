import { readOriginalOpenCodeModuleCustody } from './opencode-runtime.js';
import {
  readOriginalRegisteredNativeStream,
  readOriginalRegisteredRuntime,
} from '../../core/runtime-registry.js';
import { isAbsolvingTerminalReason } from '@dorkos/shared/run-outcome';
import { isInterruptedTerminalReason } from '@dorkos/shared/schemas';
import { readOriginalRoomDispatchLifecycle } from '../../session/trigger-turn.js';
import {
  requireOriginalCommittedRoomResponder,
  retireOriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/operations/room-current-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/current/current-operation-types.js';
import type { StreamEvent } from '@dorkos/shared/types';
import type { MessageOpts, SseResponse } from '@dorkos/shared/agent-runtime';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
} from '../../session/session-lock.js';

/** Fixed constructor-created stream identity plus the original live acquisition; never a supplied stream matcher. */
export function readOpenCodeOriginalLockedStream(
  moduleOwner: object,
  runtime: object,
  sessionId: string,
  stream: object
): boolean {
  const custody = readOriginalOpenCodeModuleCustody(moduleOwner);
  const own = custody.originalOpenCodeLockedStreams.get(stream);
  return !!own && own.runtime === runtime && own.sessionId === sessionId && own.current();
}

/** Exact original opened turn DATA; a supplied observer cannot replace these options. */
export function readOpenCodeOriginalLockedTurnOptions(
  moduleOwner: object,
  runtime: object,
  sessionId: string,
  stream: object
) {
  const custody = readOriginalOpenCodeModuleCustody(moduleOwner);
  const own = custody.originalOpenCodeLockedStreams.get(stream);
  return own && own.runtime === runtime && own.sessionId === sessionId && own.current()
    ? { options: own.options }
    : undefined;
}

/** Retire the original OpenCode Room responder stream and its captured lifecycle. */
export async function retireOpenCodeOriginalRoomResponderStream(
  moduleOwner: object,
  stream: object
): Promise<void> {
  const custody = readOriginalOpenCodeModuleCustody(moduleOwner);
  const own = custody.originalOpenCodeRoomStreams.get(stream);
  if (!own) return;
  custody.originalOpenCodeRoomStreams.delete(stream);
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

/** Read evidence from the original OpenCode Room responder stream. */
export function readOpenCodeOriginalRoomResponderStream(
  moduleOwner: object,
  runtime: object | undefined,
  stream: object,
  event?: StreamEvent
) {
  const custody = readOriginalOpenCodeModuleCustody(moduleOwner);
  stream = readOriginalRegisteredNativeStream(stream) ?? stream;
  if (runtime) runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;

  const own = custody.originalOpenCodeRoomStreams.get(stream);
  if (!own) return undefined;
  if (
    (runtime !== undefined && own.runtime !== runtime) ||
    readOpenCodePreparedRoomResponder(moduleOwner, own.runtime, own.prepared)?.nativeOperation !==
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

/** Original constructor-owned turn entry. A holder selects data; it cannot issue lock/principal authority. */
export function sendOpenCodeOriginalLockedMessage(
  moduleOwner: object,
  runtime: object,
  sessionId: string,
  content: string,
  opts: MessageOpts | undefined,
  holder: SseResponse,
  lockKey: string
): AsyncGenerator<StreamEvent> | undefined {
  const custody = readOriginalOpenCodeModuleCustody(moduleOwner);
  return custody.openCodeLockedRunners.get(runtime)?.(sessionId, content, opts, holder, lockKey);
}

/** Fixed genuine setup may create a local sidecar session, but never sends a model prompt. */
export function prepareOpenCodeOriginalLockedRoomResponder(
  moduleOwner: object,
  runtime: object,
  holder: SseResponse,
  key: string,
  source: OriginalFrozenRoomSource
): Promise<PreparedRoomResponder | undefined> {
  const custody = readOriginalOpenCodeModuleCustody(moduleOwner);
  const prepare = custody.openCodeRoomPreparers.get(runtime);
  if (!prepare) return Promise.resolve(undefined);
  return prepare(source, holder, key);
}

/** Exact original preparation retirement, before provider/revocation callbacks. */
export function retireOpenCodePreparedRoomResponder(
  moduleOwner: object,
  runtime: object,
  prepared: PreparedRoomResponder
): Promise<void> {
  const custody = readOriginalOpenCodeModuleCustody(moduleOwner);
  const own = custody.openCodeRoomPrepared.get(prepared);
  if (!own || own.runtime !== runtime)
    throw new Error('Room responder preparation is not original.');
  custody.openCodeRoomPrepared.delete(prepared);
  return own.retire();
}

/** Fixed lookup of one genuinely constructor-prepared entry; returned identities never register authority. */
export function readOpenCodePreparedRoomResponder(
  moduleOwner: object,
  runtime: object,
  prepared: PreparedRoomResponder
) {
  const custody = readOriginalOpenCodeModuleCustody(moduleOwner);
  const own = custody.openCodeRoomPrepared.get(prepared);
  if (!own || own.runtime !== runtime) return undefined;
  const at = Date.now(),
    activity = captureNativeSessionActivity(own.acquisition, at);
  const native = readOpenCodeNativeOperation(moduleOwner, own.nativeOperation);
  if (
    !activity ||
    !native ||
    native.acquisition !== own.acquisition ||
    !readNativeSessionAcquisition(own.acquisition, activity, at, native.canonicalSessionId) ||
    custody.openCodeRoomPrepared.get(prepared) !== own ||
    !readOpenCodeNativeOperation(moduleOwner, own.nativeOperation)
  )
    return undefined;
  return Object.freeze({
    source: own.source,
    nativeOperation: own.nativeOperation,
    acquisition: own.acquisition,
    native,
  });
}

/** Continue the same original setup only after its native COMMIT and private FIRST. */
export function startOpenCodeCommittedRoomResponder(
  moduleOwner: object,
  runtime: object,
  prepared: PreparedRoomResponder,
  committed?: OriginalCommittedRoomResponder
): AsyncGenerator<StreamEvent> {
  const custody = readOriginalOpenCodeModuleCustody(moduleOwner);
  const own = custody.openCodeRoomPrepared.get(prepared);
  if (!own || own.runtime !== runtime)
    throw new Error('Room responder preparation is not original.');
  requireOriginalCommittedRoomResponder(committed, runtime, prepared, own.nativeOperation);
  return own.start(committed!);
}

/** Fixed native lifetime read; retired entries cannot regain authority through map reinsertion. */
export function readOpenCodeNativeOperation(moduleOwner: object, token: object) {
  const custody = readOriginalOpenCodeModuleCustody(moduleOwner);
  const entry = custody.openCodeNativeOperations.get(token);
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
    (!custody.openCodeNativeConstructors.has(entry.instance) ||
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
    custody.nativeSignalAborted.call(entry.signal) ||
    custody.nativeMapGet.call(entry.active, entry.key) !== entry.entry
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
