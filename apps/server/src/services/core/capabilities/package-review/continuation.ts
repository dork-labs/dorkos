/**
 * Carry one permission-card grant through the package content-card retry.
 * DOR-4868 removes the outer card and this entire temporary mechanism.
 * When DOR-4868 removes this helper, the registry.ts entry must return and
 * registry.ts must call enforceCapabilityTier directly again.
 * @module services/core/capabilities/package-review/continuation
 */
import { hashApprovalInput } from '../../approvals/index.js';
import { enforceCapabilityTier, type GrantedApproval } from '../tier-enforcement.js';

interface Scope {
  capabilityId: string;
  sessionId?: string;
  agentPath?: string;
  input: unknown;
}
interface Continuation {
  approval: Extract<GrantedApproval, { via: 'approval' }>;
  tokenHash: string;
  expiresAt: number;
}

/** Only these two actions may change this one top-level key between the two cards. */
function keyOf(scope: Scope): string | undefined {
  if (
    (scope.capabilityId !== 'marketplace.install' && scope.capabilityId !== 'marketplace.update') ||
    !scope.sessionId ||
    !scope.agentPath
  )
    return undefined;
  if (!scope.input || typeof scope.input !== 'object' || Array.isArray(scope.input))
    return undefined;
  const input = Object.fromEntries(
    Object.entries(scope.input).filter(([key]) => key !== 'confirmationToken')
  );
  return hashApprovalInput({
    capabilityId: scope.capabilityId,
    sessionId: scope.sessionId,
    agentPath: scope.agentPath,
    input,
  });
}

/** A registry owns its own bounded, short-lived continuation records. */
export function createPackageReviewContinuations() {
  const records = new Map<string, Continuation>();
  const requests = new Map<string, { key: string; expiresAt: number }>();
  const continuations = {
    asked(scope: Scope, approvalId: string, expiresAt: string): void {
      const key = keyOf(scope);
      if (!key) return;
      requests.set(approvalId, { key, expiresAt: new Date(expiresAt).getTime() });
      if (requests.size > 1000) requests.delete(requests.keys().next().value!);
    },
    take(scope: Scope): Continuation | undefined {
      const key = keyOf(scope);
      if (!key) return undefined;
      const record = records.get(key);
      if (!record) return undefined;
      if (record.expiresAt <= Date.now()) {
        records.delete(key);
        return undefined;
      }
      const token = (scope.input as Record<string, unknown>).confirmationToken;
      if (typeof token !== 'string' || hashApprovalInput(token) !== record.tokenHash)
        return undefined;
      records.delete(key);
      return record;
    },
    remember(
      scope: Scope,
      result: unknown,
      approval: GrantedApproval | undefined,
      previous?: Continuation
    ): void {
      if (approval?.via !== 'approval') return;
      const key = keyOf(scope);
      if (!key || !result || typeof result !== 'object') return;
      const pending = result as { status?: unknown; confirmationToken?: unknown };
      if (
        pending.status !== 'requires_confirmation' ||
        typeof pending.confirmationToken !== 'string'
      )
        return;
      const request = requests.get(approval.approvalId);
      if (!previous && request?.key !== key) return;
      const expiresAt = previous?.expiresAt ?? request!.expiresAt;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
      requests.delete(approval.approvalId);
      records.set(key, {
        approval,
        tokenHash: hashApprovalInput(pending.confirmationToken),
        expiresAt,
      });
      if (records.size > 1000) records.delete(records.keys().next().value!);
    },
  };
  return {
    ...continuations,
    /** The ordinary gate, plus the one-shot continuation for DOR-4868. */
    gate(request: Parameters<typeof enforceCapabilityTier>[0]) {
      const scope = {
        capabilityId: request.action.id,
        input: request.input,
        sessionId: request.requestingSession?.sessionId,
        agentPath: request.identity?.agentPath,
      };
      const previous = request.permission?.state === 'ask' ? continuations.take(scope) : undefined;
      const decision = previous
        ? { outcome: 'allowed' as const, approval: previous.approval }
        : enforceCapabilityTier(request);
      if (
        decision.outcome === 'approval_required' &&
        decision.payload.reason !== 'awaiting_decision'
      ) {
        continuations.asked(scope, decision.payload.approvalId, decision.payload.expiresAt);
      }
      return {
        decision,
        remember: (result: unknown, approval: GrantedApproval | undefined) =>
          continuations.remember(scope, result, approval, previous),
      };
    },
  };
}
