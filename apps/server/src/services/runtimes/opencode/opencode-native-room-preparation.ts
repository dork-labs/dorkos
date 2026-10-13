import { readOriginalOpenCodeRuntimeView } from './opencode-runtime.js';
import { readOriginalRoomDispatchLifecycle } from '../../session/trigger-turn.js';
import type { OriginalRoomDispatchCustody } from '../../rooms/service/room-core.js';
import { requireOriginalRoomPrincipalService } from '../../canvas/doc-channel/operations/room-current-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/current/current-operation-types.js';
import { openOriginalNativeTurn } from '../../connectors/principal/runtime-principal-service.js';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  type NativeSessionAcquisition,
} from '../../session/session-lock.js';
import { homeOf, resolveAgentHome } from '../../core/agent-identity/index.js';
import { OPENCODE_LABEL, OPENCODE_OWN_PLAN, type OpenCodeSidecarPlan } from './credits-sidecar.js';
import { CreditsUnavailableError } from '../../core/cloud/credits-protocols.js';
import type { ActiveTurn, SettingUpTurn, OpenCodeNativeEntry } from './opencode-runtime.js';
import {
  readOpenCodeNativeOperation,
  readOpenCodePreparedRoomResponder,
} from './opencode-runtime.js';

/**
 * What the sidecar runs this turn on, made so before anything is sent.
 *
 * @param sessionId - The session about to send.
 * @param own - This turn's own setting-up marker, which is not "another".
 * @throws {CreditsUnavailableError} On credits, when credits cannot pay.
 */
export async function prepareSidecar(
  runtimeOwner: object,
  sessionId: string,
  own: SettingUpTurn
): Promise<OpenCodeSidecarPlan> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  const othersActive =
    [...facet.activeTurns.keys()].some((id) => id !== sessionId) ||
    [...facet.settingUp].some((other) => other !== own && other.sessionId !== sessionId);
  if (facet.provider.prepareTurn) return facet.provider.prepareTurn(othersActive);
  // A provider that cannot be made right for credits never runs a turn the
  // person set to credits: refused, not sent on whatever it holds.
  if (facet.runsOnCredits()) throw new CreditsUnavailableError('not-supported', OPENCODE_LABEL);
  return OPENCODE_OWN_PLAN;
}

/**
 * Drive one OpenCode turn end to end: resolve the session + its demux key,
 * subscribe a per-turn tap on the ONE shared global event stream, wait for it
 * to be observably live, fire `trigger` (a prompt or a compaction), then yield
 * the mapped events with permission enforcement. {@link mapOpenCodeTurn}
 * guarantees exactly one terminal `done`, and teardown is identity-guarded so a
 * stale turn racing a newer one never clears the newer turn's shared state.
 * Shared by {@link sendMessage} (prompt) and {@link executeCommandIntent}
 * (compact) so both ride the identical trigger → demux → map lifecycle.
 *
 * @param sessionId - DorkOS session id.
 * @param cwd - Working directory used to resolve the client and session.
 * @param title - Optional title used only when a new OpenCode session is created.
 * @param trigger - Fires the turn after MCP registration settles, receiving
 *   whether the room-tool server was actually applied.
 * @param opts - Marks a model prompt that receives connector runtime tools,
 *   and names the agent a room turn is for (DOR-2091).
 */
export async function resolveNativeClient(
  runtimeOwner: object,
  sessionId: string,
  cwd: string,
  title?: string,
  pending?: { retired: boolean }
): Promise<{ ocSessionId: string; client: OpencodeClient; directory: string }> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  if (pending?.retired) throw new Error('Room responder preparation retired.');
  const ocSessionId = await facet.resolveOpenCodeSession(sessionId, cwd, title);
  if (pending?.retired) throw new Error('Room responder preparation retired.');
  const client = await facet.provider.getClient(cwd);
  if (pending?.retired) throw new Error('Room responder preparation retired.');
  const directory = await facet.resolveSessionDirectory(client, ocSessionId);
  if (pending?.retired) throw new Error('Room responder preparation retired.');
  return { ocSessionId, client, directory };
}

/** Run the original guarded installNativeTurn operation. */
export function installNativeTurn(
  runtimeOwner: object,
  sessionId: string,
  directory: string,
  client: OpencodeClient,
  turn: ActiveTurn,
  acquisition?: NativeSessionAcquisition,
  refuseExisting = false,
  roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>
): { nativeOperation: object; nativeEntry: OpenCodeNativeEntry } {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  if (
    roomOrigin &&
    readOriginalRoomDispatchLifecycle(roomOrigin.holder, facet.runtime) !== roomOrigin.custody
  )
    throw new Error('Original Room dispatch lifetime is retired.');
  const controller = turn.controller;
  const active = facet.custody.openCodeOriginalActiveSlots.get(facet.runtime),
    slot = Object.getOwnPropertyDescriptor(facet.runtime, 'activeTurns');
  if (!active || !slot || !('value' in slot) || slot.value !== active)
    throw new Error('Native preparation requires its original active slot.');
  if (refuseExisting && facet.custody.nativeMapGet.call(active, sessionId))
    throw new Error('Native preparation cannot replace a live entry.');
  facet.custody.nativeMapSet.call(active, sessionId, turn);
  const nativeOperation = Object.freeze({});
  if (!facet.custody.openCodeNativeConstructors.has(facet.runtime))
    throw new Error('Native runtime operation requires its genuine constructor.');
  const nativeEntry = {
    roomOrigin,
    acquisition: acquisition,
    instance: facet.runtime,
    active,
    key: sessionId,
    entry: turn,
    signal: controller.signal,
    retired: false,
    runtime: facet.type,
    cwd: directory,
    client,
    agentPath: undefined as string | undefined,
  };
  facet.custody.openCodeNativeOperations.set(nativeOperation, nativeEntry);
  facet.custody.openCodeNativeTurns.set(turn, nativeEntry);
  return { nativeOperation, nativeEntry };
}

/** Run the original guarded prepareRoomResponder operation. */
export async function prepareRoomResponder(
  runtimeOwner: object,
  source: OriginalFrozenRoomSource,
  target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
  acquisition: NativeSessionAcquisition
): Promise<PreparedRoomResponder | undefined> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  const { sessionId, agentPath } = target,
    tools = facet.connectorRuntimeTools;
  if (
    !tools ||
    facet.custody.nativeMapGet.call(
      facet.custody.openCodeOriginalActiveSlots.get(facet.runtime)!,
      sessionId
    ) ||
    [...facet.settingUp].some((value) => value.sessionId === sessionId)
  )
    return undefined;
  requireOriginalRoomPrincipalService(source, tools.principals);
  if (
    homeOf(resolveAgentHome(agentPath, agentPath)) !== agentPath ||
    facet.meshCore?.getByPath(agentPath)?.id !== target.agentId
  )
    throw new Error('Room responder differs from its approved target.');
  const pending = { retired: false };
  facet.roomPreparing.set(sessionId, pending);
  const settingUp = { sessionId };
  facet.settingUp.add(settingUp);
  let preparedNative: { turn: ActiveTurn; nativeEntry: OpenCodeNativeEntry } | undefined;
  const provider = facet.provider;
  let turnSettled: typeof provider.turnSettled | undefined;
  let providerSettlement: Promise<void> | undefined;
  const settleProvider = (): Promise<void> => {
    providerSettlement ??= Promise.resolve().then(() =>
      turnSettled ? Reflect.apply(turnSettled, provider, []) : undefined
    );
    return providerSettlement;
  };
  try {
    turnSettled = provider.turnSettled;
    const plan = await facet.prepareSidecar(sessionId, settingUp);
    if (pending.retired) throw new Error('Room responder preparation retired.');
    const { ocSessionId, client, directory } = await facet.resolveNativeClient(
      sessionId,
      agentPath,
      undefined,
      pending
    );
    if (pending.retired) throw new Error('Room responder preparation retired.');
    const controller = new AbortController();
    const turn: ActiveTurn = { ocSessionId, cwd: agentPath, controller, phase: 'setup' };
    const { nativeOperation, nativeEntry } = facet.installNativeTurn(
      sessionId,
      directory,
      client,
      turn,
      acquisition,
      true
    );
    preparedNative = { turn, nativeEntry };
    nativeEntry.agentPath = agentPath;
    facet.settingUp.delete(settingUp);
    turn.connectorBinding = await openOriginalNativeTurn(
      tools.principals,
      {
        runtime: facet.type,
        canonicalSessionId: sessionId,
        agentPath,
        canonicalCwd: directory,
        signal: controller.signal,
      },
      nativeOperation
    );
    controller.signal.throwIfAborted();
    const at = Date.now(),
      activity = captureNativeSessionActivity(acquisition, at);
    if (
      !activity ||
      !readNativeSessionAcquisition(acquisition, activity, at, sessionId) ||
      !readOpenCodeNativeOperation(nativeOperation)
    )
      throw new Error('Room responder retired during preparation.');
    let retirement: Promise<void> | undefined;
    const retire = (): Promise<void> => {
      if (retirement) return retirement;
      let resolve!: () => void, reject!: (cause: unknown) => void;
      retirement = new Promise<void>((done, refused) => {
        resolve = done;
        reject = refused;
      });
      const stopRead = facet.custody.openCodeOriginalReadStops.get(turn);
      nativeEntry.retired = true;
      let failed = false,
        firstCause: unknown;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          firstCause = cause;
        }
      };
      try {
        if (facet.activeTurns.get(sessionId) === turn) facet.activeTurns.delete(sessionId);
      } catch (cause) {
        remember(cause);
      }
      try {
        controller.abort();
      } catch (cause) {
        remember(cause);
      }
      let readDrain: Promise<void> | undefined;
      try {
        readDrain = stopRead?.().catch(remember);
      } catch (cause) {
        remember(cause);
      }
      void (async () => {
        try {
          await facet.revokeConnectorTurn(turn, 'turn_cancelled');
        } catch (cause) {
          remember(cause);
        }
        try {
          await readDrain;
        } catch (cause) {
          remember(cause);
        }
        try {
          await settleProvider();
        } catch (cause) {
          remember(cause);
        }
        if (failed) throw firstCause;
      })().then(resolve, reject);
      return retirement;
    };
    const prepared: PreparedRoomResponder = Object.freeze({ kind: 'prepared-room-responder' });
    facet.custody.openCodeRoomPrepared.set(prepared, {
      runtime: facet.runtime,
      retire,
      source,
      nativeOperation,
      acquisition,
      start: (() => {
        let started = false;
        return (committed: OriginalCommittedRoomResponder) => {
          if (started || !readOpenCodePreparedRoomResponder(facet.runtime, prepared))
            throw new Error('Room prepared entry cannot start twice or after retirement.');
          started = true;
          return facet.createMessage(
            sessionId,
            'Document update',
            { cwd: agentPath },
            acquisition,
            undefined,
            {
              prepared,
              committed,
              turn,
              nativeOperation,
              nativeEntry,
              plan,
              client,
              directory,
              retire,
            }
          );
        };
      })(),
    });
    if (facet.roomPreparing.get(sessionId) === pending) facet.roomPreparing.delete(sessionId);
    return prepared;
  } catch (cause) {
    pending.retired = true;
    if (facet.roomPreparing.get(sessionId) === pending) facet.roomPreparing.delete(sessionId);
    facet.settingUp.delete(settingUp);
    if (preparedNative) {
      const { turn, nativeEntry } = preparedNative;
      nativeEntry.retired = true;
      try {
        if (facet.activeTurns.get(sessionId) === turn) facet.activeTurns.delete(sessionId);
      } catch {}
      try {
        turn.controller.abort();
      } catch {}
      try {
        await facet.revokeConnectorTurn(turn, 'setup_failed');
      } catch {}
    }
    try {
      await settleProvider();
    } catch {}
    throw cause;
  }
}
