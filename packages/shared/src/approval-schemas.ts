/**
 * Zod schemas for the approval primitive — the shape of a pending approval as
 * the cockpit sees it, and the two events that announce one (spec
 * `agent-trust` §3.3).
 *
 * Nothing here carries token material: a pending approval is safe to broadcast
 * to every connected client, and the secret the requester holds never appears
 * in an event, a list response, or a log line.
 *
 * @module shared/approval-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { CAPABILITY_TIERS } from './capabilities.js';

extendZodWithOpenApi(z);

/**
 * Longest summary an approval card will ever hold.
 *
 * A card has to be readable at a glance, and a requester supplies the sentence —
 * so the length is capped where it is stored rather than trusted at render time.
 * `ApprovalService.request` truncates to this, so a long summary shortens instead
 * of producing a row the cockpit cannot parse.
 */
export const APPROVAL_SUMMARY_MAX_LENGTH = 500;

/**
 * An approval waiting on a person: what would run, why, and who asked. This is
 * exactly what the cockpit's approval card renders.
 */
export const PendingApprovalSchema = z
  .object({
    /** ULID identifying the approval. Carries no secret. */
    approvalId: z.string(),
    /** Capability the request would invoke, e.g. `marketplace.uninstall`. */
    capabilityId: z.string(),
    /** Human-facing capability title. */
    capabilityTitle: z.string(),
    /** Permission tier of the capability being requested. */
    tier: z.enum(CAPABILITY_TIERS),
    /** One plain sentence describing what would happen. */
    summary: z.string().max(APPROVAL_SUMMARY_MAX_LENGTH),
    /** Opaque label for who asked, when the request carried one. */
    requestedBy: z.string().optional(),
    /** When the request was made. ISO 8601 UTC. */
    requestedAt: z.string(),
    /** When the request stops being honored. ISO 8601 UTC. */
    expiresAt: z.string(),
  })
  .openapi('PendingApproval');

/** An approval waiting on a person. */
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

/** Response body of `GET /api/approvals/pending`. */
export const PendingApprovalsResponseSchema = z
  .object({
    approvals: z.array(PendingApprovalSchema),
  })
  .openapi('PendingApprovalsResponse');

/** Response body of `GET /api/approvals/pending`. */
export type PendingApprovalsResponse = z.infer<typeof PendingApprovalsResponseSchema>;

/**
 * How a pending approval ended. `expired` is reported when a token is presented
 * after its window closed, so the cockpit can retire a stale card even though
 * nobody clicked anything.
 */
export const APPROVAL_OUTCOMES = ['granted', 'denied', 'expired', 'consumed'] as const;

/** How a pending approval ended. */
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

/** Request body of `POST /api/approvals/:id/deny`. */
export const DenyApprovalBodySchema = z
  .object({
    /** Optional note the requester sees instead of a bare refusal. */
    reason: z.string().max(1024).optional(),
  })
  .openapi('DenyApprovalBody');

/** Request body of `POST /api/approvals/:id/deny`. */
export type DenyApprovalBody = z.infer<typeof DenyApprovalBodySchema>;

/** Response body of the grant and deny endpoints. */
export const ApprovalDecisionResponseSchema = z
  .object({
    ok: z.literal(true),
    /** ULID of the approval that was decided. */
    approvalId: z.string(),
    /** The decision that was recorded. */
    outcome: z.enum(['granted', 'denied']),
  })
  .openapi('ApprovalDecisionResponse');

/** Response body of the grant and deny endpoints. */
export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponseSchema>;
