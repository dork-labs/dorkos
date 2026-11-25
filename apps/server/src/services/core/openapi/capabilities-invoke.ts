/**
 * What the OpenAPI document says every capability door answers: the standard
 * responses of the capability dispatcher (`routes/capability-dispatch.ts`),
 * on each capability's own REST path (`capabilities/openapi-projection.ts`)
 * and on `POST /api/capabilities/{id}/invoke`, the generic door onto all of
 * them (ADR 261123-170830), which this module also registers.
 *
 * Every error is a problem document (ADR 261123-170831); a call that waits on
 * a person is a `202` with the approval, not an error.
 *
 * @module services/core/openapi/capabilities-invoke
 */
import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse } from './problem-openapi.js';

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

/**
 * The responses the capability dispatcher answers on every door besides the
 * capability's own success: the 202 approval and every problem it can send.
 *
 * @returns A fresh `responses` map to spread beside the success entry.
 */
export function capabilityStandardResponses(): RouteConfig['responses'] {
  return {
    202: {
      description: 'A person must allow the call first; nothing ran',
      content: json(ApprovalRequiredSchema),
    },
    400: problemResponse(
      '`invalid_request`: the input failed the capability’s schema (`issues` lists each field), ' +
        'or the capability refused it'
    ),
    401: problemResponse(
      '`agent_identity_unverified`: the agent token could not be confirmed; ' +
        '`person_session_required`: a person must confirm it’s them'
    ),
    403: problemResponse(
      'Refused: `forbidden`, `declined` or `needs_approval` from the permission check (with ' +
        '`capabilityId`, `tier`, `approvable` and any `approvalId`), `not_from_wifi` for an ' +
        'action from a network sign-in, or the capability’s own refusal'
    ),
    404: problemResponse(
      '`unknown_capability`: not available on this computer; `not_found`: the thing it names'
    ),
    409: problemResponse('The capability refused because of the state it met, such as `conflict`'),
    412: problemResponse('`precondition_failed`: something changed since the caller looked'),
    500: problemResponse('`internal_error`: something went wrong running it'),
    502: problemResponse('`signin_unreachable`: the remote server did not answer'),
    503: problemResponse(
      '`temporarily_unavailable`: the server is still starting, or the tool’s extension is stopped'
    ),
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
