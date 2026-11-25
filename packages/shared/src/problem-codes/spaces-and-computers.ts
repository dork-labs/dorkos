/**
 * Failure codes for connected spaces, the DorkOS account, remote access, hubs
 * and the agent computer.
 *
 * Part of the failure code list, `PROBLEM_CODE_LIST` in `../problem.ts`.
 * Import codes from `@dorkos/shared/problem`, never from this file.
 *
 * @module shared/problem-codes/spaces-and-computers
 */
import type { ProblemCodeDefinition } from './definition.js';

/** The codes for spaces, the DorkOS account, remote access, hubs and computers. */
export const SPACE_AND_COMPUTER_PROBLEM_CODES = [
  // Spaces this DorkOS is connected to (`/api/community-connections`, `/api/communities`).
  /** The owner of this DorkOS changed while the page was open: reload it. */
  { code: 'owner_changed', status: 412, title: 'The owner of this DorkOS changed. Reload.' },
  /** Another check of this space connection is finishing: wait, then ask again. */
  { code: 'pairing_busy', status: 409, title: 'This pairing is still finishing.' },
  /** The connection's sign-in at the space ended: connect the space again. */
  { code: 'reconnect_required', status: 409, title: 'Reconnect this space to continue.' },
  /** The address holds several spaces: use one space's own link. */
  {
    code: 'space_choice_required',
    status: 409,
    title: 'That address holds more than one space.',
  },
  { code: 'space_name_not_found', status: 404, title: 'No space uses that address there.' },
  /** The space's server is older than this DorkOS connects to: whoever runs it updates it. */
  {
    code: 'space_server_outdated',
    status: 426,
    title: 'This space’s server is too old to connect.',
  },
  { code: 'space_deleted', status: 410, title: 'This space was deleted.' },
  { code: 'space_taken_down', status: 423, title: 'This space was taken down.' },
  { code: 'space_suspended', status: 423, title: 'This space is suspended.' },
  /** On hold: anyone can read it, nobody can post, and its owner can still export it. */
  { code: 'space_on_hold', status: 423, title: 'This space is on hold.' },
  /** Archived, or being deleted: it can be read, not changed. */
  { code: 'space_read_only', status: 423, title: 'This space is read-only.' },
  { code: 'space_not_open', status: 409, title: 'This space isn’t open right now.' },
  { code: 'space_muted', status: 403, title: 'You’re muted in this space for now.' },
  /** Slow mode holds the next post; `retryAfterMs` says for how long, when the space said. */
  { code: 'space_slow_mode', status: 429, title: 'This channel is in slow mode.' },
  { code: 'space_rules_not_accepted', status: 403, title: 'Accept this space’s rules first.' },
  /** One of the space's caps: agents, members or storage. */
  { code: 'space_limit_reached', status: 409, title: 'This space’s limit was reached.' },
  { code: 'space_unsupported', status: 409, title: 'This space doesn’t support that.' },
  /** The spaces experiment is off on this computer, so no space route answers. */
  { code: 'spaces_disabled', status: 404, title: 'Spaces are switched off.' },
  { code: 'space_name_taken', status: 409, title: 'That name is taken in this space.' },
  { code: 'report_not_allowed', status: 409, title: 'You can’t report this message.' },
  {
    code: 'reply_on_top_level_only',
    status: 409,
    title: 'Replies go only on a top-level message.',
  },
  {
    code: 'agent_not_taking_dms',
    status: 409,
    title: 'This agent isn’t taking direct messages.',
  },
  // The DorkOS account, its credits and hosted spaces (`/api/cloud`).
  {
    code: 'cloud_not_linked',
    status: 409,
    title: 'Link this computer to a DorkOS account first.',
  },
  /** A hub's account link belongs to DorkOS Cloud, so nobody links or unlinks it here. */
  { code: 'hub_linked_by_cloud', status: 409, title: 'DorkOS Cloud manages this account link.' },
  /** Switching now would cut off a reply: switch once it finishes. */
  { code: 'runtime_busy', status: 409, title: 'This runtime is in the middle of a reply.' },
  { code: 'credits_off', status: 409, title: 'DorkOS credits are turned off on this computer.' },
  /** One move per browser at a time: confirm or cancel the one waiting first. */
  { code: 'move_pending', status: 409, title: 'Confirm or cancel the pending move first.' },
  /** A body sent without its size, so it can't be checked before it arrives. */
  { code: 'length_required', status: 411, title: 'Send the file with its size.' },
  /** A space export this computer has no room to hold while it goes up. */
  { code: 'disk_full', status: 507, title: 'This computer needs more free space.' },
  /** The disk won't say how much space it has: put DORK_HOME on a local disk. */
  { code: 'disk_space_unknown', status: 507, title: 'This computer can’t report its free space.' },
  // Remote access through the person's own tunnel (`/api/tunnel`).
  /** The tunnel is already open; `url` is its address. Not a failure: it converges. */
  { code: 'tunnel_running', status: 409, title: 'Remote access is already on.' },
  { code: 'tunnel_token_missing', status: 400, title: 'Add an ngrok auth token first.' },
  /** `TUNNEL_PORT` aims the tunnel past the one port Remote Access reaches. */
  { code: 'tunnel_port_mismatch', status: 409, title: 'Remote access can’t reach that port.' },
  // Hubs and the computers linked to them (`/api/hub`).
  /** The computer is waking; `retryAfterMs` says when to ask again. */
  { code: 'computer_waking', status: 503, title: 'Waking your computer. Try again soon.' },
  { code: 'computer_refused', status: 502, title: 'Your computer turned this request away.' },
  /** The linked computer isn't connected to the hub, or its connection ended before an answer. */
  { code: 'computer_offline', status: 503, title: 'Your computer isn’t connected right now.' },
  { code: 'computer_timed_out', status: 504, title: 'Your computer didn’t answer in time.' },
  /** The computer lacks what this needs; `feature` names it. */
  { code: 'needs_update', status: 501, title: 'This computer needs an update for that.' },
  { code: 'link_code_refused', status: 401, title: 'That link code didn’t work. Make a new one.' },
  { code: 'already_linked', status: 409, title: 'That computer is already linked.' },
  { code: 'computer_limit_reached', status: 409, title: 'This hub can’t link another computer.' },
  { code: 'not_acceptable', status: 406, title: 'This address answers in another format.' },
  // The agent computer (`/api/computers`).
  {
    code: 'computer_unsupported',
    status: 400,
    title: 'This computer can’t run an agent computer.',
  },
  { code: 'computer_disabled', status: 400, title: 'Agent computers are turned off.' },
  {
    code: 'computer_sign_in_required',
    status: 400,
    title: 'Sign in inside the agent computer first.',
  },
  /** Another window took control, or the computer restarted: take control again. */
  { code: 'computer_control_lost', status: 409, title: 'Control of the agent computer moved.' },
  /** Stopping ran, but DorkOS can't confirm the computer shut down. */
  {
    code: 'computer_cleanup_uncertain',
    status: 409,
    title: 'DorkOS can’t confirm the agent computer stopped.',
  },
  { code: 'computer_setup_failed', status: 503, title: 'The agent computer couldn’t be set up.' },
] as const satisfies readonly ProblemCodeDefinition[];
