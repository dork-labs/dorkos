/** Approval route contracts, including individual person-requested hook reviews. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ErrorResponseSchema } from '@dorkos/shared/schemas';
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
      404: { description: 'No pending card with a full list' },
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
      '`ALWAYS_NOT_OFFERED`) when DorkOS does not know which agent asked, the action has no ' +
      'permission area, or the area is one that is never Allowed (Safety limits, Permissions, Reach ' +
      '& secrets). The pending card says so in advance as `alwaysOffered`. A refusal comes before ' +
      'anything is granted.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: GrantApprovalBodySchema } } },
    },
    responses: {
      200: {
        description: 'Approval granted',
        content: { 'application/json': { schema: ApprovalDecisionResponseSchema } },
      },
      403: {
        description:
          'Refused: an agent cannot decide (`AGENT_CANNOT_DECIDE`), and neither can the caller ' +
          'holding the approval token (`REQUESTER_CANNOT_DECIDE`). With login on, only a person ' +
          'signed in to the DorkOS app can decide (`operator_cookie_required`)',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      401: {
        description: 'Login is enabled and the caller is not signed in (`AUTH_REQUIRED`)',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      404: {
        description: 'No such approval',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      409: {
        description:
          "Already decided; or `answer: 'always'` on an approval that does not offer it " +
          '(`ALWAYS_NOT_OFFERED`). Nothing is granted in that case',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      410: {
        description: 'Expired before it was decided',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
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
      403: {
        description:
          'Refused: an agent cannot decide (`AGENT_CANNOT_DECIDE`), and neither can the caller ' +
          'holding the approval token (`REQUESTER_CANNOT_DECIDE`)',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      401: {
        description: 'Login is enabled and the caller is not signed in (`AUTH_REQUIRED`)',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      400: {
        description: 'Invalid body',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      404: {
        description: 'No such approval',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      409: {
        description: 'Already decided',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      410: {
        description: 'Expired before it was decided',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
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
      401: {
        description: 'Login is enabled and the caller is not signed in (`AUTH_REQUIRED`)',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      403: {
        description:
          'Refused: an agent cannot decide (`AGENT_CANNOT_DECIDE`), and neither can the caller ' +
          'holding the approval token (`REQUESTER_CANNOT_DECIDE`)',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      404: {
        description: 'No such approval',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      409: {
        description: 'This request never suggests Always allow (`SUGGESTION_NOT_OFFERED`)',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
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
      401: { description: 'Sign-in required' },
      403: { description: 'A person must read this history' },
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
      401: { description: 'Sign-in required' },
      403: { description: 'Only a person may ask again' },
      409: { description: 'Already asked again, or the request cannot be rebuilt' },
    },
  });
}
