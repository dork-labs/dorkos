/**
 * The `<relay_context>` block a relay turn's prompt opens with: who sent the
 * message, where it is going and what budget it has left, above the sender's
 * defused words. Its own module so the agent handler stays under its size limit.
 *
 * @module relay/adapters/claude-code/relay-context-block
 */
import {
  A2A_CLIENT_NAME,
  A2A_GATEWAY_SENDER,
  type RelayEnvelope,
} from '@dorkos/shared/relay-schemas';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import { defuseSystemTags } from '@dorkos/shared/untrusted-text';
import { extractSenderIdentity } from '../../lib/payload-utils.js';
import { isTurnShapingSender } from './turn-shaping-sender.js';

/**
 * Tags that mean something to a runtime and must not be forgeable by a stranger
 * on Telegram or Slack.
 *
 * Driven off the shared {@link CONTEXT_TAG} map plus `system-reminder`, exactly
 * as the rooms preamble does, so a new context kind is covered here the day it
 * is added rather than the day somebody remembers this list exists.
 */
const SYSTEM_TAGS = [...Object.values(CONTEXT_TAG), 'system-reminder'];

/** Who the `Sender:` and `Chat:` lines name: a chat bridge's own fields, or A2A's constant. */
function senderLinesOf(envelope: RelayEnvelope): { sender?: string; chat?: string } {
  if (envelope.from === A2A_GATEWAY_SENDER) return { sender: A2A_CLIENT_NAME };
  // Only a chat bridge names who is talking (DOR-5201): any other sender's
  // payload could put someone else's name on the Sender line.
  return isTurnShapingSender(envelope.from) ? extractSenderIdentity(envelope.payload) : {};
}

/**
 * Format the user prompt with a <relay_context> XML block.
 *
 * When the envelope's payload carries a sender name and/or chat title
 * (Telegram/Slack inbound), a `Sender:`/`Chat:` line is inserted right after
 * `From:` so the agent knows who it is talking to. Only a sender that may shape
 * the turn ({@link isTurnShapingSender}) names them; an A2A turn always reads
 * `Sender: a2a-client`. Absent either field, the block is byte-identical to the
 * plain envelope-metadata format.
 *
 * ## The message body is somebody else's words
 *
 * Everything after the block is written by whoever sent the message, and a
 * chat platform will happily carry `</relay_context>` or `<system-reminder>` in
 * a message. Written straight through, those close the block early and let a
 * stranger add lines the agent reads as DorkOS's own instructions. The body is
 * therefore run through {@link defuseSystemTags}, which escapes the opening `<`
 * of a system tag and leaves ordinary prose and code (`Vec<T>`, `a < b`,
 * `<div>`) exactly as written — people paste code into chat, and mangling it
 * would be a real cost. The identity lines are a different job and were already
 * handled: {@link extractSenderIdentity} runs `sanitizeIdentity` over them.
 *
 * ## Known residual: no nonce fence here
 *
 * The strongest form of this boundary is a per-turn nonce fence — markers a
 * writer cannot predict, which is what makes the boundary unforgeable rather
 * than merely hard to spell. Rooms have one; relay does not, because the fence
 * helper currently lives in the server's runtime layer
 * (`services/runtimes/shared/room-context-block.ts`) and is not importable from
 * this package. Defusal is the whole boundary here rather than defence in
 * depth, so this is a real gap, narrowed but not closed. Extracting the fence
 * into `@dorkos/shared` so both callers share it is filed as follow-up.
 *
 * @param content - The message's words.
 * @param envelope - The envelope, for its metadata and the sender's display fields.
 * @param agentId - The agent the subject names.
 * @param sdkSessionId - The key the turn runs under.
 * @param now - The turn's clock.
 */
export function formatPromptWithContext(
  content: string,
  envelope: RelayEnvelope,
  agentId: string,
  sdkSessionId: string,
  now: () => number
): string {
  const { sender, chat } = senderLinesOf(envelope);
  const lines = [
    `Agent-ID: ${agentId}`,
    `Session-ID: ${sdkSessionId}`,
    `From: ${envelope.from}`,
    ...(sender !== undefined ? [`Sender: ${sender}`] : []),
    ...(chat !== undefined ? [`Chat: ${chat}`] : []),
    `Message-ID: ${envelope.id}`,
    `Subject: ${envelope.subject}`,
    `Sent: ${envelope.createdAt}`,
    '',
    'Budget remaining:',
    `- Hops: ${envelope.budget.hopCount} of ${envelope.budget.maxHops} used`,
    `- TTL: ${Math.max(0, Math.round((envelope.budget.ttl - now()) / 1000))} seconds remaining`,
    `- Max turns: ${envelope.budget.callBudgetRemaining}`,
  ];
  if (envelope.replyTo) {
    lines.push(
      '',
      `Reply to: ${envelope.replyTo}`,
      "If you cannot complete the task within the budget, summarize what you've done and stop."
    );
  }
  return (
    `<${CONTEXT_TAG.relay_context}>\n${lines.join('\n')}\n</${CONTEXT_TAG.relay_context}>\n\n` +
    defuseSystemTags(content, SYSTEM_TAGS)
  );
}
