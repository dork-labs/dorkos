/**
 * What a capability's refusal answers over HTTP: a problem document
 * (ADR 261123-170831), built from a fixed table, never from the refusal's own
 * text.
 *
 * A capability refuses in two ways. The tier gate refuses a caller for good
 * ({@link gateRefusalProblem}), and a capability's handler refuses with a
 * `CapabilityToolError` whose payload is the `{ error, code }` an agent reads
 * over MCP ({@link toolRefusalProblem}). The MCP wire keeps that payload; the
 * HTTP doors answer with a problem whose `code` comes from the shared list and
 * whose `detail` is a fixed sentence chosen here. A handler's `error` text is
 * never copied into the problem, because some handlers fill it from a caught
 * exception or an upstream service's raw answer.
 *
 * @module routes/capability-refusals
 */
import type { Context } from 'hono';
import { problemBody, sendProblem, type ProblemStatus } from '@dorkos/http-kit';
import { PROBLEM_CODES, type Problem, type ProblemCode } from '@dorkos/shared/problem';
import { WORK_QUEUE_MAX_QUEUED } from '@dorkos/shared/work-queue-schemas';
import { PERSON_ONLY_AGENT_HINTS } from '@dorkos/shared/capabilities';
import { TODO_TOOL_REFUSALS } from '../services/todos/todo-refusals.js';
import { MESH_TOOL_REFUSALS } from '../services/mesh/doors/mesh-refusals.js';

import type {
  TierDeniedPayload,
  TierDeniedReason,
  TierEnforcementDecision,
} from '../services/core/capabilities/tier-enforcement.js';

/** One refusal as a caller reads it: a code from the shared list and a fixed sentence. */
interface Refusal {
  readonly code: ProblemCode;
  readonly detail: string;
  /**
   * Other fixed sentences the capability may refuse with under this code. A
   * refusal whose own sentence is exactly one of these is sent with it; any
   * other gets {@link Refusal.detail}. So only sentences written here are sent.
   */
  readonly alsoSays?: readonly string[];
  /** The status, when a door kept one other than the code's default (a registry 422). */
  readonly status?: ProblemStatus;
}

/** The sentence each refusal family answers with, when no tool code says more. */
const FAMILY_DETAIL = {
  not_found: 'That doesn’t exist here. Check the id and try again.',
  forbidden: 'This caller isn’t allowed to do that.',
  precondition_failed: 'Something changed since you last looked. Look again, then retry.',
  temporarily_unavailable: 'That’s not available right now. Try again soon.',
  needs_approval: 'This waits for a person to approve it.',
  already_resolved: 'This was already settled. Nothing more to do.',
  invalid_request: 'This action refused that request. Check its input and try again.',
  internal_error: 'DorkOS hit an error running that action. Try again.',
  rate_limited: 'Too many requests. Wait a moment, then try again.',
  agent_identity_unverified: 'DorkOS couldn’t confirm who is asking, so nothing ran.',
  person_only: 'Only a person can do that, not an agent.',
  operator_only: 'Only the person at this computer can do that.',
  owner_only: 'Only the owner of this DorkOS can do that.',
  conflict: 'That clashes with something already here. Look again, then retry.',
  request_too_large: 'That is over the size limit.',
  not_supported: 'This can’t be done here.',
  expired: 'That took too long. Start again.',
} as const satisfies Partial<Record<ProblemCode, string>>;

/** A family's refusal: its code and its sentence. */
function family(code: keyof typeof FAMILY_DETAIL): Refusal {
  return { code, detail: FAMILY_DETAIL[code] };
}

/**
 * The refusals a client branches on or a person needs in their own words, by
 * the tool code in upper case. Every other tool code falls to its family
 * ({@link familyOf}).
 */
const TOOL_REFUSALS: Readonly<Record<string, Refusal>> = {
  // Managed MCP sign-in: the client offers "use your own app credentials" on the first.
  SIGNIN_NO_APP_REGISTRATION: {
    code: 'signin_no_app_registration',
    detail: 'This server won’t let DorkOS register itself. Add your own app credentials.',
  },
  SIGNIN_NO_SIGNIN_SUPPORT: {
    code: 'signin_no_signin_support',
    detail: 'This server doesn’t offer sign-in the way DorkOS expects.',
  },
  SIGNIN_UNREACHABLE: {
    code: 'signin_unreachable',
    detail: 'Couldn’t reach the server to start the sign-in. Try again.',
  },
  // Who is asking. A person-only capability may name the tool an agent uses instead
  // (`http.agentsUse`), one of a fixed list.
  PERSON_ONLY: {
    code: 'person_only',
    detail: FAMILY_DETAIL.person_only,
    alsoSays: PERSON_ONLY_AGENT_HINTS,
  },
  AGENT_IDENTITY_UNVERIFIED: {
    code: 'agent_identity_unverified',
    detail: 'DorkOS couldn’t confirm which agent sent this, so nothing ran.',
  },
  UNIDENTIFIED: {
    code: 'agent_identity_unverified',
    detail: 'DorkOS can’t tell which agent is asking, so nothing changed.',
  },
  CONNECTOR_PRINCIPAL_REQUIRED: {
    code: 'agent_identity_unverified',
    detail: 'DorkOS couldn’t tell who is running this action, so it didn’t run.',
  },
  SESSION_REQUIRED: {
    code: 'person_session_required',
    detail: 'Enter your password to confirm it’s you, then try again.',
  },
  OPERATOR_ONLY: family('operator_only'),
  OWNER_MUST_BE_PRESENT: family('operator_only'),
  RESERVED_NAME: {
    code: 'invalid_request',
    detail: 'That is one of DorkOS’s own names. Pick another.',
  },
  CANNOT_RESUME_SELF: {
    code: 'forbidden',
    detail: 'An agent can’t lift its own pause. A person has to.',
  },
  NOT_YOURS: { code: 'forbidden', detail: 'That belongs to someone else.' },
  OUTSIDER_HELD: {
    code: 'forbidden',
    detail: 'This turn read outside content, so it can’t change that. Ask a person.',
  },
  NOT_ON_THIS_SURFACE: { code: 'not_supported', detail: FAMILY_DETAIL.not_supported },
  UNKNOWN_CALLER: family('agent_identity_unverified'),
  OUTSIDE_FOLDER: {
    code: 'outside_boundary',
    detail: 'That path is outside the folders DorkOS may use.',
  },
  // Not the shared `no_agent`, which is about a mini app's forward.
  NO_AGENT: { code: 'invalid_request', detail: 'This chat needs an active agent.' },
  HOLD_REQUESTER: {
    code: 'forbidden',
    detail: 'The agent that asked for this action can’t cancel it. Anyone else can.',
  },
  TRANSCRIPT_PRIVATE: {
    code: 'forbidden',
    detail: 'That chat is private to the person who had it.',
  },
  OUTSIDE_TURN: {
    code: 'outside_turn',
    detail: 'Wait until the agent’s turn ends, then try again.',
  },
  DEV_LINK_PATH_NOT_ALLOWED: {
    code: 'outside_boundary',
    detail: 'That folder is outside the folders DorkOS may use.',
  },
  // `GET /api/activity` and `GET /api/audit/{id}` kept their own sentences when
  // they moved onto the mount.
  ACTIVITY_READ_FAILED: { code: 'internal_error', detail: 'The activity feed couldn’t be read.' },
  AUDIT_EVENT_NOT_FOUND: { code: 'not_found', detail: 'No audit event with that id.' },
  // Connected apps.
  CONNECTOR_TARGET_NOT_FOUND: {
    code: 'not_found',
    detail: 'That connected app wasn’t found. Choose one this agent can use.',
  },
  CONNECTOR_GRANT_REQUIRED: {
    code: 'forbidden',
    detail: 'This agent isn’t given that action. A person gives it on the Connections page.',
  },
  CONNECTOR_AGENT_NOT_OWNED: { code: 'forbidden', detail: 'That agent isn’t one of yours.' },
  // The account is paused, signed out or waiting on its owner: not the caller's input.
  CONNECTOR_NOT_EXECUTABLE: {
    code: 'connection_not_ready',
    detail: 'This app isn’t ready to use. Check it in Connections.',
  },
  CONNECTOR_SIGN_IN_ENDED: {
    code: 'connection_not_ready',
    detail: 'This app’s sign-in ended. Sign in again in Connections.',
  },
  CONNECTOR_MANAGED_AUTHORITY_PENDING: {
    code: 'connection_not_ready',
    detail: 'This app is waiting on its owner. Nothing ran.',
  },
  CONNECTOR_OWNER_MISMATCH: {
    code: 'not_found',
    detail: 'That connected app wasn’t found. Choose one this agent can use.',
  },
  // Money.
  SPEND_LIMIT: {
    code: 'spend_limit_reached',
    detail: 'This month’s spending limit is reached. Nothing was spent.',
  },
  SPEND_OUTSIDER: {
    code: 'forbidden',
    detail: 'Paid actions are off for this turn. It read outside content.',
  },
  // The state it met.
  DUPLICATE_NAME: { code: 'conflict', detail: 'Something with that name already exists here.' },
  NO_REQUESTER: {
    code: 'conflict',
    detail: 'That request doesn’t record who asked, so it can’t be taken back.',
  },
  ALREADY_ENDED: { code: 'already_resolved', detail: FAMILY_DETAIL.already_resolved },
  HOLD_NO_LONGER_ALLOWED: { code: 'already_resolved', detail: FAMILY_DETAIL.already_resolved },
  CANCELLED: { code: 'already_resolved', detail: FAMILY_DETAIL.already_resolved },
  MANIFEST_UNREADABLE: {
    code: 'internal_error',
    detail: 'The agent’s settings file couldn’t be read. Check it, then try again.',
  },
  // A refused path (`services/core/directory/path-refusal.ts`), in the
  // words the hand routes used before they moved onto the mount.
  PATH_NULL_BYTE: {
    code: 'invalid_request',
    detail: 'That path has a character paths can’t hold.',
  },
  PATH_OUTSIDE_BOUNDARY: {
    code: 'outside_boundary',
    detail: 'Pick a folder inside the ones DorkOS may use.',
  },
  FOLDER_NOT_READABLE: { code: 'forbidden', detail: 'DorkOS isn’t allowed to read that folder.' },
  PATH_UNFOLLOWABLE: { code: 'invalid_request', detail: 'That path can’t be followed.' },
  // `/api/directory`, `/api/diff` and `/api/workspaces` kept
  // their own sentences when they moved onto the mount.
  FOLDER_MISSING: { code: 'not_found', detail: 'That folder doesn’t exist.' },
  FOLDER_UNREADABLE: { code: 'internal_error', detail: 'Couldn’t read that folder. Try again.' },
  PATH_IS_A_FILE: { code: 'not_a_folder', detail: 'That path is a file, not a folder.' },
  DIFF_SESSION_NOT_FOUND: { code: 'session_not_found', detail: 'No chat with that id.' },
  DIFF_FILE_TOO_LARGE: { code: 'too_large', detail: 'This file is too large to diff here.' },
  DIFF_NOT_A_FILE: { code: 'not_a_file', detail: 'This path is a folder, not a file.' },
  DIFF_BINARY_FILE: {
    code: 'binary_file',
    detail: 'This file isn’t text, so it has no text diff.',
  },
  DIFF_NO_EARLIER_VERSION: {
    code: 'not_found',
    detail: 'This file has no earlier version to restore.',
  },
  DIFF_WRITE_NOT_ALLOWED: { code: 'forbidden', detail: 'DorkOS isn’t allowed to write this file.' },
  WORKSPACE_NOT_FOUND: { code: 'not_found', detail: 'No workspace with that id.' },
  // A person's work queue doors kept the hand routes' sentences when they moved
  // onto the mount (`services/work-queue/work-queue-person-capabilities.ts`).
  WORK_QUEUE_AGENT_NOT_FOUND: { code: 'not_found', detail: 'No agent on the team has that id.' },
  WORK_ITEM_NOT_FOUND: { code: 'not_found', detail: 'No item in a work queue has that id.' },
  WORK_ITEM_STARTED: { code: 'conflict', detail: 'That item has already started.' },
  WORK_ITEM_NOT_ENDED: { code: 'conflict', detail: 'That item has not ended.' },
  WORK_QUEUE_FULL: {
    code: 'conflict',
    detail: `This queue already has ${WORK_QUEUE_MAX_QUEUED} items waiting.`,
  },
  WORK_ITEM_BAD_CWD: { code: 'invalid_request', detail: 'The folder must be an absolute path.' },
  // The task reads kept the hand routes' sentence (`tasks/view/task-view-capabilities.ts`).
  TASK_RUN_NOT_FOUND: { code: 'not_found', detail: 'No run has that id.' },
  TASKS_UNAVAILABLE: {
    code: 'temporarily_unavailable',
    detail: 'Scheduled tasks are not running on this server.',
  },
  // The to-do reads and a person's to-do writes kept the hand routes' codes and
  // sentences when they moved onto the mount (`services/todos/todo-http-capabilities.ts`,
  // `services/todos/todo-write-capabilities.ts`).
  ...TODO_TOOL_REFUSALS,
  TODO_AGENT_NOT_FOUND: { code: 'not_found', detail: 'No agent on the team has that id.' },
  TODO_PROMISE_OWNER_ONLY: {
    code: 'owner_only',
    detail: 'Only the owner of this agent can change its to-dos.',
  },
  TODO_PROMISE_PAST_DUE: {
    code: 'past_due',
    detail: 'That due date has passed. Pick a time ahead.',
  },
  // The agent registry's doors kept the hand routes' codes, statuses and sentences
  // (`services/mesh/doors/mesh-refusals.ts`).
  ...MESH_TOOL_REFUSALS,
};

/** How a tool code ends or starts, and the family that spelling means. */
const FAMILY_RULES: ReadonlyArray<readonly [RegExp, keyof typeof FAMILY_DETAIL]> = [
  [/(^|_)NOT_FOUND$|^UNKNOWN_|_GONE$/, 'not_found'],
  [/_CHANGED$|_CHANGED_SINCE$|_MISMATCH$|^STALE_|_STALE$/, 'precondition_failed'],
  [/(^|_)RATE_LIMIT(ED)?$/, 'rate_limited'],
  [/(^|_)EXPIRED$/, 'expired'],
  // The caller's input, before `_ERROR$` reads it as the server's fault.
  [/^VALIDATION(_ERROR)?$|^INVALID_/, 'invalid_request'],
  [/_FAILED$|_FAILURE$|_ERROR$|^EXCEPTION$|_UNREADABLE$|_OUTCOME_UNKNOWN$/, 'internal_error'],
  [/^E(ACCES|BADF|CONNRESET|IO|MFILE|NOENT|NOSPC|PERM)$/, 'internal_error'],
  [
    /^NOT_READY$|(^|_)UNAVAILABLE$|(^|_)TIMEOUT$|(^|_)BUSY$|_WORKING$|_DISABLED$|^NOT_STARTED$/,
    'temporarily_unavailable',
  ],
  [/^UNIDENTIFIED(_|$)|_UNVERIFIED$/, 'agent_identity_unverified'],
  // A person this action can't reach yet is not a "person only" refusal.
  [/(^|_)UNREACHABLE$/, 'not_supported'],
  [/PERSON|PEOPLE_ONLY/, 'person_only'],
  [/^OWNER_ONLY$/, 'owner_only'],
  [/(^|_)APPROVAL_REQUIRED$|_PREFLIGHT_REQUIRED$|_NEEDS_YES$/, 'needs_approval'],
  [/(^|_)NOT_OWNED$|^NOT_YOUR|_DENIED$|(^|_)NOT_ALLOWED$|_REFUSED$|_INACTIVE$/, 'forbidden'],
  [
    /(^|_)CANNOT_|_CANT_|^NOT_THE_CALLER$|^SELF(_APPROVAL)?$|^OTHER_AGENTS_|(^|_)PROTECTED_|^SYSTEM_AGENT$|(^|_)MARKED_TURN$/,
    'forbidden',
  ],
  [/_TAKEN$|^DUPLICATE_|_EXISTS$|(^|_)CONFLICT$|_ALREADY_(BOUND|BRIDGED|POSTED)$/, 'conflict'],
  [/^TOO_MANY_|(^|_)LIMIT$|(^|_)CAP(ACITY)?(_REACHED)?$|^AT_CAPACITY$|_FULL$|_LOCKED$/, 'conflict'],
  [/^CANCELLED|(^|_)ALREADY_RESOLVED$|^CLOSED$|^CLOSING$|_ENDED$|^NOTHING_TO_/, 'already_resolved'],
  [/_TOO_LARGE$/, 'request_too_large'],
  [/(^|_)UNSUPPORTED(_|$)|^NOT_SUPPORTED$/, 'not_supported'],
];

/**
 * The family a tool code with no {@link TOOL_REFUSALS} entry and no shared
 * code of its own belongs to, from how it is spelled: the first matching
 * {@link FAMILY_RULES} entry. In short: not found, changed meanwhile, too many,
 * expired, DorkOS's own fault (`…_FAILED`, `…_ERROR`, an errno), not available
 * yet (`…_UNAVAILABLE`, `…_DISABLED`, `…_TIMEOUT`), an unconfirmed caller
 * (`UNIDENTIFIED…`), a person wanted (any code naming `PERSON`), a person's
 * yes wanted, not this caller's (`…_NOT_OWNED`, `…_DENIED`, `CANNOT_…`), a
 * clash or a full limit, already settled, too large, or not possible here.
 * Everything else is the caller's to fix, `invalid_request`.
 */
function familyOf(code: string): Refusal {
  const rule = FAMILY_RULES.find(([pattern]) => pattern.test(code));
  return family(rule ? rule[1] : 'invalid_request');
}

/**
 * A tool code that IS a code on the shared list, spelled in upper case
 * (`AGENT_PAUSED`, `ROOM_ARCHIVED`): the same meaning, so the same code, with
 * the code's own title as the sentence.
 */
function sharedCode(code: string): Refusal | undefined {
  const lower = code.toLowerCase();
  if (!Object.hasOwn(PROBLEM_CODES, lower)) return undefined;
  const definition = PROBLEM_CODES[lower as ProblemCode];
  return { code: lower as ProblemCode, detail: definition.title };
}

/**
 * The problem a capability's own refusal answers with over HTTP.
 *
 * @param payload - The `CapabilityToolError`'s payload, of unknown shape.
 * @returns The problem document: a code from the shared list and a fixed sentence.
 */
export function toolRefusalProblem(payload: unknown): Problem {
  const { code: raw, error } =
    typeof payload === 'object' && payload !== null
      ? (payload as { code?: unknown; error?: unknown })
      : {};
  const code = typeof raw === 'string' ? raw.toUpperCase().replace(/-/g, '_') : undefined;
  const refusal =
    code === undefined
      ? family('invalid_request')
      : (TOOL_REFUSALS[code] ?? sharedCode(code) ?? familyOf(code));
  const listed = typeof error === 'string' && refusal.alsoSays?.includes(error);
  return problemBody(refusal.code, {
    detail: listed ? error : refusal.detail,
    ...(refusal.status === undefined ? {} : { status: refusal.status }),
  });
}

/**
 * Each way the tier gate refuses for good, as a code and a sentence. Every one
 * is a `403`: asking again, as the same caller, gets the same answer.
 */
const GATE_REFUSALS: Readonly<Record<TierDeniedReason, Refusal>> = {
  operator_denied: { code: 'declined', detail: 'A person said no to this action.' },
  recently_denied: {
    code: 'declined',
    detail: 'A person said no to this less than a day ago. Don’t ask again yet.',
  },
  request_pending: {
    code: 'needs_approval',
    detail: 'A request for this is already waiting on a person.',
  },
  permission_blocked: {
    code: 'forbidden',
    detail: 'This caller’s permissions block this action.',
  },
  enforcement_unavailable: {
    code: 'forbidden',
    detail: 'Nobody can approve this right now, so it didn’t run.',
  },
  input_not_bindable: {
    code: 'forbidden',
    detail: 'This request can’t be tied to an approval, so it didn’t run.',
  },
  request_limit: {
    code: 'forbidden',
    detail: 'This agent already asked five times this hour. Wait before asking again.',
  },
};

/**
 * The problem the tier gate's final refusal answers with over HTTP. The code
 * says why; `capabilityId`, `tier`, `approvable` and, when a person said no,
 * `approvalId` ride along as extension members.
 *
 * @param payload - The gate's refusal.
 * @returns The problem document, always a `403`.
 */
export function gateRefusalProblem(payload: TierDeniedPayload): Problem {
  const refusal = GATE_REFUSALS[payload.reason];
  // A block a person can lift says how to ask: the agent's next step (DOR-4355).
  const detail =
    payload.reason === 'permission_blocked' && payload.approvable
      ? 'Blocked here. Ask a person for it with the request_permission tool.'
      : refusal.detail;
  return problemBody(refusal.code, {
    detail,
    status: 403,
    extensions: {
      capabilityId: payload.capabilityId,
      tier: payload.tier,
      approvable: payload.approvable,
      ...(payload.approvalId === undefined ? {} : { approvalId: payload.approvalId }),
    },
  });
}

/**
 * Answer a request the tier gate did not allow: `202` with the approval payload
 * when a person has been asked (not an error, so not a problem), else the
 * `403` problem from {@link gateRefusalProblem}.
 *
 * @param c - The request being answered.
 * @param decision - The gate's decision, any outcome but `allowed`.
 * @returns The response.
 */
export function gateResponse(
  c: Context,
  decision: Exclude<TierEnforcementDecision, { outcome: 'allowed' }>
): Response {
  if (decision.outcome === 'approval_required') return c.json(decision.payload, 202);
  return sendProblem(c, gateRefusalProblem(decision.payload));
}
