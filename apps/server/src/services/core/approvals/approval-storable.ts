/**
 * Making caller-supplied approval text safe to store: swept for anything
 * token-shaped, then shortened to what the card's wire schema parses.
 *
 * Kept apart from `approval-service.ts` so the service holds the approval
 * lifecycle and this module holds the storage rules every text field passes.
 *
 * @module services/core/approvals/approval-storable
 */
import {
  APPROVAL_FULL_DETAIL_MAX_LENGTH,
  APPROVAL_REQUEST_REASON_MAX_LENGTH,
  ApprovalServiceActionSchema,
  inertRecipientText,
  MarketplaceApprovalSummarySchema,
  type ApprovalServiceAction,
  type MarketplaceApprovalSummary,
} from '@dorkos/shared/approval-schemas';
import {
  clampForStorage,
  redactSecretsInText,
  storableDetail,
  storableSummary,
} from '@dorkos/shared/approval-text';

// The summary and detail rules a card shares with the computer side's checks
// (spec `computer-side-starts-alone` §5.7) live in `@dorkos/shared/approval-text`.
export { clampForStorage, storableDetail, storableSummary };

/**
 * Make a blocked request's reason safe to store: the agent's own words, swept
 * for secrets and capped at the bound the card's schema parses.
 *
 * @param reason - The reason the agent gave.
 * @returns The swept, capped value to store.
 */
export function storableReason(reason: string): string {
  return clampForStorage(redactSecretsInText(reason), APPROVAL_REQUEST_REASON_MAX_LENGTH);
}

/**
 * Make a connected-app action safe to store: every string swept for secrets
 * again, then checked against the wire schema.
 *
 * The builder already sweeps and caps, but `ApprovalRequestInput` is public API
 * and this JSON is broadcast and agent-readable exactly like the summary, so
 * the store does not take a producer's word for it. A value that does not
 * parse is not stored, and the card falls back to the summary sentence.
 *
 * @param action - The described action.
 * @returns The JSON to store, or null.
 */
export function storableServiceAction(action: ApprovalServiceAction): string | null {
  // Made inert again here, whatever the producer did (DOR-4592). A recipient this
  // pass shortens counts as well, so the stored card stays decline-only for it.
  const recipients = action.recipients?.map((recipient) => ({
    label: redactSecretsInText(recipient.label),
    ...inertRecipientText(redactSecretsInText(recipient.address)),
  }));
  const shortened =
    (action.recipientsShortened ?? 0) + (recipients ?? []).filter((r) => r.shortened).length;
  const swept = {
    ...action,
    serviceName: redactSecretsInText(action.serviceName),
    accountLabel: redactSecretsInText(action.accountLabel),
    actionName: redactSecretsInText(action.actionName),
    ...(recipients
      ? { recipients: recipients.map(({ label, text }) => ({ label, address: text })) }
      : {}),
    ...(shortened > 0 ? { recipientsShortened: shortened } : {}),
    details: action.details.map((detail) => ({
      label: redactSecretsInText(detail.label),
      value: redactSecretsInText(detail.value),
    })),
    ...(action.everything
      ? {
          everything: action.everything.map((line) => ({
            ...line,
            label: redactSecretsInText(line.label),
            value: redactSecretsInText(line.value),
          })),
        }
      : {}),
  };
  const parsed = ApprovalServiceActionSchema.safeParse(swept);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}

/** The one capability a person's own, card-free yes may record (DOR-2665). */
export const OWN_ANSWER_CAPABILITY = 'ui.approve_doc_route';

/**
 * Pass through a person's own answer only for {@link OWN_ANSWER_CAPABILITY}, so a
 * second caller can't use `recordOwnAnswer` to mint a quiet yes for anything else.
 *
 * @param input - The approval request being recorded as already granted.
 * @returns The same input, unchanged.
 */
export function ownAnswerInput<T extends { capabilityId: string }>(input: T): T {
  if (input.capabilityId !== OWN_ANSWER_CAPABILITY)
    throw new Error(`Only ${OWN_ANSWER_CAPABILITY} records a person's own answer.`);
  return input;
}

/**
 * Read a stored connected-app action back, or nothing when the row has none or
 * it no longer parses — a card without it still has its summary.
 *
 * @param stored - The column's JSON.
 */
function storedServiceAction(stored: string | null): ApprovalServiceAction | undefined {
  if (stored === null) return undefined;
  try {
    const parsed = ApprovalServiceActionSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The stored connected-app action as a spreadable field, or nothing.
 *
 * @param stored - The column's JSON.
 */
export function withServiceAction(stored: string | null): {
  serviceAction?: ApprovalServiceAction;
} {
  const serviceAction = storedServiceAction(stored);
  return serviceAction ? { serviceAction } : {};
}

/**
 * What a Marketplace card too long for `detail` carries instead (DOR-3070):
 * the summary the card renders, and the full list behind its link.
 */
export interface MarketplaceCardInput {
  /** The sorted rows the card shows. */
  summary: MarketplaceApprovalSummary;
  /** Everything the approval is about, written out whole. */
  fullDetail: string;
}

/**
 * Thrown when a Marketplace card was asked for but cannot be stored whole
 * (DOR-3070): its summary does not parse, or its full list is too long. The
 * row is never raised, because the card's `detail` is cut and nothing would
 * be behind its link, so a yes would cover rows nobody was shown.
 */
export class MarketplaceCardNotStorableError extends Error {
  constructor() {
    super('This Marketplace card cannot be stored whole, so it was not raised.');
    this.name = 'MarketplaceCardNotStorableError';
  }
}

/**
 * A Marketplace card as its two columns, every string in the summary and the
 * whole full list swept for secrets like the detail, then checked against the
 * wire schema. The full list is never shortened.
 *
 * @param card - The summary and full list.
 * @returns The two columns, or `null` when the card cannot be stored whole.
 */
export function sweptMarketplaceCard(
  card: MarketplaceCardInput
): { marketplaceSummary: string; fullDetail: string } | null {
  if (card.fullDetail.length > APPROVAL_FULL_DETAIL_MAX_LENGTH) return null;
  const sweep = (value: string | undefined) =>
    value === undefined ? undefined : redactSecretsInText(value);
  const swept = {
    ...card.summary,
    packages: card.summary.packages.map((pkg) => ({
      ...pkg,
      name: redactSecretsInText(pkg.name),
      where: redactSecretsInText(pkg.where),
      ...(pkg.note !== undefined && { note: redactSecretsInText(pkg.note) }),
      risks: pkg.risks.map((risk) => ({
        ...risk,
        text: redactSecretsInText(risk.text),
        ...(risk.command !== undefined && { command: sweep(risk.command) }),
        ...(risk.was !== undefined && { was: sweep(risk.was) }),
        ...(risk.items && { items: risk.items.map(redactSecretsInText) }),
      })),
    })),
  };
  const parsed = MarketplaceApprovalSummarySchema.safeParse(swept);
  if (!parsed.success) return null;
  return {
    marketplaceSummary: JSON.stringify(parsed.data),
    fullDetail: redactSecretsInText(card.fullDetail),
  };
}

/**
 * Make a Marketplace card safe to store (see {@link sweptMarketplaceCard}).
 *
 * Fails CLOSED for every caller of `ApprovalService.request`: a card that was
 * asked for and cannot be stored whole throws, so no approvable row exists
 * with a cut detail and nothing behind its link.
 *
 * @param card - The summary and full list, or nothing.
 * @returns The two columns to store, both null when there is no card.
 * @throws {MarketplaceCardNotStorableError} When a card was passed and cannot
 *   be stored whole.
 */
export function storableMarketplaceCard(card: MarketplaceCardInput | undefined): {
  marketplaceSummary: string | null;
  fullDetail: string | null;
} {
  if (!card) return { marketplaceSummary: null, fullDetail: null };
  const stored = sweptMarketplaceCard(card);
  if (!stored) throw new MarketplaceCardNotStorableError();
  return stored;
}

/**
 * The stored Marketplace summary as a spreadable field, or nothing when the
 * row has none or it no longer parses.
 *
 * @param stored - The column's JSON.
 */
export function withMarketplaceSummary(stored: string | null): {
  marketplaceSummary?: MarketplaceApprovalSummary;
} {
  if (stored === null) return {};
  try {
    const parsed = MarketplaceApprovalSummarySchema.safeParse(JSON.parse(stored));
    return parsed.success ? { marketplaceSummary: parsed.data } : {};
  } catch {
    return {};
  }
}

/**
 * A row's full list, only while the card is still answerable: a decided or
 * expired card has nothing left for a person to read before answering.
 *
 * @param row - The stored row's state, expiry and full list.
 * @param now - The current time in epoch milliseconds.
 */
export function storedFullDetail(
  row: { state: string; expiresAt: string; fullDetail: string | null } | undefined,
  now: number = Date.now()
): string | undefined {
  if (!row || row.state !== 'pending' || Date.parse(row.expiresAt) <= now) return undefined;
  return row.fullDetail ?? undefined;
}
