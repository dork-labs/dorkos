/**
 * The chat list the relay answers `chats.list` with: an agent's chats that
 * the relay serves, newest first, carrying a title, a time and a short
 * preview, and nothing else from this computer (no folder, no runtime).
 *
 * @module services/core/session-relay/relay-chat-list
 */
import {
  RelayChatSummarySchema,
  SESSION_RELAY_MAX_CHATS,
  type RelayChatSummary,
} from '@dorkos/shared/session-relay';
import { relayAgentForSession, type RelayAgent, type RelaySessionFacts } from './relay-serves.js';

/** The longest title or preview a chat summary carries. */
const SUMMARY_TEXT_MAX = 500;

/**
 * The summaries of an agent's chats the relay serves, newest first, at most
 * {@link SESSION_RELAY_MAX_CHATS}.
 *
 * @param listed - The chats in the agent's folder, with their records.
 * @param agent - The agent being listed.
 * @param agents - Every registered agent, read for this request.
 */
export function relayChatSummaries(
  listed: readonly RelaySessionFacts[],
  agent: RelayAgent,
  agents: readonly RelayAgent[]
): RelayChatSummary[] {
  const chats: RelayChatSummary[] = [];
  const served = listed
    .filter((facts) => facts.row && relayAgentForSession(facts, agents)?.id === agent.id)
    .sort((a, b) => Date.parse(b.row!.updatedAt) - Date.parse(a.row!.updatedAt));
  for (const facts of served) {
    if (chats.length >= SESSION_RELAY_MAX_CHATS) break;
    const row = facts.row!;
    const summary = RelayChatSummarySchema.safeParse({
      sessionId: row.id,
      title: clip(row.title, SUMMARY_TEXT_MAX),
      updatedAt: row.updatedAt,
      ...(row.lastMessagePreview
        ? { lastMessagePreview: clip(row.lastMessagePreview, SUMMARY_TEXT_MAX) }
        : {}),
    });
    // A row the protocol cannot carry (an id that is not a lowercase UUID)
    // is left out rather than failing the whole list.
    if (summary.success) chats.push(summary.data);
  }
  return chats;
}

/**
 * Shorten text to at most `max` UTF-16 units, ending with an ellipsis when
 * cut, and never splitting a surrogate pair.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}
