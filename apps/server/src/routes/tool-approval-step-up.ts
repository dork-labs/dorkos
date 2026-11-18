/** Remote runtime-tool approvals, bound to the full pending request. */
import type { Context } from 'hono';
import type { AlwaysAllowBreadth } from '@dorkos/shared/schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import {
  grantsPower,
  refuseApprovalYesFromWifi,
} from '../services/core/approvals/model/approval-answer-policy.js';
import { toolApprovalHash } from '../services/core/approvals/model/tool-approval-binding.js';
import type { StepUpCommitResult } from '../services/core/auth/step-up/step-up-holds.js';
import { peekProjector } from '../services/session/session-state-projector.js';
import { deskGoesOnWithoutSheet, holdForStepUp } from './step-up-guard.js';

/** Refuse a pending request that changed while its confirmation was open. */
export const DIFFERENT_TOOL_APPROVAL: StepUpCommitResult = {
  status: 409,
  body: {
    code: 'different-request',
    error: 'That confirmation was for a different request. Confirm this one.',
  },
};

/** Read a stable hash for the pending tool calls, or none once any is gone. */
export function pendingToolApprovalHash(
  sessionId: string,
  ids: readonly string[]
): string | undefined {
  if (ids.length !== 1) return undefined;
  const projector = peekProjector(sessionId);
  const request = projector
    ?.getPendingInteractions()
    .find((entry) => entry.id === ids[0] && entry.type === 'approval');
  return projector && request?.type === 'approval'
    ? toolApprovalHash(projector.streamGeneration, request)
    : undefined;
}

/** Confirm standing rules at every location; a one-time tool answer is session-scoped. */
export function holdRemoteToolApproval(
  c: Context<ApiEnv>,
  action: {
    sessionId: string;
    ids: readonly string[];
    always?: boolean;
    breadth?: AlwaysAllowBreadth;
  },
  run: (facts: RequestFacts, hash: string) => Promise<StepUpCommitResult>
): Response | undefined {
  const facts = honoRequestFacts(c);
  const wifi = refuseApprovalYesFromWifi(facts);
  if (wifi) return c.json(wifi, 403);
  if (!grantsPower({ kind: action.always ? 'runtime-tool-always' : 'runtime-tool-once' }))
    return undefined;
  if (deskGoesOnWithoutSheet(facts)) return undefined;
  if (facts.user && (facts.user.credential !== 'cookie' || !facts.user.sessionId)) {
    return c.json({ error: 'Sign in to DorkOS to decide an approval.', code: 'not-a-person' }, 403);
  }
  const hash = pendingToolApprovalHash(action.sessionId, action.ids);
  if (!hash) return c.json({ error: 'No pending approval', code: 'NO_PENDING_APPROVAL' }, 404);
  const pending = peekProjector(action.sessionId)!.getPendingInteractions();
  const reason = action.ids
    .map((id) => {
      const entry = pending.find((item) => item.id === id);
      if (entry?.type !== 'approval') return '';
      return [entry.title ?? entry.displayName ?? entry.toolName, entry.description, entry.input]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
  return holdForStepUp(c, {
    kind: action.always ? 'approval.grant-always' : 'approval.grant',
    target: action.sessionId,
    input: {
      sessionId: action.sessionId,
      ids: action.ids,
      always: action.always ?? false,
      breadth: action.breadth ?? 'tool',
    },
    binding: { hash, currentHash: () => pendingToolApprovalHash(action.sessionId, action.ids) },
    reason,
    notes: action.always
      ? [
          action.breadth === 'server'
            ? 'Always allow every tool from this server, including future tools.'
            : 'Always allow this tool.',
        ]
      : [],
    commit: (facts) => run(facts, hash),
  });
}
