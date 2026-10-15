import {
  readOriginalClaudeNativePreparationView,
  readClaudeNativeOperation,
  readClaudePreparedRoomResponder,
} from '../claude-code-runtime.js';
import type {
  ClaudeNativeEntry,
  ClaudePreparedRoomContinuation,
} from '../custody/claude-native-custody.js';
import { readOriginalPersistentRoomState } from '../sessions/persistent-dispatch.js';
import { requireOriginalRoomPrincipalService } from '../../../canvas/doc-channel/operations/room-current-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
} from '../../../canvas/doc-channel/current/current-operation-types.js';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  type NativeSessionAcquisition,
} from '../../../session/session-lock.js';
import { homeOf, resolveAgentHome } from '../../../core/agent-identity/index.js';
import {
  resolveOriginalClaudeConnectorPrincipal,
  ClaudeConnectorTurnContext,
} from '../connector-turn-context.js';

/** Execute the original prepareRoomResponder body only for its constructor-private runtime key. */
export async function prepareRoomResponder(
  ownerKey: object,
  source: OriginalFrozenRoomSource,
  target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
  acquisition: NativeSessionAcquisition
): Promise<PreparedRoomResponder | undefined> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const { sessionId, agentPath } = target,
    tools = facet.connectorRuntimeTools;
  if (
    !tools ||
    facet.roomPreparing.has(sessionId) ||
    facet.relayPreparing.has(sessionId) ||
    (facet.claudeRuntimeEntries.get(facet.runtime)?.get(sessionId) &&
      !facet.claudeRuntimeEntries.get(facet.runtime)!.get(sessionId)!.retired)
  )
    return undefined;
  const capacity = readOriginalPersistentRoomState(facet.persistent, sessionId);
  if (capacity === 'running' || capacity === 'warming' || capacity === 'resuming') return undefined;
  requireOriginalRoomPrincipalService(source, tools.principals);
  const meshAgent = facet.meshCore?.getByPath(agentPath);
  if (
    homeOf(resolveAgentHome(agentPath, agentPath)) !== agentPath ||
    meshAgent?.id !== target.agentId
  )
    throw new Error('Room responder differs from its approved target.');
  const pending = { retired: false };
  facet.roomPreparing.set(sessionId, pending);
  let installed:
    | {
        nativeEntry: ClaudeNativeEntry;
        runtimeEntries: Map<string, ClaudeNativeEntry>;
        connectorTurn: ClaudeConnectorTurnContext | undefined;
      }
    | undefined;
  try {
    const store = facet.claudeOriginalStores.get(facet.runtime)!;
    const session = await store.ensureForMessage(sessionId, facet.transcriptReader, facet.cwd, {
      cwd: agentPath,
    });
    if (pending.retired) throw new Error('Room responder preparation retired.');

    const setup = facet.installNativeTurn(
      sessionId,
      session,
      agentPath,
      agentPath,
      meshAgent,
      acquisition,
      true
    );
    installed = setup;
    if (!setup.connectorTurn) throw new Error('Original Claude connector setup is unavailable.');
    session.connectorTurn = setup.connectorTurn;
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
        const dedicated = facet.claudeRoomQuerySessions.get(session);
        let failed = false,
          firstCause: unknown;
        const remember = (cause: unknown) => {
          if (!failed) {
            failed = true;
            firstCause = cause;
          }
        };
        let readDrain: Promise<void> | undefined;
        try {
          readDrain = dedicated?.stopRead?.().catch(remember);
        } catch (cause) {
          remember(cause);
        }
        setup.nativeEntry.retired = true;
        if (setup.runtimeEntries.get(sessionId) === setup.nativeEntry)
          setup.runtimeEntries.delete(sessionId);
        if (session.connectorTurn === setup.connectorTurn) session.connectorTurn = undefined;
        if (dedicated && !dedicated.entered) dedicated.finished = true;
        try {
          await setup.connectorTurn!.cancel();
        } catch (cause) {
          remember(cause);
        }
        try {
          await readDrain;
        } catch (cause) {
          remember(cause);
        }
        if (failed) throw firstCause;
      })().then(resolve, reject);
      return retirement;
    };
    await resolveOriginalClaudeConnectorPrincipal(setup.connectorTurn);
    const native = readClaudeNativeOperation(setup.nativeOperation);
    if (
      pending.retired ||
      !native ||
      native.canonicalSessionId !== sessionId ||
      native.agentPath !== agentPath ||
      native.canonicalCwd !== agentPath
    )
      throw new Error('Room responder preparation retired.');
    const time = Date.now(),
      activity = captureNativeSessionActivity(acquisition, time);
    if (!activity || !readNativeSessionAcquisition(acquisition, activity, time, sessionId))
      throw new Error('Room responder lock retired during preparation.');
    const prepared: PreparedRoomResponder = Object.freeze({ kind: 'prepared-room-responder' });
    const continuation: ClaudePreparedRoomContinuation = {
      prepared,
      runtime: facet.runtime,
      session,
      sessionId,
      nativeOperation: setup.nativeOperation,
      nativeEntry: setup.nativeEntry,
      runtimeEntries: setup.runtimeEntries,
      connectorTurn: setup.connectorTurn,
      acquisition,
      started: false,
      entered: false,
      finished: false,
      consumed: false,
      retire,
    };
    facet.claudeRoomQuerySessions.set(session, continuation);
    facet.claudeRoomPrepared.set(prepared, {
      runtime: facet.runtime,
      retire,
      source,
      nativeOperation: setup.nativeOperation,
      acquisition,
      start: (committed) => {
        if (continuation.started || !readClaudePreparedRoomResponder(facet.runtime, prepared))
          throw new Error('Room prepared entry cannot start twice or after retirement.');
        continuation.started = true;
        continuation.committed = committed;
        return facet.createMessage(
          sessionId,
          'Document update',
          { cwd: agentPath },
          acquisition,
          undefined,
          continuation
        );
      },
    });
    if (facet.roomPreparing.get(sessionId) === pending) facet.roomPreparing.delete(sessionId);
    return prepared;
  } catch (cause) {
    pending.retired = true;
    if (facet.roomPreparing.get(sessionId) === pending) facet.roomPreparing.delete(sessionId);
    if (installed) {
      installed.nativeEntry.retired = true;
      if (installed.runtimeEntries.get(sessionId) === installed.nativeEntry)
        installed.runtimeEntries.delete(sessionId);
      if (installed.nativeEntry.session.connectorTurn === installed.connectorTurn)
        installed.nativeEntry.session.connectorTurn = undefined;
      try {
        await installed.connectorTurn?.revoke('setup_failed');
      } catch {
        /* Preserve original setup cause. */
      }
    }
    throw cause;
  }
}
