import { readOriginalTestModeNativeMethodView } from '../test-mode-runtime.js';
import { captureTurnLevelOptions } from '../../../core/turn-power/turn-levels.js';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type {
  ConnectorRuntimePrincipalPort,
  OpenConnectorTurnResult,
} from '../../../connectors/runtime-principal-port.js';
import {
  openOriginalNativeTurn,
  resolveOriginalNativePrincipal,
  retireOriginalNativeTurn,
} from '../../../connectors/principal/runtime-principal-service.js';
import {
  captureNativeSessionAcquisition,
  type SessionLockManager,
  type NativeSessionAcquisition,
} from '../../../session/session-lock.js';
import { readOriginalPreparedRoomContext } from '../../../session/trigger-turn.js';
import {
  readOriginalFrozenRoomTarget,
  requireOriginalRoomPrincipalService,
} from '../../../canvas/doc-channel/operations/room-current-operation.js';
import {
  requireCurrentOriginalCommittedRoomResponder,
  retireOriginalCommittedRoomResponder,
} from '../../../canvas/doc-channel/operations/room-responder-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../../canvas/doc-channel/current/current-operation-types.js';
import type { MessageOpts, SseResponse } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { TestModeRuntime } from '../test-mode-runtime.js';
import type { TestModeNativeGuardedCustody } from '../test-mode-runtime.js';
import type { TestModeNativeEntry, TestModeInstalled } from './test-mode-native-types.js';

/** Original fixed live native method view, reachable only by constructor-private identity. */
export interface TestModeNativeMethodView {
  readonly runtime: TestModeRuntime;
  readonly custody: TestModeNativeGuardedCustody;
  readonly nativeEntries: Map<string, TestModeNativeEntry>;
  readonly nativePrincipals: ConnectorRuntimePrincipalPort | undefined;
  readonly nativeLocks: SessionLockManager;
  readonly preparedRoomContexts: Map<string, RoomContextData>;
  readonly activeNativeStreams: Map<string, AsyncGenerator<StreamEvent>>;
  installNative(
    sessionId: string,
    path: string,
    acquisition: NativeSessionAcquisition,
    holder: SseResponse,
    roomOrigin?: TestModeNativeEntry['roomOrigin']
  ): TestModeInstalled;
  nativeStream(
    sessionId: string,
    text: string,
    opts: MessageOpts | undefined,
    own: TestModeInstalled,
    room?: { prepared: PreparedRoomResponder; committed: OriginalCommittedRoomResponder }
  ): AsyncGenerator<StreamEvent>;
  sendScenario(
    sessionId: string,
    text: string,
    opts?: MessageOpts,
    native?: {
      own: TestModeInstalled;
      room?: { prepared: PreparedRoomResponder; committed: OriginalCommittedRoomResponder };
    }
  ): AsyncGenerator<StreamEvent>;
}

/** Allocate isolated method custody; the actual registrar remains root lexical. */
export function createIsolatedTestModeNativeMethods() {
  const views = new WeakMap<object, TestModeNativeMethodView>();
  const get = WeakMap.prototype.get;
  const set = WeakMap.prototype.set;
  const apply = Reflect.apply;
  function read(owner: object): TestModeNativeMethodView {
    const view = apply(get, views, [owner]);
    if (!view) throw new Error('Original TestMode NativeMethods owner required.');
    return view;
  }
  return {
    register(owner: object, view: TestModeNativeMethodView): void {
      apply(set, views, [owner, view]);
    },
    read,
  };
}

/** Install the original held acquisition and native entry after constructor-owned validation. Requires the original private owner before effects. */
export function installNative(
  owner: object,
  sessionId: string,
  path: string,
  acquisition: NativeSessionAcquisition,
  holder: SseResponse,
  roomOrigin?: TestModeNativeEntry['roomOrigin']
): TestModeInstalled {
  const view = readOriginalTestModeNativeMethodView(owner);
  if (
    !view.custody.testModeNativeConstructors.has(view.runtime) ||
    view.nativeEntries.has(sessionId)
  )
    throw new Error('TestMode native slot is unavailable.');
  const entry: TestModeNativeEntry = {
    runtime: view.runtime,
    sessionId,
    canonicalSessionId: sessionId,
    path,
    acquisition,
    controller: new AbortController(),
    retired: false,
    closed: false,
    holder,
    scenarioStarts: 0,
    roomOrigin,
  };
  const operation = Object.freeze({});
  view.nativeEntries.set(sessionId, entry);
  view.custody.testModeNativeOperations.set(operation, entry);
  let binding: OpenConnectorTurnResult | undefined;
  let retirement: Promise<void> | undefined;
  const retire = (): Promise<void> => {
    if (retirement) return retirement;
    entry.retired = true;
    if (view.nativeEntries.get(sessionId) === entry) view.nativeEntries.delete(sessionId);
    retirement = Promise.resolve().then(async () => {
      let failed = false,
        first: unknown;
      try {
        entry.controller.abort();
      } catch (cause) {
        failed = true;
        first = cause;
      }
      try {
        entry.closeScenario?.();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      try {
        if (binding)
          await retireOriginalNativeTurn(view.nativePrincipals!, operation, 'turn_terminal');
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      if (failed) throw first;
      entry.closed = true;
    });
    return retirement;
  };
  return {
    entry,
    operation,
    retire,
    open: async () => {
      binding = await openOriginalNativeTurn(
        view.nativePrincipals!,
        {
          runtime: 'claude-code',
          canonicalSessionId: sessionId,
          agentPath: path,
          canonicalCwd: path,
          signal: entry.controller.signal,
        },
        operation
      );
      if (entry.retired) {
        await retireOriginalNativeTurn(view.nativePrincipals!, operation, 'setup_failed');
        throw new Error('TestMode native opening completed after retirement.');
      }
      return binding;
    },
  };
}
/** Prepare the original native Room responder while retaining captured principal and destination checks. Requires the original private owner before effects. */
export async function prepareNative(
  owner: object,
  source: OriginalFrozenRoomSource,
  holder: SseResponse,
  key: string
): Promise<PreparedRoomResponder | undefined> {
  const view = readOriginalTestModeNativeMethodView(owner);
  const principals = view.nativePrincipals;
  if (!principals || view.nativeEntries.has(key)) return undefined;
  const target = readOriginalFrozenRoomTarget(source, 'claude-code');
  requireOriginalRoomPrincipalService(source, principals);
  const acquisition = captureNativeSessionAcquisition(view.nativeLocks, key, holder);
  if (!acquisition || target.sessionId !== key) return undefined;
  const own = view.installNative(key, target.agentPath, acquisition, holder);
  try {
    const binding = await own.open();
    const prepared: PreparedRoomResponder = Object.freeze({ kind: 'prepared-room-responder' });
    let started = false;
    view.custody.testModePrepared.set(prepared, {
      runtime: view.runtime,
      source,
      nativeOperation: own.operation,
      entry: own.entry,
      binding,
      retire: own.retire,
      start: (committed) => {
        if (started || !view.custody.readTestModePreparedRoomResponder(view.runtime, prepared))
          throw new Error('TestMode original preparation cannot start twice or after retirement.');
        started = true;
        return view.nativeStream(key, 'Document update', { cwd: target.agentPath }, own, {
          prepared,
          committed,
        });
      },
    });
    if (!view.custody.readTestModePreparedRoomResponder(view.runtime, prepared)) {
      view.custody.testModePrepared.delete(prepared);
      throw new Error('TestMode preparation retired during setup.');
    }
    return prepared;
  } catch (cause) {
    try {
      await own.retire();
    } catch {}
    throw cause;
  }
}
/** Return the original held native stream and its exact retirement and emission lifecycle. Requires the original private owner before effects. */
export function nativeStream(
  owner: object,
  sessionId: string,
  text: string,
  opts: MessageOpts | undefined,
  own: TestModeInstalled,
  room?: { prepared: PreparedRoomResponder; committed: OriginalCommittedRoomResponder }
) {
  const view = readOriginalTestModeNativeMethodView(owner);
  own.entry.placementOptions = Object.freeze({
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts?.forAgent !== undefined ? { forAgent: opts.forAgent } : {}),
    ...(opts?.additionalDirectories !== undefined
      ? {
          additionalDirectories: Object.freeze(
            opts.additionalDirectories.map((grant) => Object.freeze({ ...grant }))
          ),
        }
      : {}),
  });
  let closed = false;
  let stopPhase = 0;
  const stopEvents = new WeakSet<object>();
  const stopContinuation = () =>
    !closed &&
    stopPhase < 3 &&
    own.entry.interrupted === true &&
    own.entry.retired &&
    view.custody.nativeSignalAborted.call(own.entry.controller.signal) &&
    own.entry.scenarioStarts === 1 &&
    view.custody.originalMapGet.call(view.nativeEntries, sessionId) === own.entry;
  const streamCapture: { returned?: AsyncGenerator<StreamEvent> } = {};
  const run = async function* (this: TestModeRuntime): AsyncGenerator<StreamEvent> {
    let failed = false,
      first: unknown;
    try {
      if (!room) await own.open();
      if (!view.custody.readTestModeNativeOperation(own.operation))
        throw new Error('TestMode native entry retired.');
      if (room) {
        requireCurrentOriginalCommittedRoomResponder(
          room.committed,
          view.runtime,
          room.prepared,
          own.operation
        );
      }
      const context = readOriginalPreparedRoomContext(
        view.runtime,
        own.entry.holder,
        sessionId,
        opts
      );
      if (!view.custody.readTestModeNativeOperation(own.operation))
        throw new Error('TestMode native entry retired during context capture.');
      if (context) view.preparedRoomContexts.set(sessionId, context);
      // Fixed original scenario continuation; public sendMessage replacement cannot redirect this effect.
      yield* view.sendScenario(sessionId, text, opts, { own, room });
    } catch (cause) {
      failed = true;
      first = cause;
    } finally {
      if (room) {
        view.custody.testModePrepared.delete(room.prepared);
        try {
          retireOriginalCommittedRoomResponder(
            room.committed,
            view.runtime,
            room.prepared,
            own.operation
          );
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      }
      try {
        await own.retire();
        if (
          streamCapture.returned &&
          view.activeNativeStreams.get(sessionId) === streamCapture.returned
        )
          view.activeNativeStreams.delete(sessionId);
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    }
    if (failed) throw first;
  }.call(view.runtime);
  const metadata = room
    ? {
        runtime: view.runtime,
        prepared: room.prepared,
        operation: own.operation,
        committed: room.committed,
        events: new WeakSet<object>(),
        terminal: undefined as 'turn_done' | 'failed' | 'cancelled' | undefined,
        retire: async () => {
          let failed = false,
            first: unknown;
          try {
            await close();
          } catch (cause) {
            failed = true;
            first = cause;
          }
          try {
            await run.return(undefined);
          } catch (cause) {
            if (!failed) {
              failed = true;
              first = cause;
            }
          }
          if (failed) throw first;
        },
      }
    : undefined;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Retirement happens synchronously before the first cleanup await, including an unpulled stream.
    own.entry.retired = true;
    own.entry.controller.abort();
    let failed = false,
      first: unknown;
    if (room) {
      view.custody.testModePrepared.delete(room.prepared);
      try {
        retireOriginalCommittedRoomResponder(
          room.committed,
          view.runtime,
          room.prepared,
          own.operation
        );
      } catch (cause) {
        failed = true;
        first = cause;
      }
    }
    try {
      await own.retire();
      if (
        streamCapture.returned &&
        view.activeNativeStreams.get(sessionId) === streamCapture.returned
      )
        view.activeNativeStreams.delete(sessionId);
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    if (failed) throw first;
  };
  const returned: AsyncGenerator<StreamEvent> = {
    async next(value) {
      if (closed) return { done: true, value: undefined };
      const result = await run.next(value);
      if (stopContinuation()) {
        if (result.done) {
          stopPhase = 3;
        } else if (
          stopPhase === 0 &&
          result.value.type === 'session_status' &&
          'terminalReason' in result.value.data &&
          result.value.data.terminalReason === 'aborted_streaming'
        ) {
          view.custody.originalObjectFreeze(result.value.data);
          view.custody.originalObjectFreeze(result.value);
          stopEvents.add(result.value);
          stopPhase = 1;
        } else if (stopPhase === 1 && result.value.type === 'done') {
          view.custody.originalObjectFreeze(result.value.data);
          view.custody.originalObjectFreeze(result.value);
          stopEvents.add(result.value);
          stopPhase = 2;
        }
      }
      if (metadata && !result.done) {
        metadata.events.add(result.value);
        if (result.value.type === 'error') metadata.terminal = 'failed';
        if (
          result.value.type === 'session_status' &&
          'terminalReason' in result.value.data &&
          result.value.data.terminalReason === 'aborted_streaming'
        )
          metadata.terminal = 'cancelled';
        if (result.value.type === 'done' && metadata.terminal === undefined)
          metadata.terminal = 'turn_done';
      }
      return result;
    },
    async return(value) {
      const closure = close().then(
        () => ({ failed: false as const }),
        (cause: unknown) => ({ failed: true as const, cause })
      );
      let failed = false,
        first: unknown;
      let result: IteratorResult<StreamEvent> = { done: true, value };
      try {
        result = await run.return(value);
      } catch (cause) {
        failed = true;
        first = cause;
      }
      const cleanup = await closure;
      if (cleanup.failed && !failed) {
        failed = true;
        first = cleanup.cause;
      }
      if (failed) throw first;
      return result;
    },
    async throw(cause) {
      const closure = close().then(
        () => ({ failed: false as const }),
        (cause: unknown) => ({ failed: true as const, cause })
      );
      let failed = false,
        first: unknown;
      let result: IteratorResult<StreamEvent> = { done: true, value: undefined };
      try {
        result = await run.throw(cause);
      } catch (error) {
        failed = true;
        first = error;
      }
      const cleanup = await closure;
      if (cleanup.failed && !failed) {
        failed = true;
        first = cleanup.cause;
      }
      if (failed) throw first;
      return result;
    },
    async [Symbol.asyncDispose]() {
      await disposeOriginalStream();
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  streamCapture.returned = returned;
  const disposeOriginalStream = returned.return.bind(returned, undefined);
  view.custody.testModeOriginalStreams.set(returned, {
    runtime: view.runtime,
    own,
    sessionId,
    options: captureTurnLevelOptions(opts),
    stopContinuation,
    stopEvents,
    resolve: async () => {
      const result = await resolveOriginalNativePrincipal(view.nativePrincipals!, own.operation);
      if (
        !view.custody.readTestModeNativeOperation(own.operation) ||
        view.custody.testModeOriginalStreams.get(returned)?.own !== own
      )
        return { status: 'refused', reason: 'revoked' };
      return result;
    },
  });
  if (metadata) view.custody.testModeStreams.set(returned, metadata);
  view.activeNativeStreams.set(sessionId, returned);
  return returned;
}
