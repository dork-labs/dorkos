/** Approval route contracts, including individual person-requested hook reviews. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse } from '../openapi/problem-openapi.js';
import { StepUpRequiredBodySchema } from '@dorkos/shared/step-up';
import {
  PendingApprovalsResponseSchema,
  ApprovalFullDetailResponseSchema,
  DenyApprovalBodySchema,
  GrantApprovalBodySchema,
  ApprovalDecisionResponseSchema,
  DeclinedHookApprovalsResponseSchema,
} from '@dorkos/shared/approval-schemas';

/** Register approval reads and person-only answers. */
export function registerApprovalsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/approvals/pending',
    tags: ['Approvals'],
    summary: 'List approvals waiting on a person',
    description:
      'Approvals an agent has requested and nobody has decided yet, oldest first. Expired requests ' +
      'are excluded, and no response here ever carries token material.',
    responses: {
      200: {
        description: 'Pending approvals',
        content: { 'application/json': { schema: PendingApprovalsResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/approvals/{id}/full-detail',
    tags: ['Approvals'],
    summary: 'Read everything a pending Marketplace card is about',
    description:
      'The full list behind a Marketplace summary card (DOR-3070): every reinstall or install and ' +
      'everything it would run, written out whole and swept for secrets, as the approval is bound ' +
      'to it. Only while the card is pending; 404 for any other approval.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'The full list',
        content: { 'application/json': { schema: ApprovalFullDetailResponseSchema } },
      },
      404: problemResponse('`not_found`: no pending card with a full list'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/approvals/{id}/grant',
    tags: ['Approvals'],
    summary: 'Allow the requested action',
    description:
      'Grants a pending approval so the requester can spend its token once, on exactly the ' +
      'capability and input the approval is bound to. Deciding is the human half of the gate, and it ' +
      'needs proof of a person rather than the absence of proof of a machine: a caller presenting an ' +
      'agent identity (`X-DorkOS-Agent`) or an approval token (`X-DorkOS-Approval`) is refused in ' +
      'every posture, and when local login is enabled an authenticated user is required. With login ' +
      'disabled DorkOS cannot tell the app apart from a local script, so every decision is ' +
      'recorded in the Activity feed with the posture it was made under.\n\n' +
      "`answer: 'always'` also sets this action to Allowed for the agent that asked, written " +
      'through the same permission service Settings uses, before the agent is told the answer, so ' +
      'the resumed call and the new setting agree. It records its own `permission.changed` event ' +
      'beside the `permission.answered` event every answer records. It is refused (409 ' +
      '`always_not_offered`) when DorkOS does not know which agent asked, the action has no ' +
      'permission area, or the area is one that is never Allowed (Safety limits, Permissions, Reach ' +
      '& secrets). The pending card says so in advance as `alwaysOffered`. A refusal comes before ' +
      'anything is granted. Away from this computer, a yes needs fresh confirmation for this request. ' +
      'Denying does not ask for confirmation.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: GrantApprovalBodySchema } } },
    },
    responses: {
      200: {
        description: 'Approval granted',
        content: { 'application/json': { schema: ApprovalDecisionResponseSchema } },
      },
      403: problemResponse(
        '`person_only`: an agent cannot decide, nor can the caller holding the approval token, ' +
          'and with login on only a person signed in to the DorkOS app can. `owner_only`: a paid ' +
          'run, and the caller is not the owner. `not_from_wifi`: a yes from Wi-Fi'
      ),
      401: problemResponse('`unauthenticated`: login is enabled and the caller is not signed in'),
      404: problemResponse('`not_found`: no such approval'),
      409: problemResponse(
        "`already_resolved`: already decided. `always_not_offered`: `answer: 'always'` on an " +
          'approval that does not offer it, or a paid run. `spend_limit_reached`: the monthly ' +
          'limit stopped a paid run. `conflict`: a card that can only be declined. Nothing is granted'
      ),
      428: {
        description: 'Confirm this approval with the held step-up action; nothing granted yet',
        content: { 'application/json': { schema: StepUpRequiredBodySchema } },
      },
      410: problemResponse('`expired`: it expired before it was decided'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/approvals/{id}/deny',
    tags: ['Approvals'],
    summary: 'Refuse the requested action',
    description:
      'Denies a pending approval, with an optional reason the requester sees. Who may decide is ' +
      'exactly as for grant: no agent identity, no approval token, and an authenticated user when ' +
      'local login is enabled.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: DenyApprovalBodySchema } } },
    },
    responses: {
      200: {
        description: 'Approval denied',
        content: { 'application/json': { schema: ApprovalDecisionResponseSchema } },
      },
      403: problemResponse(
        '`person_only`: an agent cannot decide, nor can the caller holding the approval token'
      ),
      401: problemResponse('`unauthenticated`: login is enabled and the caller is not signed in'),
      400: problemResponse('`invalid_request`: the body failed its checks'),
      404: problemResponse('`not_found`: no such approval'),
      409: problemResponse('`already_resolved`: already decided'),
      410: problemResponse('`expired`: it expired before it was decided'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/approvals/{id}/dismiss-suggestion',
    tags: ['Approvals'],
    summary: 'Stop suggesting Always allow',
    description:
      '"Not now" on a card that suggests Always allow: the suggestion never comes back for this ' +
      'agent and action. Recorded as a `permission.suggestion_dismissed` Activity event. Who may ' +
      'call it is exactly as for grant.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'The suggestion is off for this agent and action',
        content: {
          'application/json': {
            schema: z.object({ ok: z.literal(true), approvalId: z.string() }),
          },
        },
      },
      401: problemResponse('`unauthenticated`: login is enabled and the caller is not signed in'),
      403: problemResponse(
        '`person_only`: an agent cannot decide, nor can the caller holding the approval token'
      ),
      404: problemResponse('`not_found`: no such approval'),
      409: problemResponse('`always_not_offered`: this request never suggests Always allow'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/approvals/declined-hooks',
    tags: ['Approvals'],
    summary: 'Read individual declined hook requests',
    description: 'Person-only history. No tokens or saved full request objects are returned.',
    responses: {
      200: {
        description: 'Declined hook requests',
        content: { 'application/json': { schema: DeclinedHookApprovalsResponseSchema } },
      },
      401: problemResponse('`unauthenticated`: sign-in required'),
      403: problemResponse('`person_only`: a person must read this history'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/approvals/{id}/ask-again',
    tags: ['Approvals'],
    summary: 'Request a fresh review of one declined hook request',
    description:
      'Person-only, under the same authority checks as grant and deny. Rebuilds the current package request. Keeps the original denial and existing refusal until a fresh yes. Never grants permission or returns a token. No bulk action exists.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Fresh review requested',
        content: {
          'application/json': { schema: z.object({ ok: z.literal(true), approvalId: z.string() }) },
        },
      },
      401: problemResponse('`unauthenticated`: sign-in required'),
      403: problemResponse('`person_only`: only a person may ask again'),
      409: problemResponse(
        '`already_resolved`: already asked again. `conflict`: the request cannot be rebuilt'
      ),
    },
  });
}
