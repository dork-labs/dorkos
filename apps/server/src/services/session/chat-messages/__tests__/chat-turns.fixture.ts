/**
 * The turn port a chat message starts its turn through (T6b), for tests.
 *
 * - {@link turnsOver}, for the tests that stand in the launch path itself: each
 *   chat message handed over is passed straight to the test's launch double, as
 *   this computer's face passes it (`chat:<sender>` identity, the run id as the
 *   queue row's, a new direct chat's birth record), and its answer read back as
 *   the port's. No run record and no admission: what the port itself gives a
 *   chat message is proven in `runs/__tests__/hand-over-now-chat.test.ts`.
 * - {@link installChatTurns}, the real one: the run record over the test's
 *   database and this computer's face over the real launch path.
 *
 * @module services/session/chat-messages/__tests__/chat-turns.fixture
 */
import { chatClientId } from '@dorkos/shared/chat-client-id';
import { parseDorkReference } from '@dorkos/shared/dork-ref';
import type { HandOverNowAnswer } from '@dorkos/shared/turn-hand-over';
import type {
  DispatchSessionMessageOpts,
  DispatchSessionMessageResult,
} from '../../launch/launch-session.js';
import type { Db } from '@dorkos/db';
import { createComputerTurnPort } from '../../turn-port/computer-turn-port.js';
import {
  handOverTurn,
  installRunRecord,
  turnPort,
  uninstallRunRecord,
} from '../../../runs/index.js';
import type { ChatTurnPort } from '../sending/chat-turn-hand-over.js';

/** The launch path, as a test stands it in. */
export type LaunchDouble = (
  opts: DispatchSessionMessageOpts
) => Promise<DispatchSessionMessageResult>;

/**
 * A turn port that hands every chat message to `launch`.
 *
 * @param launch - The launch double.
 * @param mesh - Mesh, to name a receiving agent's home by its id.
 */
export function turnsOver(
  launch: LaunchDouble,
  mesh?: { getProjectPath: (id: string) => string | undefined }
): ChatTurnPort {
  return {
    port: () => undefined,
    handOver: async (input, { runId }) => {
      const sender = parseDorkReference(input.askedByRef ?? '', 'chat');
      if (!sender.ok) throw new Error('A chat message names the chat that sent it');
      const agentPath = input.agentId ? mesh?.getProjectPath(input.agentId) : undefined;
      const chat = input.newDirectChat;
      const result = await launch({
        origin: input.origin,
        sessionId: input.sessionId,
        messageId: runId,
        runId,
        request: {
          content: input.content,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(agentPath ? { agentPath } : {}),
        },
        clientId: chatClientId(sender.value.id),
        meshCore: undefined,
        roomSessionPlace: undefined,
        ...(chat
          ? {
              freshDmBirth: {
                kind: 'chat-message',
                delivery: 'live-fresh',
                queueMessageId: runId,
                ...chat,
              },
            }
          : {}),
      });
      return answerOf(runId, result);
    },
  };
}

/** The launch double's answer, as the port's. */
function answerOf(runId: string, result: DispatchSessionMessageResult): HandOverNowAnswer {
  if ('refused' in result) {
    if (result.refused === 'LAUNCH_CAP_FULL') {
      return { kind: 'waiting', runId, waitReason: 'machine_full', queuePosition: 1 };
    }
    return {
      kind: 'refused',
      runId,
      reason: 'invalid_agent_path',
      refusal: { code: result.refused, message: result.message },
    };
  }
  if (!result.accepted) throw new Error('The dispatcher did not take a run it was handed');
  return {
    kind: 'handed',
    runId,
    receipt: {
      ...(result.canonicalId !== undefined ? { canonicalId: result.canonicalId } : {}),
      queued: result.queued,
      queuePosition: result.queuePosition,
      outcome: result.outcome,
    },
  };
}

/**
 * Install the run record over `db` and this computer's face over the real
 * launch path, and answer the port as startup hands it to chat messaging.
 *
 * @param db - The test's database.
 * @param mesh - Mesh, to name an agent's home by its id.
 * @returns The port, and how to take it down again.
 */
export function installChatTurns(
  db: Db,
  mesh: { getProjectPath: (id: string) => string | undefined }
): { turns: ChatTurnPort; uninstall: () => void } {
  const computer = createComputerTurnPort({
    meshCore: () => mesh as never,
    roomSessionPlace: () => undefined,
  });
  installRunRecord(db, {
    epoch: '01BOOTEPOCHCHATTURNS000000',
    computer: () => computer,
    agentHome: () => (id) => mesh.getProjectPath(id),
  });
  return { turns: { handOver: handOverTurn, port: turnPort }, uninstall: uninstallRunRecord };
}
