/**
 * Where a `chat_send` goes, and which chats a chat may write into or stop
 * (spec `spin-off-chats` §4).
 *
 * `to` is tried as a Mesh agent id first: the message goes to the DM chat the
 * sending agent keeps with that agent. Otherwise it is a chat id, which must be
 * one this server bound and one a chat may write into
 * ({@link CHAT_SENDABLE_ORIGINS}). One exception: an answer to a message a
 * scheduled run or a beat sent ({@link CHAT_UNATTENDED_ORIGINS}) goes to the
 * asking agent's DM chat, since nothing may be written into the run itself.
 *
 * @module services/session/chat-messages/chat-target
 */
import type { MeshCore } from '@dorkos/mesh';
import type { SessionFacts } from '../../extensions/agent-send/agent-send-defaults.js';
import { ChatMessageError } from './chat-message-error.js';
import type { ChatCaller } from './chat-message-service.js';
import type { ChatMessageStore } from './chat-message-store.js';

/**
 * The launch origins of chats another chat may write into or stop: a person's
 * own chat, one an agent or an extension started, one a chat message opened,
 * and a carry-over or resume of one.
 *
 * Deny by default, as `ctx.agent.send` is. Left out on purpose: a room's
 * conversation (agents speak in rooms with `post_to_room`), a chat bridged
 * from Telegram or Slack (its replies go to people off this machine), a relay
 * DM, a connector event's chat, a schedule's run, a beat, and the test
 * harness. `null` is not in it: a chat bound before the column existed could
 * be any of those.
 */
export const CHAT_SENDABLE_ORIGINS: ReadonlySet<string> = new Set([
  'interactive',
  'agent-launch',
  'chat-message',
  'extension-start',
  'extension-message',
  'account-handoff',
  'account-resume',
]);

/**
 * The origins of a chat an agent runs on its own, with nobody watching: a
 * scheduled run and a heartbeat beat. Nothing may be written into one, but a
 * question one of them asked is still answered: the answer goes to the asking
 * agent's DM chat with the one answering, where that agent will see it.
 */
export const CHAT_UNATTENDED_ORIGINS: ReadonlySet<string> = new Set(['schedule', 'heartbeat']);

/** Where a send is going, once resolved. */
export interface ChatTarget {
  /** The chat, or null when an agent's DM chat is not open yet. */
  sessionId: string | null;
  /** Set when the target is an agent. */
  agent?: { id: string; path: string };
  /** The id a new DM chat is opened under, minted before the send. */
  newSessionId?: string;
  /**
   * Set when the send answers a message from a scheduled run or a beat, so it
   * goes to the asking agent's DM chat instead: the message it answers.
   */
  redirectedReplyTo?: string;
}

/** What resolving a target reads. */
export interface ChatTargetDeps {
  /** The store. */
  store: ChatMessageStore;
  /** Mesh, when running. */
  meshCore: () => Pick<MeshCore, 'get' | 'getProjectPath'> | undefined;
  /** What DorkOS knows about a chat. */
  describeSession: (sessionId: string) => Promise<SessionFacts>;
  /** The id a chat is known by now, whichever id it was named by. */
  canonicalId: (sessionId: string) => Promise<string>;
}

/**
 * Where a send is going, or the refusal that says why it cannot go.
 *
 * @param deps - What it reads.
 * @param caller - The calling chat.
 * @param to - A chat id or an agent id.
 * @param replyTo - The message the send answers, when named.
 * @throws ChatMessageError when the target cannot take the message.
 */
export async function resolveChatTarget(
  deps: ChatTargetDeps,
  caller: ChatCaller,
  to: string,
  replyTo: string | undefined
): Promise<ChatTarget> {
  const mesh = deps.meshCore();
  const agentPath = mesh?.get(to) ? mesh.getProjectPath(to) : undefined;
  if (agentPath) return agentTarget(deps, caller, { id: to, path: agentPath });
  if (to === caller.sessionId || (await sameChat(deps, to, caller.sessionId))) {
    throw new ChatMessageError(
      'SELF',
      'That is your own chat. Send to another chat or agent, or just keep working.'
    );
  }
  try {
    await assertChatSendable(deps, to, mesh !== undefined);
  } catch (err) {
    const redirected = await unattendedReplyTarget(deps, caller, to, replyTo);
    if (redirected) return redirected;
    throw err;
  }
  return { sessionId: to };
}

/** The DM chat the calling agent keeps with an agent, or a new one. */
async function agentTarget(
  deps: ChatTargetDeps,
  caller: ChatCaller,
  agent: { id: string; path: string }
): Promise<ChatTarget> {
  const kept = deps.store.dmChat(caller.agentPath, agent.id);
  if (kept && kept !== caller.sessionId) {
    const facts = await deps.describeSession(kept);
    if (facts.bound && facts.agentPath === agent.path && !facts.roomBound) {
      return { sessionId: kept, agent };
    }
  }
  return { sessionId: null, agent };
}

/**
 * Where an answer to a scheduled run or a beat goes: the asking agent's DM
 * chat with the one answering, which a send to that agent's id reaches anyway,
 * so nothing new becomes reachable. Only an answer: the message named by
 * `replyTo`, else the newest unanswered one, must have come from that chat to
 * this one. Null when this is not such an answer.
 */
async function unattendedReplyTarget(
  deps: ChatTargetDeps,
  caller: ChatCaller,
  to: string,
  replyTo: string | undefined
): Promise<ChatTarget | null> {
  const facts = await deps.describeSession(to);
  if (!facts.bound || facts.roomBound || !CHAT_UNATTENDED_ORIGINS.has(facts.launchOrigin ?? '')) {
    return null;
  }
  const asked =
    replyTo !== undefined
      ? deps.store.get(replyTo)
      : deps.store.latestUnanswered(to, caller.sessionId);
  if (!asked || asked.fromSessionId !== to || asked.toSessionId !== caller.sessionId) return null;
  const agentPath = asked.fromAgentId
    ? deps.meshCore()?.getProjectPath(asked.fromAgentId)
    : undefined;
  if (!asked.fromAgentId || !agentPath || agentPath !== asked.fromAgentPath) return null;
  const target = await agentTarget(deps, caller, { id: asked.fromAgentId, path: agentPath });
  return { ...target, redirectedReplyTo: asked.id };
}

/**
 * Refuse a chat id a chat may not write into or stop.
 *
 * @param deps - What it reads.
 * @param sessionId - The chat.
 * @param meshUp - Whether Mesh is running, so an unknown id is not just early.
 * @throws ChatMessageError when the chat cannot take messages.
 */
export async function assertChatSendable(
  deps: Pick<ChatTargetDeps, 'describeSession'>,
  sessionId: string,
  meshUp: boolean
): Promise<SessionFacts> {
  const facts = await deps.describeSession(sessionId);
  if (!facts.bound) {
    if (!meshUp) {
      throw new ChatMessageError('UNAVAILABLE', 'Agents aren’t loaded yet. Try again in a moment.');
    }
    throw new ChatMessageError('NOT_FOUND', 'There is no agent or chat with that id here.');
  }
  if (
    facts.roomBound ||
    facts.launchOrigin === null ||
    !CHAT_SENDABLE_ORIGINS.has(facts.launchOrigin)
  ) {
    throw new ChatMessageError(
      'NOT_ALLOWED',
      'That chat belongs to a room, a Telegram or Slack chat, or a scheduled run. Post in the ' +
        'room with post_to_room instead, send to the agent’s id, or pick another chat. To ' +
        'answer a scheduled run’s message, pass its id as replyTo.'
    );
  }
  return facts;
}

/**
 * Whether two ids name the same chat (a request id and its canonical one).
 *
 * @param deps - What it reads.
 * @param a - One id.
 * @param b - The other.
 */
export async function sameChat(
  deps: Pick<ChatTargetDeps, 'canonicalId'>,
  a: string,
  b: string
): Promise<boolean> {
  const [ca, cb] = await Promise.all([
    deps.canonicalId(a).catch(() => a),
    deps.canonicalId(b).catch(() => b),
  ]);
  return ca === cb;
}
