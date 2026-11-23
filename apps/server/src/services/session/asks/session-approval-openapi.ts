/** Contracts for per-request runtime approval confirmation. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ApprovalRequestSchema, BatchApprovalRequestSchema } from '@dorkos/shared/schemas';
import { StepUpRequiredBodySchema } from '@dorkos/shared/step-up';
import { problemResponse } from '../../core/openapi/problem-openapi.js';

/** Register individual and batch runtime-tool grants. */
export function registerSessionApprovalOpenApi(registry: OpenAPIRegistry): void {
  const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
  const failure = problemResponse;
  const confirmation = {
    description: 'Fresh confirmation for this request is required before granting it',
    content: json(StepUpRequiredBodySchema),
  };
  registry.registerPath({
    method: 'post',
    path: '/api/sessions/{id}/approve',
    tags: ['Sessions'],
    summary: 'Approve pending tool call',
    description:
      'Away from this computer, a yes needs fresh confirmation bound to the pending request. Denying does not ask for confirmation.',
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: { content: json(ApprovalRequestSchema) },
    },
    responses: {
      200: { description: 'Approved', content: json(z.object({ ok: z.boolean() })) },
      400: failure('`invalid_request`: the body or the chat id failed its checks'),
      401: failure('`unauthenticated`: sign-in is on and nobody is signed in'),
      403: failure(
        'Only a person may answer (`person_only`, `operator_cookie_required`); a yes is refused from Wi-Fi (`not_from_wifi`)'
      ),
      404: failure('`not_found`: no request is waiting for an answer'),
      409: failure('`interaction_already_resolved`: it was already answered'),
      428: confirmation,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/sessions/{id}/batch-approve',
    tags: ['Sessions'],
    summary: 'Approve pending tool calls',
    description:
      'Desk batches keep their usual behavior. Remote callers confirm each request separately. A single-item remote batch follows the individual confirmation flow.',
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: { content: json(BatchApprovalRequestSchema) },
    },
    responses: {
      200: {
        description: 'Individual results',
        content: json(
          z.object({ results: z.array(z.object({ toolCallId: z.string(), ok: z.boolean() })) })
        ),
      },
      400: failure('`invalid_request`: the body or the chat id failed its checks'),
      401: failure('`unauthenticated`: sign-in is on and nobody is signed in'),
      403: failure(
        'Only a person may answer (`person_only`, `operator_cookie_required`); a yes is refused from Wi-Fi (`not_from_wifi`); remote multi-item batches need separate confirmations (`forbidden`)'
      ),
      404: failure('`not_found`: no request is waiting for an answer'),
      428: confirmation,
    },
  });
}
