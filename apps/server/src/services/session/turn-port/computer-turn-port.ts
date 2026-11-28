/**
 * The computer face of the turn port on this Mac (spec `turns-survive-restarts`
 * §3.1, §3.3, DOR-5157): a thin layer over `dispatchSessionMessage`, so a run
 * the space face saved takes exactly the path every other message takes, and
 * the dispatcher's own hook writes its moments on the run (§4.7).
 *
 * Only `services/runs` calls it, through the face `turn-port/index.ts` hands out
 * (`computer-face.ts`); startup builds it here and installs it. Its requests
 * are plain data (`TurnStartRequest`); what used to be passed beside a
 * message as live objects is resolved here: the runtime and the projector by
 * the launch path itself, Mesh and the room binding as startup references.
 *
 * **What it answers.** `accepted`, or a refusal from the closed list in
 * `@dorkos/shared/turn-port`:
 *
 * - `already_held` when this computer already holds the run: waiting in the
 *   dispatcher, launching, or running. Nothing is started twice.
 * - `chat_busy` when the run's words stay at their source and a live run
 *   holds its chat. A chat busy with no run behind it (a summary, an open
 *   ask, a delivery the runtime owes) is not refused: the dispatcher parks
 *   the run without a queue row and starts it at that busy state's own wake.
 * - The door's own refusals and `agent_paused`, as `launch-session.ts`
 *   answers them before anything is bound or queued.
 *
 * **Where the words wait.** A run whose words wait in the composer
 * (`wordsWaitInComposer`) is queued as a row, recorded on its run; never a
 * continuation after a restart, whose words are DorkOS's own. Any other
 * run is handed to the dispatcher without one (`wordsAtSource`): never forced
 * at its wait bound, and handed back to the space side when a launch starts
 * no turn (transition 8, its `start_turn` back to `pending`).
 *
 * **Who it runs as.** The lock identity names the run, and a mini app's run
 * keeps the extension's prefix, so its turn carries the outsider mark as a
 * mini app's message always has (DOR-4594). A beat's run takes the
 * heartbeat's prefix, so its turn is recorded as a beat chat's. A message sent
 * from the web keeps the relay's prefix, so it is never read as the owner's
 * own clean send (DOR-4693). A chat message runs as the chat that sent it
 * (`askedByRef`), which is how the dispatcher holds it to that chat's level,
 * keeps it behind the person's words and joins it with its neighbours; one
 * that names no sending chat is refused before anything is queued (T6).
 *
 * **What a waiting caller hears.** `handOver` answers what `start` answers,
 * plus what this Mac's launch path said: the receipt of an accepted run, or
 * the sentence of a refusal. A caller handing its run over now (a spin-off,
 * the web relay) shows those, as it did when it called the launch path itself.
 *
 * @module services/session/turn-port/computer-turn-port
 */
import type { MeshCore } from '@dorkos/mesh';
import {
  isRelayOrigin,
  personTyped,
  TurnStartRequestSchema,
  wordsWaitInComposer,
  type RefusalReason,
  type TurnOrigin,
} from '@dorkos/shared/turn-port';
import { EXTENSION_CLIENT_PREFIX } from '@dorkos/shared/extension-id';
import { chatClientId } from '@dorkos/shared/chat-client-id';
import { parseDorkReference } from '@dorkos/shared/dork-ref';
import { relayClientId } from '../../core/session-relay/relay-client-id.js';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import {
  dispatchSessionMessage,
  isSessionLaunchRefusal,
  type DispatchSessionMessageOpts,
  type DispatchSessionMessageResult,
  type SessionLaunchRefusal,
} from '../launch/launch-session.js';
import { HEARTBEAT_CLIENT_PREFIX } from '../launch/dispatch-options.js';
import { cancelPendingDispatch } from '../message-dispatcher/queue-upkeep.js';
import { cancelQueuedMessage } from '../queued-message-edits.js';
import { launching, pending } from '../message-dispatcher/state.js';
import { queueKeyOf } from '../resolution/session-key-registry.js';
import { isRunHeld, turnFacts } from './facts.js';
import { stopRunTurn } from './run-events.js';
import type { ComputerTurnPort, HandOverResult } from './computer-face.js';

/** What the computer face needs at startup. */
export interface ComputerTurnPortDeps {
  /** Mesh, when it is running: resolves an agent's Mesh id to its home. */
  meshCore: () => Pick<MeshCore, 'getProjectPath' | 'listWithPaths'> | undefined;
  /** The room binding port, read at call time. */
  roomSessionPlace: () => RoomSessionPlacePort | undefined;
  /** The launch path; tests stand in a thinner one. */
  dispatch?: (opts: DispatchSessionMessageOpts) => Promise<DispatchSessionMessageResult>;
}

/** The launch path's refusals, as the port names them. */
const DOOR_REFUSALS: Record<
  Exclude<SessionLaunchRefusal['refused'], 'LAUNCH_CAP_FULL'>,
  RefusalReason
> = {
  INVALID_AGENT_PATH: 'invalid_agent_path',
  UNKNOWN_RUNTIME: 'unknown_runtime',
  ROOM_SESSION_MOVED: 'room_session_moved',
  DESK_NOT_OWN: 'desk_not_own',
  ACCOUNT_NOT_ALLOWED: 'account_not_allowed',
  AGENT_PAUSED: 'agent_paused',
};

/**
 * Hand the run to the launch path, answering a runtime mismatch (the start's
 * runtime is not the one its agent's computer runs) as the refusal it is:
 * asking again cannot change it.
 */
async function dispatchOrRefuse(
  dispatch: (opts: DispatchSessionMessageOpts) => Promise<DispatchSessionMessageResult>,
  opts: DispatchSessionMessageOpts
): Promise<DispatchSessionMessageResult | 'runtime_mismatch'> {
  try {
    return await dispatch(opts);
  } catch (err) {
    if (err instanceof Error && err.message === 'COMPUTER_RUNTIME_MISMATCH') {
      return 'runtime_mismatch';
    }
    throw err;
  }
}

/**
 * The lock identity of a run's turn: the run itself, under the extension
 * prefix for a mini app and the heartbeat prefix for a beat, whose context
 * record names its place by it.
 */
function clientIdOf(runId: string, origin: TurnOrigin, askedByRef: string | undefined): string {
  if (origin.kind === 'extension-message' || origin.kind === 'extension-start') {
    return `${EXTENSION_CLIENT_PREFIX}${runId}`;
  }
  if (origin.kind === 'chat-message') {
    const sender = askedByRef === undefined ? undefined : parseDorkReference(askedByRef, 'chat');
    if (!sender?.ok) throw new Error('A chat message names the chat that sent it');
    return chatClientId(sender.value.id);
  }
  if (origin.kind === 'session-relay') return relayClientId(runId);
  return `${origin.kind === 'heartbeat' ? HEARTBEAT_CLIENT_PREFIX : 'turn-port:'}${runId}`;
}

/**
 * Build the computer face over this Mac's dispatcher.
 *
 * @param deps - Mesh, the room binding port and, in tests, the launch path.
 */
export function createComputerTurnPort(deps: ComputerTurnPortDeps): ComputerTurnPort {
  const dispatch = deps.dispatch ?? dispatchSessionMessage;
  // Hand-overs still inside the launch path (its awaits before the dispatcher
  // has the plan): held as surely as a pending or launching one.
  const inFlight = new Set<string>();
  const holds = (runId: string): boolean =>
    inFlight.has(runId) || pending.has(runId) || launching.has(runId) || isRunHeld(runId);
  async function handOver(input: unknown): Promise<HandOverResult> {
    const request = TurnStartRequestSchema.parse(input);
    if (holds(request.runId)) return { answer: { refused: 'already_held' } };
    // A continuation after a restart (attempt 2 on) carries DorkOS's own
    // words, never a person's: they stay at their source, out of every
    // composer, whatever origin it copied from the turn it picks up (§7.3).
    const composer = wordsWaitInComposer(request.origin) && request.attempt === 1;
    const live = turnFacts()?.dispatcher.liveRunOf(queueKeyOf(request.sessionId));
    const chatBusy = live !== undefined && live !== request.runId;
    if (!composer && chatBusy) return { answer: { refused: 'chat_busy' } };
    if (request.prepare || request.additionalDirectories) {
      // Each arrives with the caller that first sets it (rooms, T10).
      throw new Error('This computer face does not take launch options yet');
    }
    if (request.task && request.origin.kind !== 'schedule') {
      throw new Error('Only a schedule’s run carries a task’s level');
    }
    if (request.relay && !isRelayOrigin(request.origin)) {
      throw new Error('Only a relay delivery’s run carries a relay turn’s level');
    }
    let agentPath: string | undefined;
    if (request.agentId !== undefined) {
      agentPath = deps.meshCore()?.getProjectPath(request.agentId);
      if (agentPath === undefined) return { answer: { refused: 'invalid_agent_path' } };
    }
    const clientId = clientIdOf(request.runId, request.origin, request.askedByRef);
    // Nothing awaits between admission's cap check and the launch path's own
    // claim of a slot, which it takes before its first await.
    inFlight.add(request.runId);
    const result = await dispatchOrRefuse(dispatch, {
      sessionId: request.sessionId,
      origin: request.origin,
      runId: request.runId,
      messageId: request.runId,
      ...(composer ? {} : { wordsAtSource: true as const }),
      request: {
        content: request.content,
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        ...(agentPath !== undefined ? { agentPath } : {}),
        ...(request.seedContext !== undefined ? { seedContext: request.seedContext } : {}),
        ...(request.runtime !== undefined ? { runtime: request.runtime } : {}),
        ...(request.accountRef !== undefined ? { account: request.accountRef } : {}),
      },
      clientId,
      meshCore: deps.meshCore() as MeshCore | undefined,
      roomSessionPlace: deps.roomSessionPlace(),
      ...(request.launcher ? { launcher: request.launcher } : {}),
      // A composer's words into a busy chat add no turn beside the running one.
      countsTowardLaunchCap: !personTyped(request.origin) && !(composer && chatBusy),
      ...(request.permissionCeiling !== undefined
        ? { permissionCeiling: request.permissionCeiling }
        : {}),
      ...(request.unattended ? { unattended: true } : {}),
      ...(request.carriedMarks ? { carriedMarks: request.carriedMarks } : {}),
      turnOptions: {
        ...(request.systemPromptAppend !== undefined
          ? { systemPromptAppend: request.systemPromptAppend }
          : {}),
        ...(request.settings ? { settings: request.settings } : {}),
        ...(request.task
          ? {
              taskTurn: {
                permissionMode: request.task.permissionMode as PermissionModeId,
                ...(request.task.approvedAllow
                  ? { approvedAllow: request.task.approvedAllow }
                  : {}),
              },
            }
          : {}),
        ...(request.relay ? { relayTurn: request.relay } : {}),
      },
    }).finally(() => inFlight.delete(request.runId));
    if (result === 'runtime_mismatch') return { answer: { refused: 'runtime_mismatch' } };
    if (isSessionLaunchRefusal(result)) {
      if (result.refused === 'LAUNCH_CAP_FULL') {
        return { answer: { refused: 'chat_busy' }, capFull: true };
      }
      return {
        answer: { refused: DOOR_REFUSALS[result.refused] },
        refusal: {
          code: result.refused,
          message: result.message,
          ...(result.agentId !== undefined ? { agentId: result.agentId } : {}),
          ...(result.launcherRefused !== undefined
            ? { launcherRefused: result.launcherRefused }
            : {}),
        },
      };
    }
    if (!result.accepted) throw new Error('The dispatcher did not take a run it was handed');
    return {
      answer: { accepted: true },
      receipt: {
        ...(result.canonicalId !== undefined ? { canonicalId: result.canonicalId } : {}),
        queued: result.queued,
        queuePosition: result.queuePosition,
        outcome: result.outcome,
        ...(result.warnings ? { warnings: result.warnings } : {}),
      },
    };
  }
  return {
    holds,
    withdraw: (runId) => {
      if (inFlight.has(runId) || launching.has(runId)) return false;
      if (pending.has(runId)) cancelPendingDispatch(runId);
      return true;
    },
    removeQueued: (sessionId, runId) => cancelQueuedMessage(sessionId, runId) !== undefined,
    async stop(runId) {
      // Only this run's own turn: the queue and any other run are left alone (§3.6).
      return stopRunTurn(runId);
    },
    async start(input) {
      const handed = await handOver(input);
      // The worker's hand-over retries with its backoff, as it always has.
      if (handed.capFull)
        throw new Error('The launch cap filled between admission and the hand-over');
      return handed.answer;
    },
    handOver,
  };
}
