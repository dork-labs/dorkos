import { and, isNull, eq, canvasDocGrants, type DbTransaction } from '@dorkos/db';
import {
  CanvasChannelCheckboxRequestSchema,
  matchesCanvasChannelEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../../core/approvals/approval-input-hash.js';
import type { DocChannelActor } from '../../authorization.js';
import type { DocWriteIntentRow } from '../../store.js';
import {
  VerifiedCheckboxAuthoritySchema,
  requireSameCheckboxAuthority,
  validateCheckboxEvidence,
  type CheckboxRequest,
  type VerifiedCheckboxAuthority,
} from '../checkbox-evidence.js';
import {
  CheckboxAuthorityRefusal,
  requireSameCheckboxActor,
  withCheckboxReadOnlyGate,
  type CheckboxAuthoritySnapshot,
} from './authority-snapshot.js';
import { readOriginalCheckboxAuthorityOperationView } from '../authority.js';

/** Original prepare body behind constructor-private ownership. */
export async function prepareOriginalCheckboxAuthority(
  owner: object,
  request: CheckboxRequest,
  actor: DocChannelActor
): Promise<VerifiedCheckboxAuthority> {
  const facet = readOriginalCheckboxAuthorityOperationView(owner);
  return facet.operation(async () => {
    const parsed = CanvasChannelCheckboxRequestSchema.parse(request);
    const bound = { ...actor };
    facet.outside();
    facet.transaction((tx) => facet.access(parsed.documentId, bound, tx));
    await facet.deps.authorization.require(parsed.documentId, bound, true);
    const observation = await facet.observe(parsed.documentId);
    requireSameCheckboxActor(actor, bound);
    return facet.transaction((tx) =>
      withCheckboxReadOnlyGate(facet.deps.db, () => {
        facet.access(parsed.documentId, actor, tx);
        const time = facet.now().getTime();
        const candidates = tx
          .select()
          .from(canvasDocGrants)
          .where(
            and(
              eq(canvasDocGrants.documentId, parsed.documentId),
              isNull(canvasDocGrants.revokedAt)
            )
          )
          .all()
          .filter(
            (grant) =>
              (grant.writeOperation as { operation?: unknown } | null)?.operation ===
                'checkbox-toggle' &&
              grant.allowedTypes.some((type) =>
                matchesCanvasChannelEvent(type, 'md.task.toggled')
              ) &&
              Date.parse(grant.expiresAt ?? '') > time
          );
        if (candidates.length !== 1)
          throw new CheckboxAuthorityRefusal('ORIGINAL_WRITE_GRANT_AMBIGUOUS');
        const original = candidates[0]!;
        return facet.checked(
          parsed.documentId,
          original.grantId,
          original.revision,
          observation,
          tx,
          actor
        );
      })
    );
  });
}

/** Original prepareRecovery body behind constructor-private ownership. */
export async function prepareOriginalCheckboxRecovery(
  owner: object,
  intent: DocWriteIntentRow
): Promise<VerifiedCheckboxAuthority> {
  const facet = readOriginalCheckboxAuthorityOperationView(owner);
  const approved = validateCheckboxEvidence(intent).authority;
  const snapshot = await facet.refreshRecoveryCurrent(intent, approved);
  return facet.transaction((tx) => facet.requireRecoveryCurrent(intent, approved, snapshot, tx));
}

/** Original refreshCurrent body behind constructor-private ownership. */
export async function refreshOriginalCheckboxAuthority(
  owner: object,
  request: CheckboxRequest,
  actor: DocChannelActor,
  approved: VerifiedCheckboxAuthority
): Promise<CheckboxAuthoritySnapshot> {
  const facet = readOriginalCheckboxAuthorityOperationView(owner);
  return facet.operation(async () => {
    const parsed = CanvasChannelCheckboxRequestSchema.parse(request);
    const original = VerifiedCheckboxAuthoritySchema.parse(approved);
    const bound = { ...actor };
    facet.outside();
    facet.transaction((tx) => facet.access(parsed.documentId, bound, tx));
    await facet.deps.authorization.require(parsed.documentId, bound, true);
    const observation = await facet.observe(parsed.documentId);
    requireSameCheckboxActor(actor, bound);
    facet.transaction((tx) => {
      facet.access(parsed.documentId, actor, tx);
      requireSameCheckboxAuthority(
        original,
        facet.checked(
          parsed.documentId,
          original.grantId,
          original.grantRevision,
          observation,
          tx,
          actor
        )
      );
    });
    return facet.snapshots.issue({
      subject: hashApprovalInput(parsed),
      approved: original,
      actor: actor.principal,
      surface: actor.surface,
      observation,
    });
  });
}

/** Original refreshRecoveryCurrent body behind constructor-private ownership. */
export async function refreshOriginalCheckboxRecovery(
  owner: object,
  intent: DocWriteIntentRow,
  approved: VerifiedCheckboxAuthority
): Promise<CheckboxAuthoritySnapshot> {
  const facet = readOriginalCheckboxAuthorityOperationView(owner);
  return facet.operation(async () => {
    const evidence = validateCheckboxEvidence(intent);
    requireSameCheckboxAuthority(
      evidence.authority,
      VerifiedCheckboxAuthoritySchema.parse(approved)
    );
    facet.outside();
    const observation = await facet.observe(intent.documentId);
    facet.transaction((tx) =>
      withCheckboxReadOnlyGate(facet.deps.db, () => {
        facet.editor(intent.documentId, undefined, tx, { grantId: approved.grantId });
        requireSameCheckboxAuthority(
          approved,
          facet.checked(
            intent.documentId,
            approved.grantId,
            approved.grantRevision,
            observation,
            tx
          )
        );
      })
    );
    return facet.snapshots.issue({
      subject: hashApprovalInput(intent),
      approved: VerifiedCheckboxAuthoritySchema.parse(approved),
      observation,
    });
  });
}

/** Original requireCurrent body behind constructor-private ownership. */
export function requireOriginalCheckboxAuthorityCurrent(
  owner: object,
  request: CheckboxRequest,
  actor: DocChannelActor,
  approved: VerifiedCheckboxAuthority,
  snapshot: CheckboxAuthoritySnapshot,
  tx: DbTransaction
): VerifiedCheckboxAuthority {
  const facet = readOriginalCheckboxAuthorityOperationView(owner);
  facet.transactions.require(tx);
  return facet.currentOperation(() => {
    const data = facet.snapshots.consume(snapshot);
    if (
      data.subject !== hashApprovalInput(CanvasChannelCheckboxRequestSchema.parse(request)) ||
      data.actor !== actor.principal ||
      data.surface !== actor.surface
    )
      throw new CheckboxAuthorityRefusal('SNAPSHOT_SUBJECT_CHANGED');
    requireSameCheckboxAuthority(data.approved, VerifiedCheckboxAuthoritySchema.parse(approved));
    facet.access(request.documentId, actor, tx);
    const result = facet.checked(
      request.documentId,
      approved.grantId,
      approved.grantRevision,
      data.observation,
      tx,
      actor
    );
    requireSameCheckboxAuthority(data.approved, result);
    facet.reservationObservations.set(tx, {
      approved: result,
      observation: Object.freeze({
        manifestHash: data.observation.manifestHash,
        write: result.binding,
      }),
    });
    return result;
  });
}

/** Original requireRecoveryCurrent body behind constructor-private ownership. */
export function requireOriginalCheckboxRecoveryCurrent(
  owner: object,
  intent: DocWriteIntentRow,
  approved: VerifiedCheckboxAuthority,
  snapshot: CheckboxAuthoritySnapshot,
  tx: DbTransaction
): VerifiedCheckboxAuthority {
  const facet = readOriginalCheckboxAuthorityOperationView(owner);
  facet.transactions.require(tx);
  return facet.currentOperation(() => {
    const data = facet.snapshots.consume(snapshot);
    if (data.actor || data.subject !== hashApprovalInput(intent))
      throw new CheckboxAuthorityRefusal('SNAPSHOT_SUBJECT_CHANGED');
    requireSameCheckboxAuthority(validateCheckboxEvidence(intent).authority, approved);
    requireSameCheckboxAuthority(data.approved, approved);
    facet.editor(intent.documentId, undefined, tx, { grantId: approved.grantId });
    const result = facet.checked(
      intent.documentId,
      approved.grantId,
      approved.grantRevision,
      data.observation,
      tx
    );
    requireSameCheckboxAuthority(data.approved, result);
    facet.reservationObservations.set(tx, {
      approved: result,
      observation: Object.freeze({
        manifestHash: data.observation.manifestHash,
        write: result.binding,
      }),
    });
    return result;
  });
}
