/**
 * Whether DorkOS asks a person before an agent acts, for each prompt kind in the registry
 * (`@dorkos/shared/prompts/prompt-kinds`). One function, {@link shouldAsk}, decides every kind,
 * so a kind's rule lives in one place and its Activity line is written the same way each time.
 *
 * ## `connector.write.marked-same-source` (DOR-4794, Security's threat read of 2026-11-19)
 *
 * Every read through a connected app marks its turn (DOR-3969), and a marked turn asks before a
 * connected-app write. So an agent that reads a tracker and then updates it asked every time. A
 * turn whose ONLY outside words came from app C cannot carry anyone's words anywhere new by
 * writing back to C: they are already there. So such a write is allowed with no card when all of
 * these hold, and asks otherwise:
 *
 * - the action is `connectors.execute_write`, and the preflight read it as `write` class (never
 *   `destructive`, never a read whose tier was raised);
 * - C is an app on `WRITES_BACK_TOOLKITS` (Linear today), whose writes stay in the team's own
 *   workspace: checked here as well as where the switch is read, so a send never qualifies;
 * - the person turned the kind's switch on for C (`writes-back-store.ts`), which no agent can do;
 * - every turn the call names (its session, and the runtime principal's turn) is either unmarked
 *   or has every outsider mark explained by a recorded read of C: it started clean, it carries no
 *   room-turn note, its level is its own, and every source its reads recorded is C. A mark no read
 *   explains (one carried from another conversation, or a read that named no source) is recorded
 *   as an unknown source, so it asks (Security's ruling, Nov 19).
 *
 * ### Fails closed
 *
 * Sources live in memory beside the read record only (`live-outsider-turns.ts`). A mark a turn
 * started with (a carried mark, a continuation, a Wi-Fi hold, a stranger's message) has no
 * source, so the turn does not count as started clean, and asks. A restart forgets every source,
 * and a caller that names no turn (an external `/mcp` client) never qualifies. Sends elsewhere,
 * the destructive cancel window, the spend ask and every raise are untouched.
 *
 * @module services/core/prompts/should-ask
 */
import {
  PROMPT_KINDS,
  type PromptDecision,
  type PromptKindKey,
} from '@dorkos/shared/prompts/prompt-kinds';
import { sessionPath } from '@dorkos/shared/session-link';
import type { ActivityService } from '../../activity/activity-service.js';
import { primaryOf } from '../../session/resolution/session-key-registry.js';
import { readSourcesOf } from '../turn-power/live-outsider-turns.js';
import { roomTurnReadOutsideWords } from '../turn-power/outside-words.js';
import { turnReadOutsideWords } from '../turn-power/outsider-turn.js';
import { lastTurnLevelOf } from '../turn-power/turn-levels.js';
import { turnStart } from '../turn-power/turn-start-marks.js';
import type { ConnectorGateFacts } from './connector-gate-facts.js';
import { writesBackSupported } from './writes-back-toolkits.js';

export type { ConnectorGateFacts } from './connector-gate-facts.js';

/** The one action a same-source write can be. */
export const SAME_SOURCE_WRITE_ACTION = 'connectors.execute_write';

/** The call a same-source write is decided on, as the permission gate holds it. */
export interface SameSourceWriteFacts extends ConnectorGateFacts {
  /** The action, by id. */
  action: { id: string };
  /** The calling agent's verified identity, if any. */
  identity?: { agentPath: string; displayName?: string };
  /** The calling session, when the surface verified one. */
  sessionId?: string;
  /** The turn a turn-bound runtime principal names, when the surface verified one. */
  principalTurn?: { sessionId: string; agentPath: string };
}

/** What each prompt kind is decided on. */
export interface PromptKindFacts {
  /** A connected-app write in a marked turn. */
  'connector.write.marked-same-source': SameSourceWriteFacts;
}

/** Why a kind answered as it did, for logs and tests; never shown to a person. */
export type ShouldAskWhy =
  | 'unknown-kind'
  | 'not-this-kind'
  | 'not-write-class'
  | 'unsupported-app'
  | 'switch-off'
  | 'no-verified-turn'
  | 'marked-by-something-else'
  | 'not-marked'
  | 'only-this-app';

/** A kind's answer for one call. */
export interface ShouldAskAnswer {
  /** Ask a person, go ahead without asking, or refuse. */
  readonly decision: PromptDecision;
  /** Why. */
  readonly why: ShouldAskWhy;
}

/**
 * Whether DorkOS asks a person before this call, for one prompt kind. An `allow` writes the
 * kind's Activity line (`auditKind`), since no card was shown. Call it only where the kind's card
 * would otherwise be shown. A key the registry doesn't hold asks: fails closed.
 *
 * @param kind - The prompt kind.
 * @param facts - What the call is decided on, from what the server verified.
 * @returns The decision, and why.
 */
export function shouldAsk<K extends PromptKindKey>(
  kind: K,
  facts: PromptKindFacts[K]
): ShouldAskAnswer {
  if (!Object.prototype.hasOwnProperty.call(PROMPT_KINDS, kind) || !isSameSourceKind(kind)) {
    return { decision: 'ask', why: 'unknown-kind' };
  }
  const why = sameSourceWhy(facts);
  // The gate calls this only where its card would show, so a call whose named turns are all clean
  // means the gate was marked through something it can't name (the agent's other running turns):
  // `not-marked` keeps the kind's default with the rest (Security, DOR-4794 Should 1).
  if (why !== 'only-this-app') return { decision: PROMPT_KINDS[kind].default, why };
  recordAllowed(kind, facts);
  return { decision: 'allow', why };
}

/** Whether a key is the same-source kind, the only one this module decides today. */
function isSameSourceKind(kind: string): kind is 'connector.write.marked-same-source' {
  return kind === 'connector.write.marked-same-source';
}

/** Why a same-source write is allowed, or what keeps it asking. */
function sameSourceWhy(facts: SameSourceWriteFacts): ShouldAskWhy {
  const same = facts.sameSource;
  if (facts.action.id !== SAME_SOURCE_WRITE_ACTION) return 'not-this-kind';
  if (same?.classification !== 'write') return 'not-write-class';
  // The app list again, whatever the switch fact says: an app whose writes are sends always asks.
  if (!writesBackSupported(same.toolkit)) return 'unsupported-app';
  if (same.writesBackUnasked !== true) return 'switch-off';
  const turns = [
    ...(facts.sessionId
      ? [{ sessionId: facts.sessionId, agentPath: facts.identity?.agentPath }]
      : []),
    ...(facts.principalTurn ? [facts.principalTurn] : []),
  ];
  if (turns.length === 0) return 'no-verified-turn';
  if (!turns.some((turn) => turnReadOutsideWords(turn.sessionId, turn.agentPath))) {
    return 'not-marked';
  }
  const explained = turns.every(
    (turn) =>
      !turnReadOutsideWords(turn.sessionId, turn.agentPath) ||
      everyMarkFrom(turn.sessionId, same.connectionId)
  );
  return explained ? 'only-this-app' : 'marked-by-something-else';
}

/**
 * Whether every outsider mark on one turn is explained by a recorded read of connection C: it
 * started clean in this process (no carried mark, continuation or hold), its level is its own (not
 * read from the agent's other running turns), its latest room turn added no outside-words note,
 * and every source its reads recorded is C. An unsourced mark records an unknown source, so it
 * fails the last check. A turn with no read record does not qualify either.
 */
function everyMarkFrom(sessionId: string, connectionId: string): boolean {
  if (lastTurnLevelOf(sessionId) === undefined) return false;
  if (turnStart(sessionId) !== 'clean') return false;
  if (roomTurnReadOutsideWords(sessionId)) return false;
  const sources = readSourcesOf(primaryOf(sessionId));
  return (
    sources.length > 0 &&
    sources.every((source) => source.kind === 'connector' && source.connectionId === connectionId)
  );
}

/** Where the Activity line goes; wired at boot. */
let activity: Pick<ActivityService, 'emit'> | undefined;

/**
 * Wire the Activity trail an `allow` writes its line to. Called once at boot; `undefined` in tests.
 *
 * @param next - The Activity service, or `undefined` to drop it.
 */
export function setShouldAskActivity(next: Pick<ActivityService, 'emit'> | undefined): void {
  activity = next;
}

/** The one Activity line for a call a kind let through. Never throws, never names arguments. */
function recordAllowed(kind: PromptKindKey, facts: SameSourceWriteFacts): void {
  if (!activity) return;
  const who = facts.identity?.displayName ?? 'An agent';
  const chat = facts.sessionId ?? facts.principalTurn?.sessionId;
  const agentPath = facts.identity?.agentPath ?? facts.principalTurn?.agentPath;
  const connectionId = facts.sameSource?.connectionId;
  void activity.emit({
    actorType: 'agent',
    ...(agentPath ? { actorId: agentPath } : {}),
    actorLabel: who,
    category: 'agent',
    eventType: PROMPT_KINDS[kind].auditKind,
    resourceType: 'connection',
    ...(connectionId ? { resourceId: connectionId } : {}),
    resourceLabel: 'Change something in a connected app',
    summary:
      `${who} changed something in a connected app without asking: this turn read only that ` +
      'app, and you let agents write back to it',
    ...(chat ? { linkPath: sessionPath({ session: chat }) } : {}),
    metadata: {
      promptKind: kind,
      actionId: facts.action.id,
      ...(connectionId ? { connectionId } : {}),
      ...(agentPath ? { agentPath } : {}),
      ...(chat ? { sessionId: chat } : {}),
    },
  });
}
