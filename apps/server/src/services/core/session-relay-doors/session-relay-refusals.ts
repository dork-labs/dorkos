/**
 * The refusals the `/api/session-relay` doors on the capability mount answer
 * with (`session-relay-capabilities.ts`, DOR-4978): each tool code with the
 * problem code and the fixed sentences the hand routes answered with.
 * `routes/capability-refusals.ts` spreads them into its table, so a sentence
 * listed here is sent as it is and any other gets the code's own sentence.
 *
 * Imports nothing but the problem type and the `/api` 404's sentence, so the
 * refusal table can load it.
 *
 * @module services/core/session-relay-doors/session-relay-refusals
 */
import type { ProblemCode } from '@dorkos/shared/problem';
import { API_NOT_FOUND_DETAIL } from '../../../http/problems/api-not-found.js';

/** One refusal: its problem code, its sentence, and the other sentences it may say. */
export interface SessionRelayToolRefusal {
  /** The problem code; its status comes with it. */
  readonly code: ProblemCode;
  /** The sentence for a refusal whose own sentence is not on `alsoSays`. */
  readonly detail: string;
  /** Every other sentence these doors refuse with under this code, each sent as it is. */
  readonly alsoSays?: readonly string[];
}

/** The sentences these doors refuse with, as the hand routes said them. */
export const SESSION_RELAY_SAYS = {
  /** The whole group on a hub, or with the experiment off: the `/api` 404's own sentence. */
  off: API_NOT_FOUND_DETAIL,
  /** The person bar, for a request from somewhere these can't be changed from. */
  elsewhere: 'Change this on the computer DorkOS runs on.',
  /** The person bar, for a caller who is not the owner in the app. */
  notTheOwner: 'Only you can change this, in the app on this computer.',
  /** A change to a link that is not there. */
  notLinked: 'This computer isn’t linked.',
} as const;

/** Every refusal these doors answer with, by tool code. */
export const SESSION_RELAY_TOOL_REFUSALS: Readonly<Record<string, SessionRelayToolRefusal>> = {
  SESSION_RELAY_OFF: { code: 'not_found', detail: SESSION_RELAY_SAYS.off },
  SESSION_RELAY_PERSON_HERE: {
    code: 'operator_only',
    detail: SESSION_RELAY_SAYS.notTheOwner,
    alsoSays: [SESSION_RELAY_SAYS.elsewhere],
  },
  SESSION_RELAY_NOT_LINKED: { code: 'conflict', detail: SESSION_RELAY_SAYS.notLinked },
};
