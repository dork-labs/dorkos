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
  APPROVAL_DETAIL_MAX_LENGTH,
  APPROVAL_FULL_DETAIL_MAX_LENGTH,
  APPROVAL_REQUEST_REASON_MAX_LENGTH,
  APPROVAL_SUMMARY_MAX_LENGTH,
  ApprovalServiceActionSchema,
  MarketplaceApprovalSummarySchema,
  type ApprovalServiceAction,
  type MarketplaceApprovalSummary,
} from '@dorkos/shared/approval-schemas';
import { redactSecretsInText } from './approval-summary.js';

/**
 * Make a summary safe to store: strip anything token-shaped, then shorten it to
 * what a card can hold.
 *
 * Both happen on the way IN rather than at render time. The length cap is because
 * the cockpit parses stored rows against a schema that caps it, so a long sentence
 * has to become a short one here or the card would be dropped instead of shown.
 * The redaction is because this string is broadcast on the global event stream and
 * returned by `GET /api/approvals/pending`, which agents can read — so it is the
 * one place every producer of a summary passes through, including the marketplace
 * confirmation provider, which writes its own sentences.
 */
export function storableSummary(summary: string): string {
  return clampForStorage(redactSecretsInText(summary), APPROVAL_SUMMARY_MAX_LENGTH);
}

/**
 * Make a detail safe to store: the same sweep the summary gets, against the
 * detail's own, much larger bound.
 *
 * Same two reasons, in the same order. The sweep is because this string is
 * broadcast on the global event stream and returned by
 * `GET /api/approvals/pending`, which agents can read. The cap is because the
 * cockpit parses stored rows against a schema that caps it, so an over-long
 * value has to shorten here or the whole card is dropped rather than shown —
 * and a dropped card is worse than a shortened one for exactly the reason this
 * field exists.
 *
 * @param detail - The verbatim argument the capability declared.
 * @returns The swept, capped value to store.
 */
export function storableDetail(detail: string): string {
  return clampForStorage(redactSecretsInText(detail), APPROVAL_DETAIL_MAX_LENGTH);
}

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
 * Shorten a value to what its column's schema will parse, marking the cut.
 *
 * @param value - The already-swept string.
 * @param max - The schema's bound for that field.
 * @returns The value, at most `max` characters.
 */
export function clampForStorage(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
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
  const swept = {
    ...action,
    serviceName: redactSecretsInText(action.serviceName),
    accountLabel: redactSecretsInText(action.accountLabel),
    actionName: redactSecretsInText(action.actionName),
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
