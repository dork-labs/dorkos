/**
 * Every feature id the contract between a home and its computers speaks, and
 * the one rule for using them (spec `space-computer-contract` §4.1, §5, §5.1;
 * DOR-5164).
 *
 * The protocol stays at version 1. Every operation, and every optional field
 * on a strict schema, is a feature. Each side names the features it speaks:
 * the computer in its `hello` (plain, but bound by both handshake signatures),
 * the home in one sealed `features` frame sent after the computer's `finish`
 * verifies. **Each side uses a feature only when both named it**
 * ({@link agreedAgentComputerFeatures}); a feature that is absent is never
 * assumed. A frame or field never goes to a peer that did not name its
 * feature, because an older peer closes the connection on a frame it cannot
 * decode.
 *
 * Ids this build does not know are carried and never acted on: they are kept
 * out of the agreed set, out of log lines and out of every decision. How many
 * ids a peer may name, and of what characters, is bounded where the lists are
 * parsed (`RelayAdvertisedFeaturesSchema`).
 *
 * Each later step of the spec adds its schemas beside this file and its ids
 * here, under the same names as its section of the spec. Two read ids are
 * spelled in lowercase (`session.last-ids`, `session.read-from`) because a
 * feature id is lowercase on the wire.
 *
 * @module shared/wire/features
 */
import { SESSION_RELAY_FEATURES, type RelayError } from '../session-relay.js';
import {
  AGENT_COMPUTER_RELAY_FEATURES,
  RELAY_CALL_FEATURES,
  type RelayFeaturesFrame,
} from '../session-relay-agent-computer.js';

export { AGENT_COMPUTER_RELAY_FEATURES, RELAY_CALL_FEATURES };

/**
 * Every feature only an agent computer and its home speak (spec §5). A linked
 * Mac names none of them, so the home never sends it a `features` frame. The
 * chat operations' features are {@link SESSION_RELAY_FEATURES}.
 */
export const AGENT_COMPUTER_FEATURES = [
  // The agent's facts, and giving up a request or call (§5.5, §5.3).
  'agents.sync',
  'agents.sync.facts',
  'call.cancel',
  // Turns (§5.2).
  'turn.start',
  'turn.start.run',
  'turn.stop',
  'turn.answer',
  'sessions.end',
  // The rules copy (§5.6).
  'rules.copy',
  // Tools (§5.3, §5.4).
  'tools.list',
  'tools.list.exposure',
  'tools.call',
  'tools.call.run',
  'tools.call.marks',
  'tools.call.facts',
  'tools.call.images',
  'kit.call',
  // What the computer reports (§5.7, §5.9).
  'computer.status',
  'computer.status.runs',
  'run.fact',
  'records.put',
  'asks.raise',
  // Pause and the config notice (§5.8).
  'agent.pause',
  'config.changed',
  // The reads (§6.2).
  'session.list',
  'session.get',
  'session.history',
  'session.snapshot',
  'session.tasks',
  'session.etag',
  'session.last-ids',
  'session.read-from',
  'session.fork',
  'sessions.watch',
  'runtime.describe',
  'runtime.models',
  'runtime.subagents',
  'runtime.commands',
  'runtime.dependencies',
] as const;

/** One agent-computer feature id. See {@link AGENT_COMPUTER_FEATURES}. */
export type AgentComputerFeature = (typeof AGENT_COMPUTER_FEATURES)[number];

/** Every feature id this build knows: the chat operations', then the agent computer's. */
export const WIRE_FEATURES = [...SESSION_RELAY_FEATURES, ...AGENT_COMPUTER_FEATURES] as const;

/** One feature id this build knows. See {@link WIRE_FEATURES}. */
export type WireFeature = (typeof WIRE_FEATURES)[number];

/**
 * What a computer must name to be ready for turns (spec §5.1). A computer that
 * lacks any of them gets no turns: its runs wait with a reason a person can
 * read, and nothing is refused. The rules copy without the run id on tool
 * calls is not enough, so both are here.
 */
export const REMOTE_COMPUTER_MIN_FEATURES = [
  'turn.start',
  'turn.start.run',
  'turn.stop',
  'turn.answer',
  'rules.copy',
  'computer.status',
  'computer.status.runs',
  'run.fact',
  'records.put',
  'asks.raise',
  'agents.sync',
  'agents.sync.facts',
  'tools.list',
  'tools.call',
  'tools.call.run',
  'call.cancel',
  'session.stream',
  'agent.pause',
  'sessions.end',
] as const satisfies readonly WireFeature[];

const AGENT_COMPUTER_FEATURE_SET: ReadonlySet<string> = new Set(AGENT_COMPUTER_FEATURES);

/**
 * Whether `id` is an agent-computer feature this build knows.
 *
 * @param id - A feature id, as a peer named it.
 */
export function isAgentComputerFeature(id: string): id is AgentComputerFeature {
  return AGENT_COMPUTER_FEATURE_SET.has(id);
}

/**
 * Whether a list names at least one agent-computer feature this build knows:
 * the test for sending a `features` frame at all.
 *
 * @param features - A peer's named features.
 */
export function namesAgentComputerFeature(features: readonly string[]): boolean {
  return features.some(isAgentComputerFeature);
}

/**
 * The agent-computer features both sides named: the only ones either side may
 * use on this connection. Never wider than either list, and never holding an
 * id this build does not know. On the home, `computer` is the `hello`; on the
 * computer, `home` is the `features` frame, and the set is empty until the
 * frame arrives.
 *
 * @param computer - The features the computer named in `hello`.
 * @param home - The features the home named in its `features` frame.
 */
export function agreedAgentComputerFeatures(
  computer: readonly string[],
  home: readonly string[]
): AgentComputerFeature[] {
  return AGENT_COMPUTER_FEATURES.filter(
    (feature) => computer.includes(feature) && home.includes(feature)
  );
}

/**
 * The `features` frame a home sends once a computer has proved itself, or
 * `null` when the computer named no agent-computer feature, so a computer that
 * would refuse the frame (an older one, or a linked Mac) never receives it.
 * The caller decides from its own record that the computer is an agent
 * computer, never from `hello`.
 *
 * @param computer - The features the computer named in `hello`.
 * @param home - The agent-computer features this home speaks.
 */
export function homeFeaturesFrameFor(
  computer: readonly string[],
  home: readonly AgentComputerFeature[]
): RelayFeaturesFrame | null {
  if (!namesAgentComputerFeature(computer)) return null;
  return { type: 'features', features: [...home] };
}

/**
 * The refusal for something the other side did not agree to: `501
 * needs_update`, naming the feature only when it is one this build knows.
 * With no feature (a call that could not be read at all) it says nothing
 * about what was sent.
 *
 * @param feature - The known feature that was not agreed, if there is one.
 */
export function wireFeatureRefusal(feature?: AgentComputerFeature): RelayError {
  return feature === undefined
    ? { status: 501, code: 'needs_update', message: 'This DorkOS cannot read that call.' }
    : {
        status: 501,
        code: 'needs_update',
        message: 'The other DorkOS needs an update for that.',
        feature,
      };
}
