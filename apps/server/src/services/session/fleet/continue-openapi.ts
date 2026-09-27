/**
 * OpenAPI entries for the out-of-usage routes (spec `claude-account-fleet` D9):
 * `continue-options`, `continue`, `wait` and `continue/cancel`, projected from
 * the same schemas the routes parse and answer with.
 *
 * @module services/session/fleet/continue-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  ContinueOptionsResponseSchema,
  ContinueSessionRequestSchema,
  ContinueSessionResponseSchema,
  ErrorResponseSchema,
  LimitPlanResponseSchema,
  WaitForResetRequestSchema,
} from '@dorkos/shared/schemas';

const params = z.object({ id: z.string().uuid() });
const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const noLimit = error('The session has not run out of usage, so there is nothing to change.');
const peopleOnly = error('Only a person can move or hold a session; an agent identity is refused.');
const flowUnreachable = error(
  'The session is held by the account advisor (a Flow run), and it could not be reached, so nothing changed.'
);

/**
 * Register the four out-of-usage routes on the OpenAPI registry.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerSessionContinueOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/sessions/{id}/continue-options',
    tags: ['Sessions'],
    summary: 'List the accounts a session that ran out of usage could continue on',
    description:
      "The session's current plan, and the accounts to offer in order, each with its usage and a plain-words reason. The account that ran out is left out. `advised` says whether the account advisor's ranking was used. A person may pick any listed account, including one marked not eligible.",
    request: { params },
    responses: {
      200: {
        description: 'The plan and the ranked accounts.',
        content: { 'application/json': { schema: ContinueOptionsResponseSchema } },
      },
      400: error('The session id is not valid.'),
      403: peopleOnly,
      409: noLimit,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/sessions/{id}/continue',
    tags: ['Sessions'],
    summary: 'Continue a session that ran out of usage, on another account or model',
    description:
      "With `account`: the work carries over to a new session on that account, in the same folder, seeded with where the old one stopped; the answer names the new session, and a second call for the same limit answers with the same one. `runtime` (default: the session's own) moves it to another runtime, only when the account advisor offered that runtime's account; that session starts with the other runtime's own model and effort, and never with more permission than the old one had (full autonomy is not carried over). With only `model`: the same session switches to that model and continues. A session the account advisor claimed (a Flow run) is handed to the advisor, and the answer has no `sessionId` until the advisor reports the new session; the session's plan shows the handoff meanwhile. A session that did not start here (a room, a schedule, a chat binding) can only wait (409).",
    request: {
      params,
      body: { content: { 'application/json': { schema: ContinueSessionRequestSchema } } },
    },
    responses: {
      202: {
        description: 'Accepted.',
        content: { 'application/json': { schema: ContinueSessionResponseSchema } },
      },
      400: error(
        'Neither an account nor a model, an unknown account, a runtime the advisor did not offer, or a model the runtime does not offer.'
      ),
      403: peopleOnly,
      409: error(
        'The session has no limit, is working, or did not start here and can only wait for the reset.'
      ),
      503: flowUnreachable,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/sessions/{id}/wait',
    tags: ['Sessions'],
    summary: 'Wait for the account to reset',
    description:
      "The plan becomes `waiting` until the account's usage resets. `autoResume` (allowed only for a session that started here) continues it by itself once the reset is confirmed; it defaults to the advisor's own choice, else off.",
    request: {
      params,
      body: { content: { 'application/json': { schema: WaitForResetRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The new plan.',
        content: { 'application/json': { schema: LimitPlanResponseSchema } },
      },
      400: error('`autoResume` was asked for a session that can only wait.'),
      403: peopleOnly,
      409: error('The session has no limit, or its work already moved or is moving.'),
      503: flowUnreachable,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/sessions/{id}/continue/cancel',
    tags: ['Sessions'],
    summary: 'Cancel a pending handoff to another account',
    description:
      'An `auto` plan goes back to asking the person. Too late once the automatic move has started (409).',
    request: { params },
    responses: {
      200: {
        description: 'The new plan.',
        content: { 'application/json': { schema: LimitPlanResponseSchema } },
      },
      403: peopleOnly,
      409: error('The session has no limit, no handoff is pending, or the move already started.'),
      503: flowUnreachable,
    },
  });
}
