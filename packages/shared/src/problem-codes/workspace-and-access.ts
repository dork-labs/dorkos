/**
 * Failure codes for agents and workspaces, a chat's working folder, managed MCP
 * sign-ins, money, signing in, approvals and tasks.
 *
 * Part of the failure code list, `PROBLEM_CODE_LIST` in `../problem.ts`.
 * Import codes from `@dorkos/shared/problem`, never from this file.
 *
 * @module shared/problem-codes/workspace-and-access
 */
import type { ProblemCodeDefinition } from './definition.js';

/** The codes for workspaces, working folders, sign-ins, approvals and tasks. */
export const WORKSPACE_AND_ACCESS_PROBLEM_CODES = [
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
] as const satisfies readonly ProblemCodeDefinition[];
