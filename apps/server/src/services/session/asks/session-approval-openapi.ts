/** Contracts for per-request runtime approval confirmation. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  ApprovalRequestSchema,
  BatchApprovalRequestSchema,
  ErrorResponseSchema,
} from '@dorkos/shared/schemas';
import { StepUpRequiredBodySchema } from '@dorkos/shared/step-up';

/** Register individual and batch runtime-tool grants. */
export function registerSessionApprovalOpenApi(registry: OpenAPIRegistry): void {
  const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
  const failure = (description: string) => ({ description, content: json(ErrorResponseSchema) });
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
      400: failure('Validation error'),
      403: failure('Only a person may answer; standing yeses are refused from Wi-Fi'),
      404: failure('No pending approval'),
      409: failure('The pending interaction was already resolved'),
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
      400: failure('Validation error'),
      403: failure(
        'Only a person may answer; remote multi-item batches need separate confirmations'
      ),
      404: failure('No pending approval'),
      428: confirmation,
    },
  });
}
