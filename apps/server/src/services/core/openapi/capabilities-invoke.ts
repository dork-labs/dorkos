/**
 * The OpenAPI entry for `POST /api/capabilities/{id}/invoke`, the generic door
 * onto every capability (ADR 261123-170830). Each capability's own REST path is
 * projected beside it (`capabilities/openapi-projection.ts`); both run the same
 * dispatcher (`routes/capability-dispatch.ts`), so the statuses below hold for both.
 *
 * @module services/core/openapi/capabilities-invoke
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

/** A refusal: a sentence and, usually, a code. */
const InvokeErrorSchema = z
  .object({
    error: z.string().describe('What went wrong, in one sentence.'),
    code: z.string().optional().describe('A stable code, e.g. `UNKNOWN_CAPABILITY`.'),
  })
  .loose();

/** What a call that waits on a person answers with. */
const InvokeApprovalRequiredSchema = z
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
  .loose();

/**
 * Register the invoke endpoint on the document.
 *
 * @param registryDoc - The zod-to-openapi document registry.
 */
export function registerInvokeOperation(registryDoc: OpenAPIRegistry): void {
  const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
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
      202: {
        description: 'A person must allow the call first; nothing ran',
        content: json(InvokeApprovalRequiredSchema),
      },
      400: {
        description: 'The input failed the capability’s schema, or the capability refused it',
        content: json(InvokeErrorSchema),
      },
      403: {
        description:
          'Refused: the caller may not run it, a Wi-Fi sign-in asked for an action, or the ' +
          'capability refused this caller',
        content: json(InvokeErrorSchema),
      },
      404: {
        description: 'No capability has that id, or the thing it names was not found',
        content: json(InvokeErrorSchema),
      },
      503: {
        description: 'The server is still starting, or the extension that owns the tool is stopped',
        content: json(InvokeErrorSchema),
      },
    },
  });
}
