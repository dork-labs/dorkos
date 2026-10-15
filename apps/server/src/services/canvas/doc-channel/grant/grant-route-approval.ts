import {
  requireOriginalCheckboxGrantTransaction,
  type OriginalCheckboxGrantPreparation,
} from '../writes/checkbox/checkbox-grant-preparation.js';
import { ulid } from 'ulidx';
import { APPROVAL_DETAIL_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
import { hashApprovalInput } from '../../../core/approvals/approval-input-hash.js';
import type { ApprovalConsumptionSettlement } from '../../../core/approvals/approval-service.js';
import { type DocRouteGrantRequest } from '../grant-policy.js';
import { eq, approvals } from '@dorkos/db';
import { type DocGrantRow } from '../store.js';
import { DocRouteGrantError, type DocGrantActor } from '../grant-policy.js';
import { copyCurrentDocData } from '../current/current-operation-data.js';
import { readOriginalGrantCreationView } from '../grant-revalidation.js';
import type { DocGrantResult } from './grant-private-contracts.js';

/** Enable opener self/log authority or request/consume an exact operator verdict atomically. */
export function grant(
  grantOwner: object,
  request: DocRouteGrantRequest,
  actor: DocGrantActor,
  approvalToken?: string
): DocGrantResult {
  const facet = readOriginalGrantCreationView(grantOwner);
  return facet.privateGrant(request, actor, approvalToken);
}

/** Original grant responsibility, after exact private owner recognition. */
export function privateGrant(
  grantOwner: object,
  request: DocRouteGrantRequest,
  actor: DocGrantActor,
  approvalToken?: string,
  source?: OriginalCheckboxGrantPreparation
): DocGrantResult {
  const facet = readOriginalGrantCreationView(grantOwner);
  if (!source) facet.privateRefreshOriginalAuthority(request.documentId, actor);
  const settlements: ApprovalConsumptionSettlement[] = [];
  let result: DocGrantResult;
  try {
    result = facet.store.transaction((tx) => {
      if (source)
        requireOriginalCheckboxGrantTransaction(source, facet.originalOwner, tx, request, actor);
      const operation = (): DocGrantResult => {
        const prepared = facet.privatePrepare(request, actor, tx, source);
        const existing = facet.privateExisting(prepared, tx);
        if (existing) return { kind: 'granted', grant: existing };
        if (!prepared.self && !approvalToken) {
          const detail = JSON.stringify(prepared.bindingInput);
          if (detail.length > APPROVAL_DETAIL_MAX_LENGTH)
            throw new DocRouteGrantError('APPROVAL_SUBJECT_TOO_LARGE', 422);
          const ticket = facet.deps.approvals.request({
            capabilityId: facet.APPROVE_CAPABILITY,
            inputHash: prepared.inputHash,
            summary: `Allow document events on route ${prepared.route.id}.`,
            detail,
            area: null,
          });
          return { kind: 'approval_required', ticket };
        }
        let approvalId: string | null = null;
        let originalConsumedApproval: typeof approvals.$inferSelect | null = null;
        let approvedBy: string;
        let approvalEvidence: Record<string, unknown>;
        if (prepared.self) {
          approvedBy = prepared.openerAgentId!;
          approvalEvidence = {
            kind: 'verified_opener',
            inputHash: prepared.inputHash,
            binding: prepared.bindingInput,
          };
        } else {
          const verdict = facet.deps.approvals.consume(
            approvalToken!,
            {
              capabilityId: facet.APPROVE_CAPABILITY,
              inputHash: prepared.inputHash,
            },
            { deferSettlement: (settlement) => settlements.push(settlement) }
          );
          if (verdict.outcome !== 'granted')
            throw new DocRouteGrantError(`APPROVAL_${verdict.outcome.toUpperCase()}`);
          const row = tx.select().from(approvals).where(eq(approvals.id, verdict.approvalId)).get();
          if (
            !row ||
            row.state !== 'granted' ||
            row.inputHash !== prepared.inputHash ||
            !row.decidedAt ||
            !row.consumedAt
          )
            throw new DocRouteGrantError('APPROVAL_EVIDENCE_MISMATCH');
          originalConsumedApproval = copyCurrentDocData(row);
          approvalId = row.id;
          approvedBy = `approval:${row.id}`;
          approvalEvidence = {
            kind: 'operator_approval',
            approvalId,
            state: row.state,
            inputHash: row.inputHash,
            decidedAt: row.decidedAt,
            consumedAt: row.consumedAt,
            binding: prepared.bindingInput,
          };
        }
        // No async boundary between current authority, one-use consumption and source insertion.
        const finalPrepared = facet.privatePrepare(request, actor, tx, source);
        if (finalPrepared.inputHash !== prepared.inputHash)
          throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
        const grantId = ulid();
        const intendedGrant: DocGrantRow = {
          grantId,
          documentId: request.documentId,
          routeId: prepared.route.id,
          revision: 1,
          normalizedRoute: prepared.route,
          routeHash: hashApprovalInput(prepared.route),
          declarationHash: prepared.declarationHash,
          manifestHash: prepared.manifestHash,
          openerAgentId: prepared.openerAgentId ?? null,
          targetAgentId: prepared.target.agentId,
          targetSessionId: prepared.target.sessionId,
          targetRuntime: prepared.target.runtime,
          approvedBy,
          approvalId,
          approvalEvidence,
          allowedTypes: prepared.allowedTypes,
          limits: prepared.limits,
          writeOperation: request.write ?? null,
          createdAt: facet.privateNow(),
          expiresAt: request.expiresAt ?? null,
          revokedAt: null,
        };
        if (source) {
          if (facet.originalGrantInsertions.has(tx))
            throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
          facet.originalGrantInsertions.set(tx, {
            grants: facet.originalOwner,
            store: facet.deps.store,
            documentId: request.documentId,
            actor,
            grant: copyCurrentDocData(intendedGrant),
            approval: originalConsumedApproval,
          });
        }
        facet.store.insertGrant(intendedGrant, tx);
        return { kind: 'granted', grant: facet.store.getGrant(grantId, tx)! };
      };
      try {
        const selected = operation();
        if (source)
          requireOriginalCheckboxGrantTransaction(source, facet.originalOwner, tx, request, actor);
        return selected;
      } finally {
        facet.originalGrantInsertions.delete(tx);
      }
    });
  } catch (error) {
    for (const settlement of settlements) facet.deps.approvals.discardConsumption(settlement);
    throw error;
  }
  for (const settlement of settlements) facet.deps.approvals.publishConsumption(settlement);
  return result;
}
