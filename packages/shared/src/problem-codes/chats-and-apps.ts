/**
 * Failure codes for mini apps, the person's browser, chats, rooms, relay
 * messages and connected apps.
 *
 * Part of the failure code list, `PROBLEM_CODE_LIST` in `../problem.ts`.
 * Import codes from `@dorkos/shared/problem`, never from this file.
 *
 * @module shared/problem-codes/chats-and-apps
 */
import type { ProblemCodeDefinition } from './definition.js';

/** The codes for mini apps, chats, rooms, relay messages and connected apps. */
export const CHAT_AND_APP_PROBLEM_CODES = [
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
] as const satisfies readonly ProblemCodeDefinition[];
