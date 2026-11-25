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
 * (`wordsWaitInComposer`) is queued as a row, recorded on its run. Any other
 * run is handed to the dispatcher without one (`wordsAtSource`): never forced
 * at its wait bound, and handed back to the space side when a launch starts
 * no turn (transition 8, its `start_turn` back to `pending`).
 *
 * **Who it runs as.** The lock identity names the run, and a mini app's run
 * keeps the extension's prefix, so its turn carries the outsider mark as a
 * mini app's message always has (DOR-4594).
 *
 * @module services/session/turn-port/computer-turn-port
 */
import type { MeshCore } from '@dorkos/mesh';
import {
  personTyped,
  TurnStartRequestSchema,
  wordsWaitInComposer,
  type RefusalReason,
  type TurnOrigin,
} from '@dorkos/shared/turn-port';
import { EXTENSION_CLIENT_PREFIX } from '../../extensions/agent-send/extension-client-id.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import {
  dispatchSessionMessage,
  isSessionLaunchRefusal,
  type DispatchSessionMessageOpts,
  type DispatchSessionMessageResult,
  type SessionLaunchRefusal,
} from '../launch/launch-session.js';
import { cancelPendingDispatch } from '../message-dispatcher/queue-upkeep.js';
import { launching, pending } from '../message-dispatcher/state.js';
import { queueKeyOf } from '../resolution/session-key-registry.js';
import { isRunHeld, turnFacts } from './facts.js';
import type { ComputerTurnPort } from './computer-face.js';

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

/** The lock identity of a run's turn: the run itself, under the extension prefix for a mini app. */
function clientIdOf(runId: string, origin: TurnOrigin): string {
  const app = origin.kind === 'extension-message' || origin.kind === 'extension-start';
  return `${app ? EXTENSION_CLIENT_PREFIX : 'turn-port:'}${runId}`;
}

/**
 * Build the computer face over this Mac's dispatcher.
 *
 * @param deps - Mesh, the room binding port and, in tests, the launch path.
 */
export function createComputerTurnPort(deps: ComputerTurnPortDeps): ComputerTurnPort {
  const dispatch = deps.dispatch ?? dispatchSessionMessage;
  const holds = (runId: string): boolean =>
    pending.has(runId) || launching.has(runId) || isRunHeld(runId);
  return {
    holds,
    withdraw: (runId) => {
      if (launching.has(runId)) return false;
      if (pending.has(runId)) cancelPendingDispatch(runId);
      return true;
    },
    async start(input) {
      const request = TurnStartRequestSchema.parse(input);
      if (holds(request.runId)) return { refused: 'already_held' };
      const composer = wordsWaitInComposer(request.origin);
      if (!composer) {
        const live = turnFacts()?.dispatcher.liveRunOf(queueKeyOf(request.sessionId));
        if (live !== undefined && live !== request.runId) return { refused: 'chat_busy' };
      }
      if (
        request.prepare ||
        request.systemPromptAppend !== undefined ||
        request.additionalDirectories ||
        request.settings
      ) {
        // Each arrives with the caller that first sets it (rooms, T10).
        throw new Error('This computer face does not take launch options yet');
      }
      let agentPath: string | undefined;
      if (request.agentId !== undefined) {
        agentPath = deps.meshCore()?.getProjectPath(request.agentId);
        if (agentPath === undefined) return { refused: 'invalid_agent_path' };
      }
      // Nothing awaits between admission's cap check and the launch path's own
      // claim of a slot, which it takes before its first await.
      const result = await dispatch({
        sessionId: request.sessionId,
        origin: request.origin,
        runId: request.runId,
        messageId: request.runId,
        ...(composer ? {} : { wordsAtSource: true as const }),
        request: {
          content: request.content,
          cwd: request.cwd,
          ...(agentPath !== undefined ? { agentPath } : {}),
          ...(request.seedContext !== undefined ? { seedContext: request.seedContext } : {}),
          ...(request.accountRef !== undefined ? { account: request.accountRef } : {}),
        },
        clientId: clientIdOf(request.runId, request.origin),
        meshCore: deps.meshCore() as MeshCore | undefined,
        roomSessionPlace: deps.roomSessionPlace(),
        countsTowardLaunchCap: !personTyped(request.origin),
        ...(request.permissionCeiling !== undefined
          ? { permissionCeiling: request.permissionCeiling }
          : {}),
      });
      if (isSessionLaunchRefusal(result)) {
        if (result.refused === 'LAUNCH_CAP_FULL') {
          throw new Error('The launch cap filled between admission and the hand-over');
        }
        return { refused: DOOR_REFUSALS[result.refused] };
      }
      if (!result.accepted) throw new Error('The dispatcher did not take a run it was handed');
      return { accepted: true };
    },
  };
}
