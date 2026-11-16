/** The full stored request a remote extension yes confirms. */
import type { ExtensionDecisionRow } from '@dorkos/db';
import {
  DECISION_OFFER_TTL_MS,
  type PendingDecisionOffer,
} from '@dorkos/shared/extension-decision-schemas';
import { hashApprovalInput } from '../../core/approvals/approval-input-hash.js';
import { requestCodeForHash } from '../../core/auth/step-up/request-code.js';
import type { StoredOffer } from './extension-inbox-rows.js';

/** Server-only binding plus the words and display code the person sees. */
export interface ExtensionStepUpView {
  hash: string;
  reason: string;
  requestCode: string;
}

/** Bind every disclosure of a yes/no decision, including its full actions and revision. */
export function extensionDecisionStepUp(row: ExtensionDecisionRow): ExtensionStepUpView {
  const {
    id,
    extensionId,
    extensionName,
    key,
    projectRoot,
    projectLabel,
    title,
    why,
    detail,
    actionsJson,
    link,
    since,
    raisedAt,
    revision,
  } = row;
  const hash = hashApprovalInput({
    t: 'dorkos.extension-decision.step-up.v1',
    request: {
      id,
      extensionId,
      extensionName,
      key,
      projectRoot,
      projectLabel,
      title,
      why,
      detail,
      actionsJson,
      link,
      since,
      raisedAt,
      revision,
    },
  });
  return {
    hash,
    reason: [title, why, detail].filter(Boolean).join('\n'),
    requestCode: requestCodeForHash(hash),
  };
}

/** A still-open offer, including its full stored settings patch in the binding. */
export function extensionOfferStepUp(
  row: ExtensionDecisionRow,
  now: number
): ExtensionStepUpView | undefined {
  let offer: StoredOffer;
  try {
    offer = JSON.parse(row.offerJson ?? 'null') as StoredOffer;
  } catch {
    return undefined;
  }
  if (!offer || row.offerUsedAt || row.resolvedBy !== 'person') return undefined;
  const made = Date.parse(offer.createdAt);
  if (Number.isNaN(made) || now - made > DECISION_OFFER_TTL_MS) return undefined;
  const hash = hashApprovalInput({
    t: 'dorkos.extension-offer.step-up.v1',
    decisionId: row.id,
    extensionId: row.extensionId,
    projectRoot: row.projectRoot,
    offer,
  });
  return { hash, reason: offer.text, requestCode: requestCodeForHash(hash) };
}

/** List later offers; an immediate reply remains private to the browser that answered. */
export function pendingOffersForRows(
  rows: readonly ExtensionDecisionRow[],
  now: number
): PendingDecisionOffer[] {
  return rows.flatMap((row) => {
    let offer: StoredOffer;
    try {
      offer = JSON.parse(row.offerJson ?? 'null') as StoredOffer;
    } catch {
      return [];
    }
    const view = extensionOfferStepUp(row, now);
    return view && offer.via === 'answering'
      ? [
          {
            decisionId: row.id,
            text: offer.text,
            requestCode: view.requestCode,
            expiresAt: new Date(Date.parse(offer.createdAt) + DECISION_OFFER_TTL_MS).toISOString(),
          },
        ]
      : [];
  });
}
