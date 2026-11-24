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
  { code: 'owner_only', status: 403, title: 'Only the owner of this DorkOS can do that.' },
  { code: 'operator_only', status: 403, title: 'Only the person at this computer can do that.' },
  { code: 'person_only', status: 403, title: 'Only a person can do that, not an agent.' },
  { code: 'not_from_wifi', status: 403, title: 'This can’t be done from another device on Wi-Fi.' },
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
  { code: 'precondition_failed', status: 412, title: 'Something changed since you last looked.' },
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
  /** What an install or update would bring is not what the person was shown. */
  {
    code: 'disclosure_changed',
    status: 409,
    title: 'What this installs changed since you looked.',
  },
  /** A person was asked, and said no. */
  { code: 'declined', status: 403, title: 'A person said no to this.' },
  /** A request only an older client sends; updating the client fixes it. */
  { code: 'client_outdated', status: 400, title: 'This client is too old. Update it.' },
  /** A remote DorkOS fetches from (a git host, a package feed) failed or didn’t answer. */
  { code: 'upstream_unavailable', status: 502, title: 'A remote source didn’t answer. Try again.' },
  /** Something an agent's running turn blocks: asked before that turn ended. */
  { code: 'outside_turn', status: 403, title: 'Wait until the agent’s turn ends.' },
  // Chats: messages, questions, recordings and the chat's canvas.
  { code: 'agent_paused', status: 409, title: 'This agent is paused.' },
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
  { code: 'interaction_already_resolved', status: 409, title: 'This was already answered.' },
  {
    code: 'operator_cookie_required',
    status: 403,
    title: 'Only a person signed in to DorkOS can do that.',
  },
  { code: 'expired', status: 410, title: 'That took too long. Start again.' },
  // Agent programs (runtimes) and their accounts.
  {
    code: 'needs_person_at_this_computer',
    status: 403,
    title: 'Only the owner, at this computer, can change that.',
  },
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
  { code: 'template_needs_review', status: 409, title: 'Look at what this template brings first.' },
  {
    code: 'workspace_needs_review',
    status: 409,
    title: 'Look at what this workspace brings first.',
  },
  {
    code: 'remove_hooks_need_review',
    status: 409,
    title: 'Look at this workspace’s removal commands first.',
  },
  { code: 'reports_to_cycle', status: 400, title: 'That would make someone report to themselves.' },
  { code: 'terminal_limit', status: 429, title: 'Too many terminals are open.' },
  { code: 'too_large', status: 413, title: 'That file is too large to open here.' },
  { code: 'not_a_file', status: 400, title: 'That path is a folder, not a file.' },
  { code: 'binary_file', status: 415, title: 'That file isn’t text.' },
  // Tasks, to-dos, the work queue and settings.
  {
    code: 'schedule_review_changed',
    status: 409,
    title: 'This schedule changed. Review it again.',
  },
  {
    code: 'schedule_package_owned',
    status: 409,
    title: 'A package owns this scheduled task, so it can’t be changed here.',
  },
  {
    code: 'looser_than_proposed',
    status: 409,
    title: 'That runs with more permission than the proposal asked for.',
  },
  { code: 'past_due', status: 400, title: 'That time has already passed.' },
  { code: 'operator_only_config', status: 403, title: 'Only a person can change those settings.' },
  { code: 'insufficient_storage', status: 507, title: 'The disk is full.' },
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
  /**
   * A problem's `reason` extension member: the finer refusal a route names
   * under a broader code (`stale_approval` under `conflict`), `lower_snake`.
   */
  reason?: string;
}

/** A problem's `reason` extension member, when it carries a string one. */
function problemReason(body: Problem): { reason?: string } {
  const reason = (body as { reason?: unknown }).reason;
  return typeof reason === 'string' ? { reason } : {};
}

/** Whether a value is a validation failure in Zod's flattened form. */
function isFlattenedIssues(value: unknown): value is ProblemIssues {
  return ProblemIssuesSchema.safeParse(value).success;
}

/**
 * Read a failed response's parsed JSON body: a problem document first
 * (`detail`, else `title`), then the old `{ error, code, details }` shape.
 *
 * The old shape is read only while DOR-4979 moves the routes over, folder by
 * folder; the series' last change removes that branch.
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
      ...problemReason(body),
    };
  }
  if (typeof body !== 'object' || body === null) return { message: fallbackMessage };
  const old = body as { error?: unknown; message?: unknown; code?: unknown; details?: unknown };
  const message =
    typeof old.error === 'string' && old.error !== ''
      ? old.error
      : typeof old.message === 'string' && old.message !== ''
        ? old.message
        : fallbackMessage;
  return {
    message,
    ...(typeof old.code === 'string' ? { code: old.code } : {}),
    ...(isFlattenedIssues(old.details) ? { issues: old.details } : {}),
  };
}
