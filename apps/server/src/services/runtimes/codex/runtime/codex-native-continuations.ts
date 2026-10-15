/** Original native stream preparation, start and first-cause retirement family. */
import { type CodexPreparedRoomContinuation, type CodexWakeContext } from './codex-runtime-data.js';
import { captureTurnLevelOptions } from '../../../core/turn-power/turn-levels.js';
import { isNonFatalErrorCode } from '@dorkos/shared/run-outcome';
import { retireOriginalCommittedRoomResponder } from '../../../canvas/doc-channel/operations/room-current-operation.js';
import type { OriginalCommittedRoomResponder } from '../../../canvas/doc-channel/current/current-operation-types.js';
import { readOriginalRoomDispatchLifecycle } from '../../../session/trigger-turn.js';
import type { OriginalRoomDispatchCustody } from '../../../rooms/service/room-core.js';
import { requireOriginalRoomPrincipalService } from '../../../canvas/doc-channel/operations/room-current-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
} from '../../../canvas/doc-channel/current/current-operation-types.js';
import { openOriginalNativeTurn } from '../../../connectors/principal/runtime-principal-service.js';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentRegistryPort, MessageOpts, SseResponse } from '@dorkos/shared/agent-runtime';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  type NativeSessionAcquisition,
} from '../../../session/session-lock.js';
import { type AgentHome } from '../../../core/agent-identity/index.js';
import { type ConnectorRuntimeTools } from '../../connector-tools.js';
import type { OpenConnectorTurnResult } from '../../../connectors/runtime-principal-port.js';
import type { CodexNativeEntry } from './codex-native-custody.js';
import type { createIsolatedCodexNativeCustody } from './codex-native-custody.js';
/** Fixed native continuation receiver; no actual key, map or view is exported. */
interface OriginalCodexNativeContinuationView {
  readonly runtime: object;
  readonly custody: ReturnType<typeof createIsolatedCodexNativeCustody>;
  readonly nativeMapGet: typeof Map.prototype.get;
  readonly nativeMapSet: typeof Map.prototype.set;
  readonly activeTurns: Map<string, AbortController>;
  readonly activeConnectorBindings: Map<AbortController, string>;
  readonly connectorRuntimeTools: ConnectorRuntimeTools | undefined;
  readonly meshCore: AgentRegistryPort | undefined;
  readonly identityPathFor: (cwd: string, forAgent: string | undefined) => AgentHome | undefined;
  readonly sendOwnedMessage: (
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    lifetime: {
      closed: boolean;
      entered: boolean;
      retire?: () => void;
      acquisition?: NativeSessionAcquisition;
      roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
      roomPrepared?: CodexPreparedRoomContinuation;
    },
    origin: 'dispatched' | 'runtime',
    inherited?: CodexWakeContext
  ) => AsyncGenerator<StreamEvent>;
  readonly installNativeTurn: (
    sessionId: string,
    cwd: string,
    agentPath: string | undefined,
    controller: AbortController,
    acquisition?: NativeSessionAcquisition,
    refuseExisting?: boolean,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>
  ) => { nativeOperation: object; nativeEntry: CodexNativeEntry };
  readonly createMessage: (
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    acquisition?: NativeSessionAcquisition,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
    roomPrepared?: CodexPreparedRoomContinuation,
    origin?: 'dispatched' | 'runtime',
    inherited?: CodexWakeContext
  ) => AsyncGenerator<StreamEvent>;
}
/** External factories own unrelated keys; only the runtime module retains its actual registrar. */
export function createIsolatedCodexNativeContinuations() {
  const views = new WeakMap<object, OriginalCodexNativeContinuationView>();
  const get = WeakMap.prototype.get,
    set = WeakMap.prototype.set,
    apply = Reflect.apply;
  function actual(owner: object): OriginalCodexNativeContinuationView {
    const view = apply(get, views, [owner]) as OriginalCodexNativeContinuationView | undefined;
    if (!view) throw new Error('Unknown original Codex native continuation.');
    return view;
  }
  /** Original private native continuation; its fixed constructor view is checked before effects. */
  function createMessage(
    owner: object,
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    acquisition?: NativeSessionAcquisition,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
    roomPrepared?: CodexPreparedRoomContinuation,
    origin: 'dispatched' | 'runtime' = 'dispatched',
    inherited?: CodexWakeContext
  ): AsyncGenerator<StreamEvent> {
    const facet = actual(owner);
    const lifetime: {
      closed: boolean;
      entered: boolean;
      retire?: () => void;
      acquisition?: NativeSessionAcquisition;
      roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
      roomPrepared?: CodexPreparedRoomContinuation;
    } = {
      closed: false,
      entered: false,
      acquisition,
      roomOrigin,
      roomPrepared,
      retire: roomPrepared
        ? () => {
            roomPrepared.nativeEntry.retired = true;
            roomPrepared.controller.abort();
          }
        : undefined,
    };
    const stream = facet.sendOwnedMessage(sessionId, content, opts, lifetime, origin, inherited);
    const close = () => {
      lifetime.closed = true;
      lifetime.retire?.();
      // Cancel the actual prepared native owner before generator return queues
      // behind a pending transport read. Its memo is joined below and in finally.
      if (roomPrepared) void roomPrepared.retire().catch(() => {});
    };
    const joinOriginalClose = async (result: ReturnType<typeof stream.return>) => {
      let failed = false;
      let first: unknown;
      let outcome: Awaited<ReturnType<typeof stream.return>> | undefined;
      try {
        outcome = await result;
      } catch (cause) {
        failed = true;
        first = cause;
      }
      const own = lifetime.roomPrepared!;
      try {
        retireOriginalCommittedRoomResponder(
          own.committed!,
          facet.runtime,
          own.prepared,
          own.nativeOperation
        );
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      try {
        await own.retire();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      if (failed) throw first;
      return outcome!;
    };
    const capturedReturn = stream.return.bind(stream);
    const returnOriginal: AsyncGenerator<StreamEvent>['return'] = (value) => {
      close();
      const result = capturedReturn(value);
      return roomPrepared ? joinOriginalClose(result) : result;
    };
    const returned: AsyncGenerator<StreamEvent> = {
      next: (value) => {
        if (!roomPrepared) return stream.next(value);
        return stream.next(value).then((result) => {
          const own = facet.custody.originalCodexRoomStreams.get(returned)!;
          if (!result.done && result.value) {
            own.emitted.add(result.value);
            const data = result.value.data;
            if (
              data &&
              typeof data === 'object' &&
              'terminalReason' in data &&
              typeof data.terminalReason === 'string'
            )
              own.reason = data.terminalReason;
            if (
              result.value.type === 'error' &&
              !isNonFatalErrorCode(
                data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
                  ? data.code
                  : undefined
              )
            )
              own.failed = true;
            if (result.value.type === 'done') own.done = true;
          }
          return result;
        });
      },
      return: returnOriginal,
      [Symbol.asyncDispose]: async () => {
        await returnOriginal(undefined);
      },
      throw: (error) => {
        close();
        const result = stream.throw(error);
        return roomPrepared ? joinOriginalClose(result) : result;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    if (acquisition)
      facet.custody.originalCodexLockedStreams.set(returned, {
        runtime: facet.runtime,
        sessionId,
        options: captureTurnLevelOptions(opts),
        current: () => {
          if (lifetime.closed) return false;
          const at = Date.now(),
            activity = captureNativeSessionActivity(acquisition, at);
          return !!activity && !!readNativeSessionAcquisition(acquisition, activity, at, sessionId);
        },
      });
    const originalReturn = returned.return.bind(returned);
    if (roomPrepared && roomPrepared.committed)
      facet.custody.originalCodexRoomStreams.set(returned, {
        runtime: facet.runtime,
        prepared: roomPrepared.prepared,
        operation: roomPrepared.nativeOperation,
        committed: roomPrepared.committed,
        emitted: new WeakSet(),
        close: () => originalReturn(undefined),
        failed: false,
        done: false,
      });
    return returned;
  }
  /** Original private native continuation; its fixed constructor view is checked before effects. */
  function installNativeTurn(
    owner: object,
    sessionId: string,
    cwd: string,
    agentPath: string | undefined,
    controller: AbortController,
    acquisition?: NativeSessionAcquisition,
    refuseExisting = false,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>
  ) {
    const facet = actual(owner);
    if (
      roomOrigin &&
      readOriginalRoomDispatchLifecycle(roomOrigin.holder, facet.runtime) !== roomOrigin.custody
    )
      throw new Error('Original Room dispatch lifetime is retired.');
    const active = facet.custody.codexOriginalActiveSlots.get(facet.runtime),
      slot = Object.getOwnPropertyDescriptor(facet.runtime, 'activeTurns');
    if (!active || !slot || !('value' in slot) || slot.value !== active)
      throw new Error('Native preparation requires its original active slot.');
    if (refuseExisting && facet.nativeMapGet.call(active, sessionId))
      throw new Error('Native preparation cannot replace a live entry.');
    facet.nativeMapSet.call(active, sessionId, controller);
    const nativeOperation = Object.freeze({});
    if (!facet.custody.codexNativeConstructors.has(facet.runtime))
      throw new Error('Native runtime operation requires its genuine constructor.');
    const nativeEntry = {
      roomOrigin,
      acquisition: acquisition,
      instance: facet.runtime,
      active,
      key: sessionId,
      entry: controller,
      signal: controller.signal,
      retired: false,
      runtime: 'codex' as const,
      agentPath,
      cwd,
    };
    facet.custody.codexNativeOperations.set(nativeOperation, nativeEntry);
    facet.custody.codexNativeControllers.set(controller, nativeEntry);

    return { nativeOperation, nativeEntry };
  }
  /** Original private native continuation; its fixed constructor view is checked before effects. */
  async function prepareRoomResponder(
    owner: object,
    source: OriginalFrozenRoomSource,
    target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
    acquisition: NativeSessionAcquisition
  ): Promise<PreparedRoomResponder | undefined> {
    const facet = actual(owner);
    const { sessionId, agentPath } = target;
    const tools = facet.connectorRuntimeTools;
    if (
      !tools ||
      facet.nativeMapGet.call(facet.custody.codexOriginalActiveSlots.get(facet.runtime)!, sessionId)
    )
      return undefined;
    requireOriginalRoomPrincipalService(source, tools.principals);
    if (
      facet.identityPathFor(agentPath, agentPath) !== agentPath ||
      facet.meshCore?.getByPath(agentPath)?.id !== target.agentId
    )
      throw new Error('Room responder differs from its approved target.');
    const controller = new AbortController();
    const { nativeOperation, nativeEntry } = facet.installNativeTurn(
      sessionId,
      agentPath,
      agentPath,
      controller,
      acquisition,
      true
    );
    let binding: OpenConnectorTurnResult | undefined;
    let retirement: Promise<void> | undefined;
    const retire = (): Promise<void> => {
      if (retirement) return retirement;
      let resolve!: () => void, reject!: (cause: unknown) => void;
      retirement = new Promise<void>((done, refused) => {
        resolve = done;
        reject = refused;
      });
      // Reserve the original retirement before abort callbacks can reenter.
      void (async () => {
        nativeEntry.retired = true;
        if (facet.activeTurns.get(sessionId) === controller) facet.activeTurns.delete(sessionId);
        controller.abort();
        facet.activeConnectorBindings.delete(controller);
        if (binding) await tools.principals.revoke(binding.bindingId, 'turn_cancelled');
      })().then(resolve, reject);
      return retirement;
    };
    try {
      binding = await openOriginalNativeTurn(
        tools.principals,
        {
          runtime: 'codex',
          canonicalSessionId: sessionId,
          agentPath,
          canonicalCwd: agentPath,
          signal: controller.signal,
        },
        nativeOperation
      );
      facet.activeConnectorBindings.set(controller, binding.bindingId);
      controller.signal.throwIfAborted();
      const at = Date.now(),
        activity = captureNativeSessionActivity(acquisition, at);
      if (
        !activity ||
        !readNativeSessionAcquisition(acquisition, activity, at, sessionId) ||
        !facet.custody.readCodexNativeOperation(nativeOperation)
      )
        throw new Error('Room responder retired during preparation.');
      const prepared: PreparedRoomResponder = Object.freeze({ kind: 'prepared-room-responder' });
      facet.custody.codexRoomPrepared.set(prepared, {
        runtime: facet.runtime,
        retire,
        source,
        nativeOperation,
        acquisition,
        start: (() => {
          let started = false;
          return (committed: OriginalCommittedRoomResponder) => {
            if (
              started ||
              !binding ||
              !facet.custody.readCodexPreparedRoomResponder(facet.runtime, prepared)
            )
              throw new Error('Room prepared entry cannot start twice or after retirement.');
            started = true;
            return facet.createMessage(
              sessionId,
              'Document update',
              { cwd: agentPath },
              acquisition,
              undefined,
              { prepared, committed, controller, nativeOperation, nativeEntry, binding, retire }
            );
          };
        })(),
      });
      return prepared;
    } catch (cause) {
      try {
        await retire();
      } catch {}
      throw cause;
    }
  }
  return Object.freeze({
    register(owner: object, view: OriginalCodexNativeContinuationView): void {
      apply(set, views, [owner, view]);
    },
    createMessage,
    installNativeTurn,
    prepareRoomResponder,
  });
}
