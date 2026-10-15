import { readOriginalClaudeNativePreparationView } from '../claude-code-runtime.js';
import { type ClaudePreparedRoomContinuation } from '../custody/claude-native-custody.js';
import { captureTurnLevelOptions } from '../../../core/turn-power/turn-levels.js';
import { isNonFatalErrorCode } from '@dorkos/shared/run-outcome';
import type { OriginalRoomDispatchCustody } from '../../../rooms/service/room-core.js';
import { retireOriginalCommittedRoomResponder } from '../../../canvas/doc-channel/operations/room-current-operation.js';
import { isCurrentClaudeNativeSession } from '../sessions/session-store.js';
import type { StreamEvent } from '@dorkos/shared/types';
import type { MessageOpts, SseResponse } from '@dorkos/shared/agent-runtime';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  type NativeSessionAcquisition,
} from '../../../session/session-lock.js';
import { detectAuthError } from '@dorkos/shared/runtime-error-classification';
import {
  asCreditsStopped,
  creditsStoppedEvent,
  onCreditsSession,
} from '../messaging/credits-launch.js';
import { executeSdkQuery } from '../messaging/message-sender.js';
import { homeOf, resolveAgentHome, turnAgentOf } from '../../../core/agent-identity/index.js';
import type { RevokeConnectorTurnReason } from '../../../connectors/runtime-principal-port.js';

/** Run the original createMessage lifetime only for its private runtime preparation key. */
export function createMessage(
  ownerKey: object,
  sessionId: string,
  content: string,
  opts: MessageOpts | undefined,
  acquisition?: NativeSessionAcquisition,
  roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
  roomPrepared?: ClaudePreparedRoomContinuation
): AsyncGenerator<StreamEvent> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const lifetime: {
    closed: boolean;
    entered: boolean;
    retire?: () => void;
    acquisition?: NativeSessionAcquisition;
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
    roomPrepared?: ClaudePreparedRoomContinuation;
  } = {
    closed: false,
    entered: false,
    acquisition,
    roomOrigin,
    roomPrepared,
    retire: roomPrepared
      ? () => {
          roomPrepared.nativeEntry.retired = true;
        }
      : undefined,
  };
  const stream = facet.sendOwnedMessage(sessionId, content, opts, lifetime);
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
        const own = facet.originalClaudeRoomStreams.get(returned)!;
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
    facet.originalClaudeLockedStreams.set(returned, {
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
    facet.originalClaudeRoomStreams.set(returned, {
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

/** Run the original sendOwnedMessage lifetime only for its private runtime preparation key. */
export async function* sendOwnedMessage(
  ownerKey: object,
  sessionId: string,
  content: string,
  opts: MessageOpts | undefined,
  lifetime: {
    closed: boolean;
    entered: boolean;
    retire?: () => void;
    acquisition?: NativeSessionAcquisition;
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
    roomPrepared?: ClaudePreparedRoomContinuation;
  }
): AsyncGenerator<StreamEvent> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  let failed = false,
    first: unknown;
  const cleanup = async (work: () => unknown | Promise<unknown>) => {
    try {
      await work();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  };
  // Join this scope to its captured cleanup before returning or reporting failure.
  const drainOriginalCleanup = async () => {
    const own = lifetime.roomPrepared;
    if (own) {
      own.finished = true;
      const committed = own.committed;
      if ((failed || lifetime.closed) && committed)
        await cleanup(() =>
          retireOriginalCommittedRoomResponder(
            committed,
            facet.runtime,
            own.prepared,
            own.nativeOperation
          )
        );
      await cleanup(() => own.retire());
    }
    if (failed) throw first;
  };
  try {
    if (facet.relayPreparing.has(sessionId))
      throw new Error('Original Relay session owner remains unresolved');
    lifetime.entered = true;
    if (lifetime.roomPrepared) lifetime.roomPrepared.entered = true;
    const session =
      lifetime.roomPrepared?.session ??
      (await facet.sessionStore.ensureForMessage(
        sessionId,
        facet.transcriptReader,
        facet.cwd,
        opts
      ));

    // Neither the window snapshot nor the room marker is lifted onto the session
    // any more: the `ui` verbs are capabilities, and both facts are bound
    // runtime-neutrally by the trigger (spec `canvas-agent-seat` §5). That is the
    // whole of what made Codex and OpenCode unable to answer "what is on the
    // canvas" — the answer lived on this object, which only this runtime has.

    const cwdKey = opts?.cwd || session.cwd || facet.cwd;

    // The agent this turn acts as: the home the folder resolves to, and never
    // another than the turn is dispatched as (DOR-2091, DOR-2355,
    // `core/agent-identity/agent-home.ts`). The same answer the launch resolves
    // its token from, so the connections below and the token cannot name two
    // different agents.
    const agentPath = homeOf(resolveAgentHome(cwdKey, turnAgentOf(opts)));
    const meshAgent = agentPath ? facet.meshCore?.getByPath(agentPath) : undefined;

    if (lifetime.closed) {
      if (lifetime.roomPrepared) {
        lifetime.roomPrepared.finished = true;
        lifetime.roomPrepared.stopRead = undefined;
      }
      return;
    }
    const { nativeEntry, runtimeEntries, connectorTurn } =
      lifetime.roomPrepared ??
      facet.installNativeTurn(
        sessionId,
        session,
        cwdKey,
        agentPath,
        meshAgent,
        lifetime.acquisition,
        false,
        lifetime.roomOrigin
      );
    lifetime.retire = () => {
      nativeEntry.retired = true;
    };
    let connectorRevokeReason: RevokeConnectorTurnReason = 'setup_failed';
    let observedEvent = false;
    let sawRuntimeError = false;
    try {
      session.connectorTurn = connectorTurn;
      // Unconditionally, `false` included: a warm session a person later talks
      // to must hold for their answer again (spec `agent-permissions` D6).
      session.unattendedApprovals = opts?.unattendedApprovals === true;
      // Per turn too, for the same reason: an automatic carry-over's first turn
      // has nobody to ask, and the person who opens it next does.
      session.unattendedTurn = opts?.unattended === true;
      // Bound each turn by its sender, clearing a prior ceiling for the next direct turn.
      if (opts?.permissionCeiling !== undefined) {
        session.turnPermissionCeiling = opts.permissionCeiling;
      } else {
        delete session.turnPermissionCeiling;
      }
      const accessContext =
        connectorTurn &&
        facet.connectorRuntimeTools &&
        meshAgent &&
        !content.trimStart().startsWith('/')
          ? await facet.accountsAccess.select(
              facet.connectorRuntimeTools,
              meshAgent.id,
              session.sdkSessionId || sessionId,
              // The connection tools and the service lookup share the in-session server.
              { serviceCatalog: true }
            )
          : undefined;
      if (accessContext)
        opts = {
          ...opts,
          additionalContext: [...(opts?.additionalContext ?? []), accessContext.entry],
        };
      if (lifetime.closed || !isCurrentClaudeNativeSession(facet.sessionStore, session)) return;
      const senderOpts = facet.buildSenderOpts(sessionId, session, cwdKey, turnAgentOf(opts));

      const persistentArgs = {
        sessionId,
        content,
        session,
        opts: senderOpts,
        ...(opts !== undefined ? { messageOpts: opts } : {}),
      };
      if (lifetime.roomPrepared) {
        facet.originalClaudePersistentRequests.set(persistentArgs, {
          persistent: facet.persistent,
          continuation: lifetime.roomPrepared,
        });
      }
      const persistent = facet.persistent.shouldDispatch(sessionId);
      if (lifetime.roomPrepared) {
        lifetime.roomPrepared.stopRead = persistent
          ? () => facet.persistent.stopOriginalRoomRequest(persistentArgs)
          : lifetime.roomPrepared.stopRead;
      }
      if (!persistent) opts?.dispatchHold?.proceed();
      const stream = persistent
        ? facet.persistent.dispatch(persistentArgs)
        : executeSdkQuery(sessionId, content, session, senderOpts, opts);

      for await (const raw of stream) {
        observedEvent = true;
        // A credits session whose token was refused partway through is a
        // credits problem, not the person's Claude sign-in: it surfaces as the
        // credits card, and no "sign in to Claude again" notice is raised
        // (ADR 261001-000811).
        const event = onCreditsSession(session) ? asCreditsStopped(raw) : raw;
        if (event.type === 'error') sawRuntimeError = true;
        yield event;
      }
      if (observedEvent && !sawRuntimeError)
        accessContext?.commit(session.sdkSessionId || sessionId);
      connectorRevokeReason = sawRuntimeError ? 'runtime_failed' : 'turn_terminal';
    } catch (error) {
      connectorRevokeReason = observedEvent ? 'runtime_failed' : 'setup_failed';
      const message = error instanceof Error ? error.message : String(error);
      if (onCreditsSession(session) && detectAuthError({ message })) {
        yield creditsStoppedEvent(message);
        return;
      }
      failed = true;
      first = error;
    } finally {
      if (lifetime.roomPrepared) {
        lifetime.roomPrepared.finished = true;
        lifetime.roomPrepared.stopRead = undefined;
      }
      nativeEntry.retired = true;
      if (runtimeEntries.get(sessionId) === nativeEntry) runtimeEntries.delete(sessionId);
      if (connectorTurn) {
        if (session.connectorTurn === connectorTurn) session.connectorTurn = undefined;
        if (!lifetime.roomPrepared)
          await cleanup(() =>
            connectorTurn.revoke(connectorTurn.cancelled ? 'turn_cancelled' : connectorRevokeReason)
          );
      }
    }
  } catch (cause) {
    if (!failed) {
      failed = true;
      first = cause;
    }
  } finally {
    await drainOriginalCleanup();
  }
}
