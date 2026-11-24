/** Public experimental computer API; private endpoints and credentials are never documented. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  ComputerStatusSchema,
  ComputerSessionSchema,
  ComputerFrameSchema,
  ComputerControlLeaseSchema,
  ComputerInputSchema,
} from '@dorkos/shared/computer-schemas';
import { problemResponse } from '../core/openapi/problem-openapi.js';

const success = z.object({ ok: z.literal(true) }).strict();
const headers = z.object({
  'X-Client-Id': z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});
const response = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

/** Register only the ten routes mounted by the admitted computer surface. */
export function registerComputerOpenApi(registry: OpenAPIRegistry): void {
  const operations: {
    method: 'get' | 'post' | 'delete';
    path: string;
    summary: string;
    schema: z.ZodType;
    body?: z.ZodType;
  }[] = [
    { method: 'get', path: '', summary: 'Read computer state', schema: ComputerStatusSchema },
    { method: 'post', path: '', summary: 'Create the computer', schema: ComputerStatusSchema },
    {
      method: 'post',
      path: '/start',
      summary: 'Start the retained computer',
      schema: ComputerStatusSchema,
    },
    { method: 'post', path: '/stop', summary: 'Stop the computer', schema: ComputerStatusSchema },
    {
      method: 'post',
      path: '/sign-in',
      summary: 'Open vendor sign-in inside the computer',
      schema: ComputerStatusSchema,
    },
    {
      method: 'post',
      path: '/sessions',
      summary: 'Create a computer-bound chat',
      schema: ComputerSessionSchema,
    },
    {
      method: 'get',
      path: '/frame',
      summary: 'Read the actual desktop frame',
      schema: ComputerFrameSchema,
    },
    {
      method: 'post',
      path: '/control',
      summary: 'Take control after interrupting agent work',
      schema: ComputerControlLeaseSchema,
    },
    {
      method: 'delete',
      path: '/control',
      summary: 'Return control and release held input',
      schema: success,
      body: z.object({ leaseId: z.string().min(1).max(128) }).strict(),
    },
    {
      method: 'post',
      path: '/input',
      summary: 'Send one leased desktop action',
      schema: success,
      body: ComputerInputSchema,
    },
  ];
  for (const operation of operations)
    registry.registerPath({
      method: operation.method,
      path: `/api/computers${operation.path}`,
      tags: ['Computers'],
      summary: operation.summary,
      description:
        'Experimental local computer. Only the account owner may use this route. X-Client-Id identifies the admitted app window; it is required on reads and actions. Requests never accept guest endpoints, credentials or host paths. Control and input are bound to the app window and current generation. With login enabled, the existing login cookie is required. Errors expose a safe code, never private guest details. Stop can return cleanup-uncertain; that response does not confirm physical shutdown.',
      request: {
        headers,
        ...(operation.body
          ? {
              body: { required: true, content: { 'application/json': { schema: operation.body } } },
            }
          : {}),
      },
      responses: {
        200: response(operation.schema, 'Observed result'),
        400: problemResponse(
          'No app window (`invalid_request`), a body that fails its checks, the experiment off ' +
            '(`computer_disabled`), an unsupported host (`computer_unsupported`), or a sign-in ' +
            'needed inside it (`computer_sign_in_required`)'
        ),
        403: problemResponse('The caller is not the account owner (`person_only`, `owner_only`)'),
        409: problemResponse(
          'Control lost (`computer_control_lost`) or cleanup unconfirmed ' +
            '(`computer_cleanup_uncertain`)'
        ),
        503: problemResponse(
          'Computer unavailable or not ready (`temporarily_unavailable`), or setup failed ' +
            '(`computer_setup_failed`)'
        ),
      },
    });
}
