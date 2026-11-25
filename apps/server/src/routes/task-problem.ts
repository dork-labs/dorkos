/**
 * Scheduled-task refusals, answered as problem documents (DOR-4979).
 *
 * The task services build their refusals as `{ error, code, ...facts }`
 * because the MCP tools (`tasks_create`, `tasks_update`) answer with the same
 * objects. This module is the HTTP edge of that: it maps each service code to
 * a code on the problem list, sends the sentence as `detail`, and carries the
 * remaining facts (`fields`, `message`, `ownedBy`, `accountId` …) as extension
 * members, where the app reads them.
 *
 * @module routes/task-problem
 */
import type { Context } from 'hono';
import { problem, sendProblem, validationProblemBody, type ProblemStatus } from '@dorkos/http-kit';
import type { ProblemCode, ProblemIssues } from '@dorkos/shared/problem';

/** Each task service code, as the problem code it answers with. */
const TASK_PROBLEM_CODES: Readonly<Record<string, ProblemCode>> = {
  // Who is asking.
  operator_only_task_field: 'person_only',
  person_only: 'person_only',
  owner_only: 'owner_only',
  operator_cookie_required: 'person_only',
  NOT_FROM_WIFI: 'not_from_wifi',
  not_your_agent: 'forbidden',
  not_your_schedule: 'forbidden',
  PROTECTED_FOLDER: 'protected_folder',
  // The request itself.
  unknown_task_field: 'invalid_request',
  unsupported_task_mode: 'invalid_request',
  trial_mode_unknown: 'invalid_request',
  undo_needs_notice: 'invalid_request',
  approve_needs_cap: 'invalid_request',
  task_rules_unsupported_runtime: 'invalid_request',
  task_rule_too_broad: 'invalid_request',
  UNSUPPORTED_MODEL: 'invalid_request',
  STICKY_ACCOUNT_LOCKED: 'invalid_request',
  // The state it met.
  looser_than_requested_confirmation_required: 'conflict',
  trial_looser_than_proposal: 'conflict',
  schedule_review_changed: 'precondition_failed',
  schedule_package_owned: 'schedule_package_owned',
  schedule_project_copy: 'conflict',
  schedule_file_unreadable: 'conflict',
  account_not_allowed_here: 'account_not_allowed_here',
  nothing_to_undo: 'conflict',
  file_changed_since: 'precondition_failed',
};

/** The code a refusal with no mapped code answers with, by its status. */
function codeForStatus(status: number): ProblemCode {
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'internal_error';
  return 'invalid_request';
}

/**
 * What a task's file fault says over HTTP. The service's own sentence names
 * the file's path, which stays in the MCP answer and the log, never here.
 */
const TASK_FILE_FAULT = 'DorkOS couldn’t read or save the task’s file. Try again.';

/** The refusal facts that ride as extension members: what the app and CLI read. */
const TASK_PROBLEM_FACTS = new Set(['fields', 'message', 'ownedBy', 'accountId']);

/** What a request naming a schedule that is not there is told. */
export const TASK_NOT_FOUND = 'No scheduled task has that id.';

/**
 * A refusal as a task service builds it: `error` (the sentence), an optional
 * `code`, an optional flattened Zod failure as `details`, and any other facts
 * the caller acts on.
 */
export type TaskRefusalBody = object;

/**
 * Answer a task service's refusal as a problem document.
 *
 * @param c - The Hono context.
 * @param body - The refusal, as the service built it.
 * @param status - The status the service chose.
 * @returns The response.
 */
export function taskProblem(c: Context, body: TaskRefusalBody, status: ProblemStatus): Response {
  const { error, code, details, ...facts } = body as Record<string, unknown>;
  if (isFlattened(details)) return sendProblem(c, validationProblemBody(details, { status }));
  const mapped = (typeof code === 'string' && TASK_PROBLEM_CODES[code]) || codeForStatus(status);
  // Only the facts a caller acts on, and none on a fault: a service's body can
  // also hold a project root or a thrown message, which a problem never carries.
  const extensions =
    status >= 500
      ? {}
      : Object.fromEntries(
          Object.entries(facts).filter(
            ([key, value]) => value !== undefined && TASK_PROBLEM_FACTS.has(key)
          )
        );
  return problem(c, mapped, {
    ...(status >= 500
      ? { detail: TASK_FILE_FAULT }
      : typeof error === 'string' && { detail: error }),
    status,
    ...(Object.keys(extensions).length > 0 && { extensions }),
  });
}

/** Whether a refusal's `details` is a Zod failure in its flattened form. */
function isFlattened(details: unknown): details is ProblemIssues {
  return (
    typeof details === 'object' &&
    details !== null &&
    'fieldErrors' in details &&
    'formErrors' in details
  );
}
