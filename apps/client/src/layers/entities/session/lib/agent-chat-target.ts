/**
 * Where a door to an agent leads: its Direct chat, or for anyone but the owner,
 * its latest chat with them (rule S12, DOR-3074).
 *
 * @module entities/session/lib/agent-chat-target
 */
import { newSessionTarget, toSession, type SessionTarget } from '@/layers/shared/lib';
import { resolveSessionForCwd, type ResolveSessionDeps } from './resolve-session-for-cwd';

/** What {@link agentChatTarget} may be told beyond the agent. */
export interface AgentChatTargetOptions {
  /** The runtime a chat made now should start on, when the caller knows it. */
  runtime?: string;
}

/**
 * The chat a door to an agent opens, as a navigation target.
 *
 * The agent's one standing Direct chat first. Only the owner has Direct chats,
 * so the server refuses anyone else (403), and they still get the agent's latest
 * chat with them, or a fresh one when there is none: the same answer every door
 * gives, so the sidebar row, a card's Message, a profile and ⌘K cannot differ.
 *
 * A Direct chat made just now has no transcript yet, so it opens the way a new
 * chat does; the session route drops the draft flag again for one that exists.
 *
 * @param deps - The query client and transport.
 * @param agentPath - The agent's directory.
 * @param options - See {@link AgentChatTargetOptions}.
 * @returns Where to go, or `null` when the fallback could not find a chat.
 * @throws Whatever the Direct chat request failed with, other than a 403.
 */
export async function agentChatTarget(
  deps: ResolveSessionDeps,
  agentPath: string,
  options: AgentChatTargetOptions = {}
): Promise<SessionTarget | null> {
  const { transport } = deps;
  try {
    const chat = await transport.openDirectChat({ agentPath });
    return await newSessionTarget(transport, {
      session: chat.sessionId,
      dir: agentPath,
      ...(options.runtime && { runtime: options.runtime }),
    });
  } catch (error) {
    if ((error as { status?: number }).status !== 403) throw error;
    const resolved = await resolveSessionForCwd(deps, agentPath);
    if (!resolved) return null;
    if (!resolved.isNew) return toSession({ session: resolved.sessionId });
    return newSessionTarget(transport, { session: resolved.sessionId, dir: agentPath });
  }
}
