/**
 * Chat messages an earlier version held for a launch slot (DOR-3375): a
 * `chat_messages` row at `queued` with no queue row, a state nothing else
 * writes. Since T6b (DOR-5503) a message that waits for a slot waits as a run on
 * the turn port, so nothing new is held this way. A row an earlier version
 * left is started through the port once, at boot, under a new queue row id:
 * the outbox's worker hands it over when the computer is ready, and it waits
 * for a slot there like any other. One whose chat it may no longer reach fails
 * with the reason, as it would have when offered again.
 *
 * @module services/session/chat-messages/chat-held-adoption
 */
import { ulid } from 'ulidx';
import type { ChatMessageRow } from '@dorkos/db';
import { logError, logger } from '../../../lib/logger.js';
import { ChatMessageError } from './chat-message-error.js';
import { renderChatMessage } from './chat-message-fence.js';
import type { ChatMessageStore } from './chat-message-store.js';
import { resolveChatTarget, type ChatTargetDeps } from './chat-target.js';
import { chatTurnInput, type ChatTurnPort } from './sending/chat-turn-hand-over.js';

/** What adopting held messages needs. */
export interface HeldAdoptionDeps extends ChatTargetDeps {
  /** The store. */
  store: ChatMessageStore;
  /** The turn port, as startup handed it. */
  turns?: ChatTurnPort;
  /** The folder a chat runs in, when known. */
  sessionCwd: (sessionId: string) => Promise<string | undefined>;
  /** Tell a chat's windows its messaging changed. */
  emitActivity: (sessionId: string) => void;
}

/**
 * Start every message an earlier version held through the turn port, oldest
 * first. Does nothing before the run record is wired.
 *
 * @param deps - What it needs.
 */
export async function adoptHeldChatMessages(deps: HeldAdoptionDeps): Promise<void> {
  const port = deps.turns?.port();
  if (!port) return;
  for (const row of deps.store.listHeldForSlot()) {
    try {
      await adopt(deps, port, row);
    } catch (err) {
      const known = err instanceof ChatMessageError;
      if (!known) logger.warn('[chat_send] a held message failed', logError(err));
      deps.store.update(row.id, {
        status: 'failed',
        failureReason: known ? err.message : 'DorkOS could not send the message.',
      });
      deps.emitActivity(row.fromSessionId);
    }
  }
}

async function adopt(
  deps: HeldAdoptionDeps,
  port: NonNullable<ReturnType<ChatTurnPort['port']>>,
  row: ChatMessageRow
): Promise<void> {
  const caller = { sessionId: row.fromSessionId, agentPath: row.fromAgentPath };
  // A held report keeps a report's reach, or one into a room's old chat would fail here (DOR-3753).
  const kind = row.kind === 'report' ? 'report' : 'message';
  const target = await resolveChatTarget(deps, caller, row.toSessionId, undefined, kind);
  const sessionId = target.sessionId ?? row.toSessionId;
  const runId = ulid();
  const held = deps.store.update(row.id, { queueMessageId: runId }) ?? row;
  const cwd = await deps.sessionCwd(sessionId);
  const content = renderChatMessage(
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
  port.start(
    chatTurnInput({
      fromSessionId: row.fromSessionId,
      row: held,
      sessionId,
      ...(target.agent ? { agent: target.agent } : {}),
      ...(cwd ? { cwd } : {}),
      content,
    }),
    { runId }
  );
}
