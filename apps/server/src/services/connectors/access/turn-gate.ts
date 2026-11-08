/**
 * Whether the calling turn may change ANOTHER agent's access (spec
 * `agent-grant-autonomy` §4.1, Security terms N1 and E2).
 *
 * Refused when the turn is marked as having read words DorkOS can't vouch for,
 * when another agent's message started it (or joined it, or a teammate's room
 * post woke it), and whenever DorkOS can't tell either: no session, no recorded
 * turn, or a start it doesn't know. An agent's own grants never pass through
 * here; narrowing those is always allowed.
 *
 * This proves only what DorkOS already marks. A read through a tool or a
 * connected app (an email, a web page) does not mark a turn until DOR-3969, so
 * nothing here, and no text built on it, may claim to catch that (§4.4).
 *
 * @module services/connectors/access/turn-gate
 */
import { marksOf, lastTurnLevelOf } from '../../core/turn-power/turn-levels.js';
import { roomTurnReadOutsideWords } from '../../core/turn-power/outside-words.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import {
  chatTurnSendersOf,
  isChatStartedTurn,
  steeredTurnSendersOf,
} from '../../session/chat-messages/chat-started-turns.js';

/** Refusal codes the gate answers with. */
export type TurnGateRefusal =
  'GRANT_MARKS_UNREADABLE' | 'GRANT_MARKED_TURN' | 'GRANT_AGENT_STARTED';

/** The words each refusal gives the agent (§7). */
export const TURN_GATE_MESSAGES: Record<TurnGateRefusal, string> = {
  GRANT_MARKS_UNREADABLE:
    "DorkOS can't tell who started this turn or what it read, so it can't change another agent's access. Ask a person.",
  GRANT_MARKED_TURN:
    "This turn read words DorkOS can't vouch for, so it can't change another agent's access. Ask a person.",
  GRANT_AGENT_STARTED:
    "Another agent's message started this turn, so it can't change another agent's access. Ask a person.",
};

/** Starts a person (or the agent's own beat) makes; anything else is refused. */
const PERSON_STARTS: ReadonlySet<string> = new Set([
  'interactive',
  'room',
  'session-relay',
  'heartbeat',
  'account-handoff',
  'account-resume',
]);

/** Starts that carry an outsider's words. */
const OUTSIDE_STARTS: ReadonlySet<string> = new Set([
  'relay-binding',
  'outside-sender',
  'connector-event',
]);

/** Starts another agent (or an extension acting for one) makes. */
const AGENT_STARTS: ReadonlySet<string> = new Set([
  'agent-dm',
  'agent-launch',
  'chat-message',
  'extension-start',
  'extension-message',
]);

/** Where the gate reads the turn. Injected so each refusal can be tested on its own. */
export interface TurnGateSources {
  /** Whether this process recorded a turn on the session. */
  hasTurnRecord: (sessionId: string) => boolean;
  /** Whether the turn is marked as having read words DorkOS can't vouch for. */
  marked: (sessionId: string, agentPath: string | undefined) => boolean;
  /** The chats whose messages or posts started, joined or woke the turn. */
  agentSenders: (sessionId: string) => readonly string[];
  /** How the session was started, or `null` when DorkOS has no record. */
  launchOrigin: (sessionId: string) => string | null;
}

/** The live sources. */
export const LIVE_TURN_GATE_SOURCES: TurnGateSources = {
  hasTurnRecord: (sessionId) => lastTurnLevelOf(sessionId) !== undefined,
  marked: (sessionId, agentPath) =>
    marksOf(sessionId, agentPath).outsider === true || roomTurnReadOutsideWords(sessionId),
  agentSenders: (sessionId) => [
    ...chatTurnSendersOf(sessionId),
    ...steeredTurnSendersOf(sessionId),
    ...(isChatStartedTurn(sessionId) ? ['chat-started'] : []),
  ],
  launchOrigin: (sessionId) => runtimeRegistry.getSessionLaunchOrigin(sessionId),
};

/**
 * Decide whether the calling turn may change another agent's access. Any
 * source that throws counts as unreadable.
 *
 * @param caller - The calling session and agent, from the verified principal.
 * @param sources - Where to read the turn; the live ones by default.
 * @returns `null` when allowed, or the refusal code.
 */
export function anotherAgentTurnRefusal(
  caller: { readonly sessionId?: string; readonly agentPath?: string },
  sources: TurnGateSources = LIVE_TURN_GATE_SOURCES
): TurnGateRefusal | null {
  const { sessionId } = caller;
  if (!sessionId) return 'GRANT_MARKS_UNREADABLE';
  try {
    if (!sources.hasTurnRecord(sessionId)) return 'GRANT_MARKS_UNREADABLE';
    if (sources.marked(sessionId, caller.agentPath)) return 'GRANT_MARKED_TURN';
    const origin = sources.launchOrigin(sessionId);
    if (origin !== null && OUTSIDE_STARTS.has(origin)) return 'GRANT_MARKED_TURN';
    if (sources.agentSenders(sessionId).length > 0) return 'GRANT_AGENT_STARTED';
    if (origin !== null && AGENT_STARTS.has(origin)) return 'GRANT_AGENT_STARTED';
    if (origin === null || !PERSON_STARTS.has(origin)) return 'GRANT_MARKS_UNREADABLE';
    return null;
  } catch {
    return 'GRANT_MARKS_UNREADABLE';
  }
}
