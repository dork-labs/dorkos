/**
 * The one error shape the DorkOS API answers a failed request with: an RFC 9457
 * problem document, served as `application/problem+json`.
 *
 * This file holds the shape and the stable list of failure codes, and nothing
 * that sends a response, so the web client and the desktop shell can read a
 * refusal without pulling in a server framework. The server sends one through
 * `problem()` and `validationProblem()` in `@dorkos/http-kit`.
 *
 * The fields follow the DorkOS Cloud contract's `ProblemSchema`
 * (`packages/cloud-api/src/problem.ts`) field for field where the two overlap
 * (`code`, `status`, `title`, `detail`, `instance`, `retryAfterMs`), and a code
 * both lists name means the same thing in both. RFC 9457's own `type` member
 * and a validation failure's `issues` are added here; the Cloud contract's
 * plan and action-link fields are not, because nothing on this server has a
 * plan to name.
 *
 * Codes are `lower_snake`, as the Cloud contract's are. A code is permanent
 * once a client can see it: add one, never rename one.
 *
 * @module shared/problem
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** The media type a problem document is served as (RFC 9457 §3). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** One failure code, with the status and title a response carries by default. */
export interface ProblemCodeDefinition {
  /** The machine-readable code, `lower_snake`. */
  readonly code: string;
  /** The HTTP status a response with this code carries unless the sender says otherwise. */
  readonly status: number;
  /** A short summary, safe to show a person. The same for every occurrence of the code. */
  readonly title: string;
}

/**
 * Every failure code the API can answer with, each with its default status and
 * title. The single list: a code missing here cannot be sent.
 *
 * Seeded from the codes the server's routes answer with today (most of them in
 * `SCREAMING_CASE` until DOR-4979 moves the routes to this shape). Codes the
 * DorkOS Cloud contract also names keep its spelling.
 */
export const PROBLEM_CODE_LIST = [
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
  // Mini apps (extensions) and their calls.
  /** The mini app is turned off, or stopped: turn it on first. */
  { code: 'not_running', status: 409, title: 'That mini app isn’t running.' },
  /** A mini app asked for a room the person did not pick for it: pick it in Settings. */
  { code: 'room_not_allowed', status: 403, title: 'This mini app may not use that room.' },
  /** A forward named no agent the person allowed: pick one first. */
  { code: 'no_agent', status: 409, title: 'Pick an agent for this mini app first.' },
  /** A call between apps carried a token this server no longer knows: ask for a new one. */
  { code: 'caller_token_invalid', status: 403, title: 'Ask for a new caller token.' },
  /** The server is gone, and its saved key could not be deleted. */
  { code: 'secret_left', status: 500, title: 'The server is gone, but its saved key stayed.' },
  // The person's own browser.
  /** A sign-in is open in the browser: finish it first. */
  { code: 'signing_in', status: 409, title: 'Finish signing in first.' },
  /** A Back or Forward would open a page DorkOS doesn't open here, so the browser stayed. */
  { code: 'history_refused', status: 409, title: 'DorkOS doesn’t open that page here.' },
  // Chats: messages, questions, recordings and the chat's canvas.
  { code: 'agent_paused', status: 409, title: 'This agent is paused.' },
  /** A connected account that is paused, signed out or waiting on its owner: nothing ran. */
  { code: 'connection_not_ready', status: 409, title: 'This app isn’t ready to use.' },
  {
    code: 'room_session_moved',
    status: 409,
    title: 'This conversation runs in the room’s files now.',
  },
  { code: 'desk_not_own', status: 409, title: 'That place isn’t yours to run a chat in.' },
  { code: 'protected_folder', status: 403, title: 'That folder is protected. Choose another one.' },
  { code: 'queued_message_not_found', status: 404, title: 'That message isn’t waiting anymore.' },
  { code: 'queued_message_launching', status: 409, title: 'That message is already starting.' },
  { code: 'task_not_running', status: 409, title: 'That task isn’t running.' },
  { code: 'not_supported', status: 501, title: 'This chat’s program can’t do that.' },
  {
    code: 'account_not_allowed_here',
    status: 409,
    title: 'That account can’t work in this project.',
  },
  { code: 'expired', status: 410, title: 'That took too long. Start again.' },
  // Rooms, direct chats, read state and profiles.
  { code: 'room_not_found', status: 404, title: 'That room doesn’t exist, or you’re not in it.' },
  { code: 'room_archived', status: 409, title: 'This room is archived.' },
  { code: 'slug_taken', status: 409, title: 'That channel name is taken.' },
  { code: 'handle_taken', status: 409, title: 'That handle is taken.' },
  { code: 'handle_reserved', status: 409, title: 'That handle is kept for someone else.' },
  { code: 'handle_lookalike', status: 409, title: 'That handle looks too much like another one.' },
  { code: 'invalid_handle', status: 400, title: 'That handle can’t be used.' },
  {
    code: 'identity_not_external',
    status: 400,
    title: 'Only an account on another chat platform can be linked.',
  },
  { code: 'chat_already_bound', status: 409, title: 'Another agent already answers that chat.' },
  // Relay messages, chat connections and chat routes.
  /** A message claimed to come from a sender only the server itself uses. */
  { code: 'reserved_sender', status: 403, title: 'That sender is kept for DorkOS.' },
  /** A message or mailbox aimed at an address DorkOS manages itself. */
  { code: 'reserved_subject', status: 403, title: 'That address is kept for DorkOS.' },
  /** A room's own conversation takes messages only through the room. */
  { code: 'room_conversation', status: 403, title: 'That conversation belongs to a room.' },
  /** A broadcast is a one-way feed, so it never becomes a channel. */
  { code: 'broadcast_not_bridgeable', status: 400, title: 'A broadcast can’t become a channel.' },
  /** A chat route from before DorkOS noted chat kinds: connect it again from a new message. */
  {
    code: 'chat_type_unknown',
    status: 400,
    title: 'DorkOS doesn’t know what kind of chat this is.',
  },
  /** A paused chat route runs nothing, tests included: resume it first. */
  { code: 'chat_route_paused', status: 409, title: 'This chat route is paused.' },
  /** An outside service's request whose signature, timestamp or sender didn't check out. */
  { code: 'invalid_signature', status: 401, title: 'The request’s signature didn’t check out.' },
  {
    code: 'connection_id_taken',
    status: 409,
    title: 'A connection with that name already exists.',
  },
  /** A new connection was saved, but it couldn't connect: fix its token, then turn it on. */
  {
    code: 'connection_saved_not_started',
    status: 502,
    title: 'Saved, but the connection didn’t start.',
  },
  // Connected apps.
  /** This computer's link to the DorkOS account is gone or needs renewing: link it again. */
  {
    code: 'cloud_link_required',
    status: 401,
    title: 'Link this computer to your DorkOS account again.',
  },
  /** DorkOS's own servers didn't answer: nothing changed, and trying again later may work. */
  { code: 'cloud_unavailable', status: 503, title: 'DorkOS’s servers aren’t answering.' },
  /** DorkOS's own servers answered but couldn't finish: nothing changed here. */
  { code: 'cloud_refused', status: 502, title: 'DorkOS’s servers couldn’t finish this.' },
  /** DorkOS has no working way to reach this app, so there is nothing to sign in to or list. */
  { code: 'app_not_set_up', status: 404, title: 'DorkOS can’t reach this app right now.' },
  /** The app doesn't offer what was asked, such as writing back or a shared grant. */
  { code: 'app_not_supported', status: 422, title: 'This app doesn’t support that.' },
  /** An earlier sign-in's access at the service isn't ended yet. */
  {
    code: 'account_cleanup_pending',
    status: 409,
    title: 'DorkOS is still ending this account’s earlier access.',
  },
  /** A connected account is removed only after it is disconnected. */
  { code: 'still_connected', status: 409, title: 'Disconnect this app before removing it.' },
  /** Another agent's chat limits this app, so this switch can't change it. */
  { code: 'other_agent_chat', status: 409, title: 'This chat’s access is set for another agent.' },
  /** The app is turned off for the chat this request came from. */
  { code: 'app_off_in_chat', status: 409, title: 'This app is turned off for this chat.' },
  /** The chat or agent chosen can't take notifications now. */
  {
    code: 'destination_unavailable',
    status: 409,
    title: 'That place can’t take notifications now.',
  },
  /** The updates chosen with an answer can't be set up now: choose again, or answer without them. */
  { code: 'updates_unavailable', status: 503, title: 'Those updates can’t be set up now.' },
  /** The updates changed while they were being chosen: choose them again. */
  { code: 'updates_changed', status: 412, title: 'Those updates changed. Choose them again.' },
  /** An update filter's values don't fit the app's: fix them. */
  { code: 'invalid_filter', status: 400, title: 'Check the filter values.' },
  /** Signing in for an agent's request already started another way: finish that first. */
  {
    code: 'request_open_elsewhere',
    status: 409,
    title: 'Signing in already started another way.',
  },
  /** A management review is being settled right now; its outcome isn't known yet. */
  { code: 'review_resolving', status: 409, title: 'This review is being settled now.' },
  { code: 'avatar_missing', status: 400, title: 'No photo came through.' },
  { code: 'avatar_type_unsupported', status: 415, title: 'That file isn’t a PNG, JPEG or WebP.' },
  { code: 'attachment_not_found', status: 404, title: 'That file isn’t in this room.' },
  { code: 'room_repo_exists', status: 409, title: 'This room already has files of its own.' },
  { code: 'room_repos_disabled', status: 409, title: 'Room files are turned off here.' },
  {
    code: 'room_repo_git_unavailable',
    status: 409,
    title: 'Room files need git, and it isn’t installed.',
  },
  { code: 'room_has_no_repo', status: 409, title: 'This room has no files of its own.' },
  { code: 'room_file_path_invalid', status: 400, title: 'That name can’t be used in room files.' },
  { code: 'room_file_not_found', status: 404, title: 'That isn’t in the room’s files.' },
  { code: 'room_file_not_readable', status: 400, title: 'That can’t be opened or changed here.' },
  { code: 'room_file_not_text', status: 400, title: 'That file isn’t plain text.' },
  {
    code: 'room_file_exists',
    status: 409,
    title: 'Something in the room’s files already has that name.',
  },
  { code: 'room_upload_too_many_files', status: 400, title: 'Too many files in one upload.' },
  {
    code: 'file_changed',
    status: 409,
    title: 'Somebody changed these files since you opened them.',
  },
  {
    code: 'main_checkout_dirty',
    status: 409,
    title: 'The room’s files were changed outside DorkOS.',
  },
  {
    code: 'room_repo_config_unsafe',
    status: 409,
    title: 'The room’s git settings could run a program.',
  },
  { code: 'file_too_large', status: 409, title: 'A file is bigger than this room allows.' },
  { code: 'repo_cap_exceeded', status: 409, title: 'This room’s files are full.' },
  { code: 'merge_in_flight', status: 429, title: 'Another merge is running here. Try again soon.' },
  // Agents, the team, workspaces, terminals, diffs and the rest.
  { code: 'reports_to_cycle', status: 400, title: 'That would make someone report to themselves.' },
  { code: 'terminal_limit', status: 429, title: 'Too many terminals are open.' },
  { code: 'too_large', status: 413, title: 'That file is too large to open here.' },
  { code: 'not_a_file', status: 400, title: 'That path is a folder, not a file.' },
  { code: 'binary_file', status: 415, title: 'That file isn’t text.' },
  // A chat's working folder: the file explorer, the folder picker and file saves.
  { code: 'not_a_folder', status: 400, title: 'That path is a file, not a folder.' },
  { code: 'already_exists', status: 409, title: 'Something with that name is already there.' },
  { code: 'folder_not_empty', status: 409, title: 'That folder isn’t empty.' },
  { code: 'copy_into_self', status: 400, title: 'A folder can’t be copied into itself.' },
  /** The chat's top folder itself was the target of a create, delete, move or copy. */
  { code: 'working_folder_root', status: 400, title: 'The chat’s top folder can’t be changed.' },
  { code: 'range_not_satisfiable', status: 416, title: 'That part of the file doesn’t exist.' },
  /**
   * A canvas document save the server recorded as failed before it touched
   * the file. The file is unchanged; send a new save (the same save id keeps
   * answering with this failure).
   */
  { code: 'save_not_applied', status: 412, title: 'That save failed before it changed the file.' },
  // Managed MCP servers: why a sign-in could not start.
  /** The server won't let DorkOS register itself: the person adds their own app credentials. */
  {
    code: 'signin_no_app_registration',
    status: 409,
    title: 'This server won’t let DorkOS register itself.',
  },
  /** The server offers no sign-in DorkOS can use. */
  {
    code: 'signin_no_signin_support',
    status: 409,
    title: 'This server doesn’t offer sign-in the way DorkOS expects.',
  },
  /** The server didn't answer the start of a sign-in. */
  { code: 'signin_unreachable', status: 502, title: 'Couldn’t reach the server to sign in.' },
  // Money.
  /** The monthly spending limit for paid actions is reached: nothing was spent. */
  { code: 'spend_limit_reached', status: 409, title: 'This month’s spending limit is reached.' },
  // Signing in, confirming it's you, devices and remote access.
  /** The password typed for a step-up or the person session didn't match the owner's. */
  { code: 'wrong_password', status: 403, title: 'That’s not your DorkOS password.' },
  /** One held action took its last wrong password and was dropped. */
  { code: 'too_many_tries', status: 403, title: 'Too many wrong passwords. Nothing changed.' },
  /** The password matched but is too short to confirm with: choose a longer one. */
  { code: 'password_too_short', status: 409, title: 'That password is too short to confirm with.' },
  { code: 'no_password', status: 409, title: 'This computer’s owner has no password yet.' },
  { code: 'no_owner', status: 409, title: 'Create an owner account first.' },
  /** A password may not cross this connection: confirm at the computer DorkOS runs on. */
  {
    code: 'insecure_connection',
    status: 403,
    title: 'Confirm this on the computer DorkOS runs on.',
  },
  /** A loaded mini app an agent can edit keeps confirming off. `blockedBy` names them. */
  { code: 'extension_risk', status: 409, title: 'A mini app an agent can edit is loaded.' },
  /** The sign-in began before a risky mini app was cleared: sign in again. */
  { code: 'stale_sign_in', status: 409, title: 'Sign in again, then try once more.' },
  /** The page opened before a risky mini app was cleared: reload it. */
  { code: 'stale_page', status: 409, title: 'Reload this page, then try again.' },
  { code: 'passkey_needed', status: 409, title: 'Add a passkey on this computer first.' },
  /** The owner's passkey belongs to another address of this computer: open DorkOS there. */
  {
    code: 'passkey_on_other_address',
    status: 409,
    title: 'Your passkey works at another address of this computer.',
  },
  { code: 'passkey_refused', status: 401, title: 'That passkey check didn’t work.' },
  /** Opening DorkOS to other devices needs sign-in on: create the owner account first. */
  {
    code: 'auth_required_for_exposure',
    status: 409,
    title: 'Turn on sign-in before other devices can reach DorkOS.',
  },
  { code: 'lan_access_unsupported', status: 409, title: 'Network access doesn’t work here yet.' },
  /** An environment variable decides this setting, so it can't be changed here. */
  { code: 'set_by_environment', status: 409, title: 'An environment setting decides this.' },
  {
    code: 'remote_access_unavailable',
    status: 409,
    title: 'Remote access isn’t available here right now.',
  },
  /** DorkOS Cloud already holds this computer: withdraw it, then set it up again. */
  {
    code: 'remote_access_already_set_up',
    status: 409,
    title: 'DorkOS Cloud already has this computer.',
  },
  { code: 'remote_access_not_set_up', status: 409, title: 'Set up remote access first.' },
  /** A held action belongs to the browser window that asked for it: confirm it there. */
  {
    code: 'held_by_another_browser',
    status: 403,
    title: 'Confirm this in the window that asked.',
  },
  { code: 'signin_no_retry', status: 409, title: 'This sign-in can’t start again here.' },
  /** The browser won't keep a sign-in cookie over plain http at this address. */
  { code: 'sign_in_needs_https', status: 409, title: 'Open DorkOS over https to stay signed in.' },
  /** The DorkOS desktop app starts and stops this server: restart or reset it there. */
  {
    code: 'managed_by_desktop',
    status: 409,
    title: 'The DorkOS app runs this server, so do this there.',
  },
  // Approvals.
  /** Always allow isn't offered for this request: answer it once instead. */
  {
    code: 'always_not_offered',
    status: 409,
    title: 'Always allow isn’t offered for this request.',
  },
  // Tasks, to-dos, the work queue and settings.
  {
    code: 'schedule_package_owned',
    status: 409,
    title: 'A package owns this scheduled task, so it can’t be changed here.',
  },
  { code: 'past_due', status: 400, title: 'That time has already passed.' },
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

/** A failure code from {@link PROBLEM_CODE_LIST}. */
export type ProblemCode = (typeof PROBLEM_CODE_LIST)[number]['code'];

/** Every code's definition, by code. */
export const PROBLEM_CODES: Readonly<Record<ProblemCode, ProblemCodeDefinition>> =
  Object.fromEntries(PROBLEM_CODE_LIST.map((entry) => [entry.code, entry])) as Record<
    ProblemCode,
    ProblemCodeDefinition
  >;

/** How every failure code is spelled: `lower_snake`, as the Cloud contract's are. */
export const PROBLEM_CODE_PATTERN = /^[a-z]+(?:_[a-z]+)*$/;

/** The machine-readable failure code: one this server sends. */
export const ProblemCodeSchema = z
  .enum(PROBLEM_CODE_LIST.map((entry) => entry.code) as [ProblemCode, ...ProblemCode[]])
  .describe('The machine-readable failure code. Permanent once published.')
  .openapi('ProblemCode');

/**
 * What a request failed its schema on, in Zod's flattened form
 * (`z.flattenError`): messages about the whole value, and messages per field.
 */
export const ProblemIssuesSchema = z
  .object({
    formErrors: z.array(z.string()).describe('Messages about the value as a whole.'),
    fieldErrors: z
      .record(z.string(), z.array(z.string()))
      .describe('Messages for each field that failed, by field name.'),
  })
  .openapi('ProblemIssues');

/** A validation failure's issues. */
export type ProblemIssues = z.infer<typeof ProblemIssuesSchema>;

/**
 * The URI that names a code's problem type (RFC 9457 §3.1.1). A URN, so it
 * names the type without promising a page at it.
 *
 * @param code - The failure code.
 * @returns The problem type URI.
 */
export function problemType(code: ProblemCode): string {
  return `urn:dorkos:problem:${code}`;
}

/**
 * The error document every failed API request is answered with.
 *
 * For READING: `code` is any `lower_snake` code, so a problem from DorkOS Cloud
 * (whose codes this list does not hold) reads as one. Sending is narrower:
 * `problem()` in `@dorkos/http-kit` takes only a {@link ProblemCode}.
 */
export const ProblemSchema = z
  .object({
    type: z
      .string()
      .optional()
      .describe(
        'A URI naming the problem type: `urn:dorkos:problem:<code>`. Absent means `about:blank` (RFC 9457 §3.1.1), as in a DorkOS Cloud problem; this server always sends it.'
      ),
    title: z.string().describe('A short, human-readable summary, safe to show a person.'),
    status: z
      .number()
      .int()
      .min(400)
      .max(599)
      .describe('The HTTP status that accompanied this problem.'),
    detail: z
      .string()
      .optional()
      .describe('A longer explanation of this specific occurrence, safe to show a person.'),
    code: z
      .string()
      .regex(PROBLEM_CODE_PATTERN)
      .describe(
        'The machine-readable failure code, `lower_snake`. This server sends only the codes in `ProblemCode`; a reader accepts any, so a DorkOS Cloud code reads too.'
      ),
    instance: z
      .string()
      .optional()
      .describe('An opaque identifier for this occurrence, to quote when reporting it.'),
    retryAfterMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('How long to wait before retrying, when the failure is transient.'),
    issues: ProblemIssuesSchema.optional().describe(
      'What failed validation, when the request did not match its schema.'
    ),
  })
  .describe('The error document every failed API request is answered with (RFC 9457).')
  .openapi('Problem');

/** The error document every failed API request is answered with. */
export type Problem = z.infer<typeof ProblemSchema>;

/**
 * Narrows an unknown value, such as a parsed response body, to a {@link Problem}.
 *
 * @param value - A value of unknown shape.
 * @returns Whether it is a problem document.
 */
export function isProblem(value: unknown): value is Problem {
  return ProblemSchema.safeParse(value).success;
}

/**
 * What a failed response said, read the same way by every client: a message to
 * show a person and, when the server gave one, a stable code to branch on.
 */
export interface ErrorBodyReading {
  /** A sentence safe to show a person. */
  message: string;
  /** The machine-readable failure code, exactly as the server spelled it. */
  code?: string;
  /** The status the body itself named (a problem's `status`). */
  status?: number;
  /** What failed validation, in Zod's flattened form. */
  issues?: ProblemIssues;
  /** How long to wait before retrying, when the body says. */
  retryAfterMs?: number;
}

/**
 * The codes of the few failed answers that are not problem documents on
 * purpose, and that every client still reads (ADR 261123-170831): the login
 * gate's `401` (`AUTH_REQUIRED`), and the `428`s that hold an action for a
 * person, a step-up (`step_up_required`, `./step-up.ts`) and a passkey check
 * (`PASSKEY_CHECK_REQUIRED`, `./signed-in-devices.ts`). Each says its sentence
 * in `error` and names itself in `code`.
 */
const HELD_AND_GATE_CODES: ReadonlySet<string> = new Set([
  'AUTH_REQUIRED',
  'step_up_required',
  'PASSKEY_CHECK_REQUIRED',
]);

/**
 * Read a failed response's parsed JSON body: a problem document (`detail`,
 * else `title`), or one of the few answers that are not problems on purpose
 * (the login gate, a held step-up or passkey check). Any other body says
 * nothing a client may rely on, so it reads as the fallback.
 *
 * @param body - The parsed body, of unknown shape (or nothing, when it was not JSON).
 * @param fallbackMessage - The message when the body says none, such as `HTTP 500`.
 * @returns The reading.
 */
export function readErrorBody(body: unknown, fallbackMessage: string): ErrorBodyReading {
  if (isProblem(body)) {
    return {
      message: body.detail ?? body.title,
      code: body.code,
      status: body.status,
      ...(body.issues === undefined ? {} : { issues: body.issues }),
      ...(body.retryAfterMs === undefined ? {} : { retryAfterMs: body.retryAfterMs }),
    };
  }
  const held = body as { error?: unknown; code?: unknown } | null | undefined;
  if (typeof held?.code !== 'string' || !HELD_AND_GATE_CODES.has(held.code)) {
    return { message: fallbackMessage };
  }
  const said = typeof held.error === 'string' && held.error !== '' ? held.error : fallbackMessage;
  return { message: said, code: held.code };
}
