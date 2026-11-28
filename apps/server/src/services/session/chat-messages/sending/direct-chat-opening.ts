/**
 * A new direct chat that waits to open (DOR-5512). Since T6b a chat message
 * that opens a new direct chat can wait for a slot for minutes or hours, so
 * the messages sent to that agent meanwhile join that chat instead of each
 * opening another: one conversation stays one chat.
 *
 * - **Where the answer lives.** In the run record, never in this process: the
 *   chat is not bound yet and a chat message's run still waits to start it (or
 *   its launch is under way). The run and its receipt survive a restart, so a
 *   message sent after one joins the same chat.
 * - **Order.** Each joined message is its own run, as its own sender, and
 *   admission holds it behind the chat's first message until that one starts
 *   (`services/runs/admission.ts`); then it queues behind the running turn as
 *   any message to a busy chat does.
 * - **A chat that never opens.** When the first message is cancelled before it
 *   started, the run record cancels the joined messages with it
 *   (`chat_not_opened`), and {@link attachChatRuns} fails their receipts with
 *   a sentence, so none waits on a chat that is never born.
 *
 * @module services/session/chat-messages/sending/direct-chat-opening
 */
import type { MeshCore } from '@dorkos/mesh';
import type { SpaceTurnPort, TurnRun } from '../../../runs/index.js';
import type { ChatMessageStore } from '../chat-message-store.js';
import { CHAT_MESSAGE_SOURCE, chatMessageWords, type ChatTurnPort } from './chat-turn-hand-over.js';

/** Why the run record cancels a message that joined a chat which never opened (`start-turns.ts`). */
const CHAT_NOT_OPENED = 'chat_not_opened';

/** What a sender is told when the new chat its message joined never opened. */
export const CHAT_NOT_OPENED_REASON =
  'The new chat it was joining never opened, so it was not delivered. Send it again.';

/** A chat message's run that has not started yet, its words not yet a queue row. */
function notStarted(run: TurnRun): boolean {
  return (
    run.origin?.kind === 'chat-message' &&
    run.queueMessageId === null &&
    (run.status === 'queued' || run.status === 'starting')
  );
}

/**
 * The agent a new direct chat opens with, while that chat waits to open: a
 * chat message's run waits to start it. Ask only of a chat that is not bound:
 * a bound chat is open.
 *
 * @param deps - The turn port and Mesh.
 * @param sessionId - The chat, not bound yet.
 * @returns The agent, or `undefined` when no chat message waits to open the chat.
 */
export function openingChatAgent(
  deps: {
    turns?: ChatTurnPort;
    meshCore: () => Pick<MeshCore, 'getProjectPath'> | undefined;
  },
  sessionId: string
): { id: string; path: string } | undefined {
  const opening = deps.turns?.port()?.list(sessionId).find(notStarted);
  const id = opening?.agentId ?? undefined;
  const path = id === undefined ? undefined : deps.meshCore()?.getProjectPath(id);
  return id !== undefined && path !== undefined ? { id, path } : undefined;
}

/**
 * Register chat messaging with a space face: its receipts as the words of its
 * waiting runs, and a watcher that fails the receipt of a message cancelled
 * because the new chat it joined never opened.
 *
 * @param port - The space face.
 * @param deps - The store, and how a sender's windows hear of it.
 * @returns A function that lets go of both.
 */
export function attachChatRuns(
  port: SpaceTurnPort,
  deps: { store: ChatMessageStore; emitActivity: (sessionId: string) => void }
): () => void {
  const unregister = port.registerSource(CHAT_MESSAGE_SOURCE, chatMessageWords(deps.store));
  const unwatch = port.watch((run) => {
    if (run.status !== 'cancelled' || run.endingDetail.cancelledBecause !== CHAT_NOT_OPENED) return;
    for (const row of deps.store.listByQueueMessage(run.id)) {
      if (row.status !== 'queued') continue;
      deps.store.update(row.id, { status: 'failed', failureReason: CHAT_NOT_OPENED_REASON });
      deps.emitActivity(row.fromSessionId);
    }
  });
  return () => {
    unregister();
    unwatch();
  };
}
