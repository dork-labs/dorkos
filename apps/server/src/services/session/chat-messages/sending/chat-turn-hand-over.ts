/**
 * A chat message starts its turn through the turn port (spec
 * `turns-survive-restarts` §3.5, T6b, DOR-5503): the same save, admission and
 * computer face every other caller's run takes, handed over at once because
 * `chat_send` answers its sender straight away.
 *
 * - **Who it runs as.** `askedByRef` names the sending chat, so the computer
 *   face runs the turn under that chat's identity (`chat:<id>`), and with it
 *   the sender's level, its place behind the person's words and its join with
 *   its neighbours. The computer face refuses one that names no sender.
 * - **Where its words wait.** In its own receipt (`chat_messages`), named by
 *   `chat-message:<receipt>` and read back by {@link chatMessageWords}, so a
 *   message that waits for a free slot survives a restart, as the receipt the
 *   old cap hold kept did.
 * - **A new direct chat.** Its birth record (the receipt and reservation the
 *   sender wrote) crosses as plain data, `newDirectChat`.
 * - **A full machine** makes the message wait (`machine_full`) with its place,
 *   where a new chat used to be refused for machine load and a message to an
 *   idle chat was held by the service itself.
 *
 * Chat messaging is space side, but `services/runs` is another domain: the port
 * is handed in at startup ({@link ChatTurnPort}), never imported.
 *
 * @module services/session/chat-messages/sending/chat-turn-hand-over
 */
import type { ChatMessageRow } from '@dorkos/db';
import { dorkReferenceOrNull } from '@dorkos/shared/dork-ref';
import type { StartTurnInput, WaitReason } from '@dorkos/shared/turn-port';
import type { HandOverNowAnswer } from '@dorkos/shared/turn-hand-over';
import type { SpaceTurnPort, TurnRun } from '../../../runs/index.js';
import { CHAT_MESSAGE_ORIGIN } from '../chat-message-ceiling.js';
import { ChatMessageError } from '../chat-message-error.js';
import { renderChatMessage } from '../chat-message-fence.js';
import type { ChatMessageStore } from '../chat-message-store.js';
import type { FreshDmBirth } from './chat-message-birth.js';

/** The source kind a chat message's words are kept under until its turn starts. */
export const CHAT_MESSAGE_SOURCE = 'chat-message';

/** What a sender is told when its message waits for a free slot. */
export const MACHINE_FULL_NOTE =
  'The computer is at its limit for running chats, so this starts when a slot frees.';

/** The turn port, as startup hands it to chat messaging. */
export interface ChatTurnPort {
  /** Save a run and hand it over now (`handOverTurn`); `undefined` before the run record is wired. */
  handOver: (
    input: StartTurnInput,
    opts: { runId: string }
  ) => Promise<HandOverNowAnswer> | undefined;
  /** The space face, for the words' source, a stopped chat's waiting runs and a boot's adoption. */
  port: () => SpaceTurnPort | undefined;
}

/** What became of a chat message handed over. */
export type ChatHandOver =
  | { kind: 'handed'; chatId: string; queued: boolean; queuePosition?: number }
  | { kind: 'waiting'; chatId: string; queuePosition: number; waitReason?: WaitReason };

/** One chat message to start. */
export interface ChatHandOverInput {
  /** The sending chat. */
  fromSessionId: string;
  /** The receipt, whose `queueMessageId` is the run's id. */
  row: Pick<ChatMessageRow, 'id' | 'queueMessageId'>;
  /** The chat it goes to (a new direct chat's id when it opens one). */
  sessionId: string;
  /** The receiving agent, when the message was sent to an agent. */
  agent?: { id: string; path: string };
  /** The chat's folder, when it exists. */
  cwd?: string;
  /** What the receiving agent reads. */
  content: string;
  /** A new direct chat's reservation. */
  birth?: FreshDmBirth;
}

/**
 * What the port is handed for a chat message: its sender, its source and,
 * for a new direct chat, its birth record. Nothing else: no ceiling, mark,
 * launcher or level, as the direct call carried none (the sender's level rides
 * on the receipt, read by the dispatcher through the queue row).
 *
 * @param input - The message.
 * @throws ChatMessageError when the sending chat has no id the port can name.
 */
export function chatTurnInput(input: ChatHandOverInput): StartTurnInput {
  const askedByRef = dorkReferenceOrNull('chat', input.fromSessionId);
  if (!askedByRef) {
    throw new ChatMessageError('UNAVAILABLE', 'DorkOS could not tell which chat sent this.');
  }
  const { birth } = input;
  return {
    sessionId: input.sessionId,
    ...(input.agent ? { agentId: input.agent.id } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    content: input.content,
    origin: CHAT_MESSAGE_ORIGIN,
    tier: 'owner',
    askedByRef,
    sourceRef: `${CHAT_MESSAGE_SOURCE}:${input.row.id}`,
    ...(birth
      ? {
          newDirectChat: {
            receiptId: birth.receiptId,
            fromSessionId: birth.fromSessionId,
            fromAgentPath: birth.fromAgentPath,
            allocationCreatedAt: birth.allocationCreatedAt,
            targetAgent: birth.targetAgent,
          },
        }
      : {}),
  };
}

/**
 * Hand a chat message's turn over now.
 *
 * @param turns - The port, as startup handed it.
 * @param input - The message.
 * @returns Handed (with the dispatcher's receipt) or waiting (with its place).
 * @throws ChatMessageError when the port refused it, or is not wired yet.
 */
export async function handOverChatMessage(
  turns: ChatTurnPort | undefined,
  input: ChatHandOverInput
): Promise<ChatHandOver> {
  const runId = input.row.queueMessageId;
  if (!runId) throw new ChatMessageError('UNAVAILABLE', 'DorkOS could not resolve this chat.');
  let answer: HandOverNowAnswer | undefined;
  try {
    answer = await turns?.handOver(chatTurnInput(input), { runId });
  } catch (err) {
    // The space face refused it before saving anything, with its own sentence.
    if (err instanceof Error && err.name === 'TurnStartRefusedError') {
      throw new ChatMessageError('NOT_ALLOWED', err.message);
    }
    throw err;
  }
  if (!answer) {
    throw new ChatMessageError('UNAVAILABLE', 'DorkOS is still starting. Try again in a moment.');
  }
  if (answer.kind === 'refused') {
    throw new ChatMessageError(
      'NOT_ALLOWED',
      answer.refusal?.message ?? 'The chat could not take the message.'
    );
  }
  if (answer.kind === 'waiting') {
    return {
      kind: 'waiting',
      chatId: input.sessionId,
      queuePosition: answer.queuePosition,
      ...(answer.waitReason ? { waitReason: answer.waitReason } : {}),
    };
  }
  const receipt = answer.receipt;
  return {
    kind: 'handed',
    chatId: receipt?.canonicalId ?? input.sessionId,
    queued: receipt?.queued ?? true,
    ...(receipt ? { queuePosition: receipt.queuePosition } : {}),
  };
}

/**
 * A chat message's words, read back from its receipt for a run that waited:
 * rendered with the sender stamp and fence it was sent with. Only while the
 * receipt still waits; a message failed or taken back hands over nothing.
 *
 * @param store - The chat-message store.
 */
export function chatMessageWords(store: ChatMessageStore): {
  read: (id: string) => string | undefined;
} {
  return {
    read: (id) => {
      const row = store.get(id);
      if (row?.status !== 'queued') return undefined;
      return renderChatMessage(
        {
          messageId: row.id,
          agentName: row.fromAgentName,
          agentId: row.fromAgentId,
          chatId: row.fromSessionId,
          chatTitle: row.fromChatTitle,
        },
        row.kind,
        row.text,
        row.nonce ?? undefined
      ).text;
    },
  };
}

/**
 * Take back the chat messages still waiting for a slot in a chat that was
 * just stopped, as a stop drops the messages other chats queued there: their
 * runs are cancelled, and each receipt fails with the reason. Newest first, so
 * in a new direct chat that waits to open, the messages that joined it are
 * taken back as stopped before its first is (DOR-5512).
 *
 * @param turns - The port.
 * @param store - The chat-message store.
 * @param chatId - The stopped chat.
 * @param reason - What the senders are told.
 * @returns The receipts that failed.
 */
export function withdrawWaitingChatMessages(
  turns: ChatTurnPort | undefined,
  store: ChatMessageStore,
  chatId: string,
  reason: string
): ChatMessageRow[] {
  const port = turns?.port();
  if (!port) return [];
  const failed: ChatMessageRow[] = [];
  for (const run of port.list(chatId).reverse()) {
    if (!waitsWithoutRow(run) || !port.withdraw(run.id, 'stopped')) continue;
    for (const row of store.listByQueueMessage(run.id)) {
      const updated = store.update(row.id, { status: 'failed', failureReason: reason });
      if (updated) failed.push(updated);
    }
  }
  return failed;
}

/** A chat message's run still waiting on the space side, its words not yet a queue row. */
function waitsWithoutRow(run: TurnRun): boolean {
  return (
    run.status === 'queued' && run.queueMessageId === null && run.origin?.kind === 'chat-message'
  );
}
