/**
 * Failure codes any route can answer with: who is asking, the request itself,
 * the state it met, and the server's own faults.
 *
 * Part of the failure code list, `PROBLEM_CODE_LIST` in `../problem.ts`.
 * Import codes from `@dorkos/shared/problem`, never from this file.
 *
 * @module shared/problem-codes/general
 */
import type { ProblemCodeDefinition } from './definition.js';

/** The codes any route can answer with. */
export const GENERAL_PROBLEM_CODES = [
  // Who is asking.
  { code: 'unauthenticated', status: 401, title: 'Sign in to DorkOS to continue.' },
  {
    code: 'person_session_required',
    status: 401,
    title: 'Enter your password to confirm it’s you.',
  },
  {
    code: 'agent_identity_unverified',
    status: 401,
    title: 'DorkOS couldn’t confirm which agent sent this.',
  },
  { code: 'step_up_required', status: 428, title: 'Confirm it’s you to continue.' },
  { code: 'forbidden', status: 403, title: 'This account isn’t allowed to do that.' },
  /** The caller is signed in, as an account that does not own this DorkOS. */
  { code: 'owner_only', status: 403, title: 'Only the owner of this DorkOS can do that.' },
  /**
   * Only the operator may: the owner, in person, at the computer DorkOS runs
   * on. An agent, another device (the tunnel, a remote link) or another
   * member is refused. Doing it there, as the owner, fixes it.
   */
  { code: 'operator_only', status: 403, title: 'Only the person at this computer can do that.' },
  /**
   * Any person may, and the caller is not one: an agent, a page from another
   * site, or a caller without a person's sign-in while login is on. A person
   * in the app fixes it.
   */
  { code: 'person_only', status: 403, title: 'Only a person can do that, not an agent.' },
  {
    code: 'not_from_wifi',
    status: 403,
    title: 'This can’t be done from another device on your network.',
  },
  { code: 'origin_not_allowed', status: 403, title: 'This page isn’t allowed to call DorkOS.' },
  { code: 'host_not_allowed', status: 403, title: 'This address isn’t allowed to reach DorkOS.' },
  {
    code: 'outside_boundary',
    status: 403,
    title: 'That path is outside the folders DorkOS may use.',
  },
  // The request itself.
  /** The body could not be parsed at all: broken JSON, a cut-off form. */
  { code: 'malformed_request', status: 400, title: 'The request body couldn’t be read.' },
  /**
   * The body was read, and failed the route's checks (its schema). `detail`
   * names the first field and what was wrong with it; `issues` lists them all.
   */
  { code: 'invalid_request', status: 400, title: 'The request didn’t pass its checks.' },
  { code: 'request_too_large', status: 413, title: 'The request is over the size limit.' },
  { code: 'unsupported_media_type', status: 415, title: 'DorkOS can’t read that kind of content.' },
  { code: 'not_found', status: 404, title: 'That doesn’t exist here.' },
  /** No agent on the team has that id: a different way out than a missing card or route. */
  { code: 'agent_not_found', status: 404, title: 'No agent has that id.' },
  { code: 'session_not_found', status: 404, title: 'That chat wasn’t found.' },
  { code: 'unknown_capability', status: 404, title: 'That action doesn’t exist.' },
  // The state it met.
  { code: 'conflict', status: 409, title: 'That clashes with a change made meanwhile.' },
  { code: 'session_locked', status: 409, title: 'This chat is busy with another reply.' },
  /**
   * Refused until a person approves. A refusal, so 403: the capability gate's
   * `approval_required` is a held request (a `202` body), never a problem.
   */
  { code: 'needs_approval', status: 403, title: 'This waits for a person to approve it.' },
  /**
   * What the caller was shown (a card, a review, a disclosure, a folder's
   * description) changed before its answer arrived. Look again, then answer.
   */
  { code: 'precondition_failed', status: 412, title: 'Something changed since you last looked.' },
  /**
   * The question, approval or offer was answered, withdrawn or closed before
   * this answer arrived. Nothing to do: treat it as settled.
   */
  { code: 'already_resolved', status: 409, title: 'This was already settled.' },
  /** Look at what this brings (a template, a workspace's commands) first, then confirm. */
  { code: 'needs_review', status: 409, title: 'Look at what this brings first.' },
  { code: 'rate_limited', status: 429, title: 'Too many requests. Wait a moment, then try again.' },
  // The server's own faults.
  { code: 'internal_error', status: 500, title: 'DorkOS hit an error on its side.' },
  /** A chat pinned to an agent program this computer is not running. */
  {
    code: 'runtime_not_available',
    status: 503,
    title: 'This chat’s program isn’t running on this computer.',
  },
  {
    code: 'temporarily_unavailable',
    status: 503,
    title: 'That’s not available right now. Try again soon.',
  },
  /** The path exists, and does not answer that HTTP method. */
  { code: 'method_not_allowed', status: 405, title: 'That method isn’t allowed here.' },
  /** A person was asked, and said no. */
  { code: 'declined', status: 403, title: 'A person said no to this.' },
  /** A remote DorkOS fetches from (a git host, a package feed) failed or didn’t answer. */
  { code: 'upstream_unavailable', status: 502, title: 'A remote source didn’t answer. Try again.' },
  /** Something an agent's running turn blocks: asked before that turn ended. */
  { code: 'outside_turn', status: 403, title: 'Wait until the agent’s turn ends.' },
] as const satisfies readonly ProblemCodeDefinition[];
