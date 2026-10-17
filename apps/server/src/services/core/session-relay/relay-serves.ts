/**
 * Which chats the session relay serves (spec `everything-is-a-space` B2): only
 * a person's own chats with a registered agent that is not a system agent.
 * Never a room turn, a scheduled run, a heartbeat beat, a chat bridged from
 * Telegram or Slack, or a conversation an outside sender or another agent
 * started over the message bus, whatever id a request names.
 *
 * Every relayed request that names an agent or a chat asks this module, and
 * nothing else decides it. A chat the relay does not serve is answered exactly
 * like one that does not exist, so a request can never learn that it does.
 *
 * Nothing here is cached: the facts are read fresh for each request, so a
 * change of agents, rooms or pins is never answered from a stale copy.
 *
 * @module services/core/session-relay/relay-serves
 */
import path from 'node:path';
import type { Session } from '@dorkos/shared/types';
import { HEARTBEAT_ORIGIN_LABEL } from '../../heartbeats/beat-chat.js';
import type { TurnOrigin } from '../../session/origin/turn-origin.js';

/** A registered agent, as the relay needs to know it. Never sent to the web side. */
export interface RelayAgent {
  /** Its Mesh id. */
  id: string;
  /** The folder it is registered at. */
  projectPath: string;
  /** Whether it is a system agent (DorkBot), which the relay never serves. */
  isSystem: boolean;
}

/** What the server's own records say about one chat. */
export interface RelaySessionFacts {
  /** The chat's id, as the request named it or the runtime listed it. */
  sessionId: string;
  /**
   * The folder the chat runs in, already judged against the boundary; `null`
   * when the chat exists but cannot be placed inside it, which the relay
   * never serves.
   */
  cwd: string | null;
  /** The agent folder recorded when the chat was first bound, if any. */
  agentPath: string | null;
  /** What started the chat (`TurnOrigin.kind`), as its binding recorded it. */
  launchOrigin: string | null;
  /** The runtime's row for the chat, origin overlays applied; null when it has none yet. */
  row: Session | null;
  /** Whether a room, a scheduled task or a heartbeat owns this chat, by the server's own tables. */
  ownedBy: { room: boolean; task: boolean; beat: boolean };
}

/**
 * Whether a chat that a surface of this kind started is one the relay serves.
 *
 * Exhaustive like `permissionSeedForOrigin`: a new turn origin does not
 * compile until somebody decides whether the owner may reach it from the web.
 *
 * @param kind - The stored launch origin.
 */
export function relayServesLaunchOrigin(kind: TurnOrigin['kind']): boolean {
  switch (kind) {
    // A person's own chat, here or from the web, and the chats that carry one
    // on: one an agent or an extension started for them (spin-offs, outcome
    // buttons), one another chat's message opened, and a carry-over or resume.
    case 'interactive':
    case 'session-relay':
    case 'agent-launch':
    case 'extension-start':
    case 'chat-message':
    case 'account-handoff':
    case 'account-resume':
      return true;
    // An agent's own work nobody typed into (a room turn, a scheduled run, a
    // beat), a chat bridged from off this machine, a conversation another
    // agent or an outside sender started over the bus, a connector event's
    // chat, an extension's own app-data chat, a doc comment's chat, and the
    // test harness.
    case 'room':
    case 'schedule':
    case 'heartbeat':
    case 'relay-binding':
    case 'agent-dm':
    case 'outside-sender':
    case 'connector-event':
    case 'extension-message':
    case 'doc-comment':
    case 'test-harness':
      return false;
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled turn origin: ${String(unhandled)}`);
    }
  }
}

/**
 * Origin kinds this build knows, so a stored string can be narrowed safely. A
 * record, so a new kind does not compile until it is listed here too.
 */
const KNOWN_LAUNCH_ORIGINS: Readonly<Record<TurnOrigin['kind'], true>> = {
  interactive: true,
  'session-relay': true,
  room: true,
  schedule: true,
  'relay-binding': true,
  'agent-dm': true,
  'outside-sender': true,
  'connector-event': true,
  'agent-launch': true,
  'extension-start': true,
  'extension-message': true,
  'chat-message': true,
  'doc-comment': true,
  'account-handoff': true,
  'account-resume': true,
  heartbeat: true,
  'test-harness': true,
};

function isKnownLaunchOrigin(kind: string): kind is TurnOrigin['kind'] {
  return Object.hasOwn(KNOWN_LAUNCH_ORIGINS, kind);
}

/**
 * The agent a folder belongs to: the registered agent whose folder holds it,
 * the most specific one when agents nest. `null` when none does.
 *
 * @param agents - Every registered agent.
 * @param cwd - The folder.
 */
export function agentOwningFolder(agents: readonly RelayAgent[], cwd: string): RelayAgent | null {
  const folder = path.resolve(cwd);
  let best: RelayAgent | null = null;
  for (const agent of agents) {
    const root = path.resolve(agent.projectPath);
    const rel = path.relative(root, folder);
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (inside && (best === null || root.length > path.resolve(best.projectPath).length)) {
      best = agent;
    }
  }
  return best;
}

/**
 * The agent the relay serves this chat for, or `null` when it serves the chat
 * to nobody. The whole rule, in order; every step fails closed:
 *
 * 1. **Not owned by a room, a task or a beat**, by the server's own tables.
 * 2. **A person's chat by its row**, when the runtime has one: origin `user`
 *    (or none, which is how a person's chat is listed), or `agent` for a chat
 *    an agent started for the person, but never one labelled a heartbeat.
 *    `room`, `task`, `channel` (a bridged Telegram or Slack chat) and
 *    `external` (another company's agent, an MCP client) are refused.
 * 3. **A person's chat by what started it**, when the binding recorded that
 *    ({@link relayServesLaunchOrigin}). With no record, the chat must at least
 *    have a row whose origin reads `user` (a chat from the bare `claude` CLI,
 *    which DorkOS never bound, or one bound before origins were recorded).
 * 4. **In a registered agent's folder**, inside the boundary: the most specific agent whose folder
 *    holds the chat's folder. A chat whose recorded agent is a different one
 *    is refused rather than guessed at.
 * 5. **Not a system agent** (DorkBot runs the computer, not the owner's work).
 *
 * @param facts - What the server's records say about the chat.
 * @param agents - Every registered agent, read for this request.
 */
export function relayAgentForSession(
  facts: RelaySessionFacts,
  agents: readonly RelayAgent[]
): RelayAgent | null {
  const { ownedBy, row, launchOrigin } = facts;
  if (ownedBy.room || ownedBy.task || ownedBy.beat) return null;
  if (row) {
    const origin = row.origin ?? 'user';
    if (origin !== 'user' && origin !== 'agent') return null;
    if (row.originLabel === HEARTBEAT_ORIGIN_LABEL) return null;
  }
  if (launchOrigin === null) {
    // No record of what started it: only a chat whose row reads as a
    // person's own. The row's label is a display hint, so `agent` (which an
    // older agent-to-agent chat also reads as) is not enough on its own.
    if (!row || (row.origin ?? 'user') !== 'user') return null;
  } else if (!isKnownLaunchOrigin(launchOrigin) || !relayServesLaunchOrigin(launchOrigin)) {
    return null;
  }
  if (facts.cwd === null) return null;
  const agent = agentOwningFolder(agents, facts.cwd);
  if (!agent || agent.isSystem) return null;
  if (facts.agentPath !== null && path.resolve(facts.agentPath) !== path.resolve(agent.projectPath))
    return null;
  return agent;
}

/**
 * The agent the relay serves, by id, or `null` when there is no such agent or
 * it is a system agent.
 *
 * @param agents - Every registered agent, read for this request.
 * @param agentId - The Mesh id a request named.
 */
export function relayAgentById(agents: readonly RelayAgent[], agentId: string): RelayAgent | null {
  const agent = agents.find((candidate) => candidate.id === agentId);
  return agent && !agent.isSystem ? agent : null;
}
