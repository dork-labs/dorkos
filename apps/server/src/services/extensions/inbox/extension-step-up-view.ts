/** The full stored request a remote extension yes confirms. */
import path from 'node:path';
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
  identityHash: string;
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
    identityHash: hash,
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
  const identityHash = hashApprovalInput({
    t: 'dorkos.extension-offer.step-up.v1',
    decisionId: row.id,
    revision: row.revision,
    extensionId: row.extensionId,
    projectRoot: row.projectRoot,
    offer,
  });
  const hash = offer.settingsPatch
    ? extensionSettingsHash(row.extensionId, offer.settingsPatch.project, offer.settingsPatch.patch)
    : identityHash;
  return { hash, identityHash, reason: offer.text, requestCode: requestCodeForHash(hash) };
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
            revision: row.revision,
            text: offer.text,
            requestCode: view.requestCode,
            expiresAt: new Date(Date.parse(offer.createdAt) + DECISION_OFFER_TTL_MS).toISOString(),
          },
        ]
      : [];
  });
}

/** One full JSON settings body has the same display code at either writing door. */
export function extensionSettingsHash(
  extensionId: string,
  project: string,
  value: unknown
): string {
  return hashApprovalInput({
    t: 'dorkos.extension-settings.step-up.v1',
    extensionId,
    project: path.resolve(project),
    value,
  });
}
