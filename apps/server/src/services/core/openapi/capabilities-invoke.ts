/**
 * What the OpenAPI document says every capability door answers: the standard
 * responses of the capability dispatcher (`routes/capability-dispatch.ts`),
 * on each capability's own REST path (`capabilities/openapi-projection.ts`)
 * and on `POST /api/capabilities/{id}/invoke`, the generic door onto all of
 * them (ADR 261123-170830), which this module also registers.
 *
 * Error bodies use the existing `ErrorResponse` shape; the problem shape (ADR
 * 261123-170831) replaces it in a change of its own.
 *
 * @module services/core/openapi/capabilities-invoke
 */
import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ErrorResponseSchema } from '@dorkos/shared/schemas';

/** What a call that waits on a person answers with. */
const ApprovalRequiredSchema = z
  .object({
    status: z.literal('approval_required'),
    capabilityId: z.string(),
    approvalId: z.string().describe('The approval a person decides.'),
    approvalToken: z
      .string()
      .describe('Send it back in the `X-DorkOS-Approval` header once a person allows the call.'),
    expiresAt: z.string(),
    message: z.string(),
  })
  .loose()
  .openapi('CapabilityApprovalRequired');

/** A JSON body of the given schema. */
const json = (schema: z.ZodType) => ({ 'application/json': { schema } });

/** One error response in the `ErrorResponse` shape. */
const error = (description: string) => ({ description, content: json(ErrorResponseSchema) });

/**
 * The responses the capability dispatcher answers on every door besides the
 * capability's own success: 202 approval, 400, 403, 404, 500 and 503.
 *
 * @returns A fresh `responses` map to spread beside the success entry.
 */
export function capabilityStandardResponses(): RouteConfig['responses'] {
  return {
    202: {
      description: 'A person must allow the call first; nothing ran',
      content: json(ApprovalRequiredSchema),
    },
    400: error('The input failed the capability’s schema, or the capability refused it'),
    403: error(
      'Refused: the caller may not run it, a network sign-in asked for an action, or the ' +
        'capability refused this caller'
    ),
    404: error('Not available on this computer, or the thing it names was not found'),
    500: error('Something went wrong running it'),
    503: error('The server is still starting, or the extension that owns the tool is stopped'),
  };
}

/**
 * Register the invoke endpoint on the document.
 *
 * @param registryDoc - The zod-to-openapi document registry.
 */
export function registerInvokeOperation(registryDoc: OpenAPIRegistry): void {
  registryDoc.registerPath({
    method: 'post',
    path: '/api/capabilities/{id}/invoke',
    operationId: 'capabilities.invoke',
    tags: ['Capabilities'],
    summary: 'Run any capability by id',
    description:
      'Runs one capability with the body as its input, through the same permission check, ' +
      'audit record and approval as its MCP tool, its CLI verb and its own REST path. ' +
      '`GET /api/capabilities/catalog` lists the ids and each input schema. A call that needs ' +
      'a person answers 202; retry it with the same body and the `X-DorkOS-Approval` header ' +
      'once they allow it.',
    request: {
      params: z.object({ id: z.string().describe('The capability id, e.g. `agent.pause`.') }),
      headers: z.object({
        'x-dorkos-approval': z
          .string()
          .optional()
          .describe('The approval token from an earlier 202, on the retry.'),
      }),
      body: {
        required: false,
        content: json(
          z.record(z.string(), z.unknown()).describe("The capability's input; empty means `{}`.")
        ),
      },
    },
    responses: {
      200: { description: "The capability's result", content: json(z.unknown()) },
      ...capabilityStandardResponses(),
    },
  });
}
