/**
 * `approvals.withdraw`: an agent takes back a request it raised and no longer
 * needs, so its card stops waiting in front of the person (DOR-4586). Only the
 * agent that asked may, and only while nobody has answered; the rule lives in
 * `approval-withdrawal.ts`.
 *
 * Taking a request back only ever removes a question, so it never asks anyone
 * and belongs to no permission area. A person dismisses a card by answering it.
 *
 * @module services/core/approvals/approval-withdraw-capability
 */
import { z } from 'zod';
import type { Db } from '@dorkos/db';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../capabilities/index.js';
import { CapabilityToolError } from '../capabilities/mcp-envelope.js';
import { WITHDRAW_REFUSALS, withdrawOwnApproval } from './approval-withdrawal.js';

declare module '../capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Present when the server keeps approvals; gates the `approvals` domain. */
    approvalWithdrawDeps?: {
      /** The DorkOS database the approvals table lives in. */
      db: Db;
    };
  }
}

/** What the tool answers when DorkOS can't tell which agent is asking. */
export const UNIDENTIFIED_WITHDRAW_MESSAGE =
  "DorkOS can't tell which agent is asking, so it can't take a request back for it.";

/** The calling agent's verified home, or a refusal when there is none. */
function requesterOf(context: CapabilityHandlerContext): string {
  const agentPath = context.identity?.agentPath;
  if (!agentPath) {
    throw new CapabilityToolError({ error: UNIDENTIFIED_WITHDRAW_MESSAGE, code: 'unidentified' });
  }
  return agentPath;
}

/** Withdraw a request the calling agent raised. */
export const withdrawApprovalRequest = defineCapability({
  id: 'approvals.withdraw',
  title: 'Take back a request',
  description:
    'Take back a request you raised that a person has not answered yet, once you no longer ' +
    'need it. Its card goes away everywhere the person sees it, and the audit log records ' +
    'that you took it back. Pass the approvalId you were given when you asked. You can take ' +
    'back only your own requests, and only while they wait.',
  tier: 'act',
  area: null,
  areaNote: 'taking a request back only removes a question; it never does anything',
  input: z
    .object({
      approvalId: z.string().min(1).describe('The request: the approvalId you were given.'),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe('Why you no longer need it, in a sentence, for the audit log.'),
    })
    .strict(),
  output: z.object({ status: z.literal('withdrawn'), approvalId: z.string(), title: z.string() }),
  surfaces: {
    mcp: { toolName: 'withdraw_approval_request', servers: ['in-session', 'external'] },
  },
  invoke: async (deps, input, context) => {
    const db = deps.approvalWithdrawDeps?.db;
    // Unreachable once composed: `assertDeps` refuses a registry without it.
    if (!db) throw new Error('The approvals capability requires approvalWithdrawDeps.');
    const result = withdrawOwnApproval(db, input.approvalId, {
      agentPath: requesterOf(context),
      ...(input.reason ? { reason: input.reason } : {}),
    });
    if (!result.ok) {
      throw new CapabilityToolError({ error: WITHDRAW_REFUSALS[result.code], code: result.code });
    }
    return { status: 'withdrawn' as const, approvalId: result.approvalId, title: result.title };
  },
});

/** The approvals domain: what an agent may do about its own requests. */
export const approvalsDomain: CapabilityDomain = {
  name: 'approvals',
  assertDeps: (deps: CapabilityDeps) => {
    if (!deps.approvalWithdrawDeps) {
      throw new Error('The approvals capability requires approvalWithdrawDeps.');
    }
  },
  capabilities: [withdrawApprovalRequest],
};
