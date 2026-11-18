/**
 * What one paid run does before it runs (DOR-4204 PR 2, spec 1.0 §4.1 and
 * 1.1): run quietly, ask a person, or be refused with no card. Pure, so the
 * preflight, the broker and the tests read one answer.
 *
 * The order is the policy:
 * 1. Not a paid action: nothing to decide.
 * 2. An outsider-marked turn never spends, limit or not (Security Must 1).
 * 3. A meter that cannot be read fails closed into a card (Security Q8).
 * 4. No limit: every paid run asks (the default, Security Q1).
 * 5. The limit is reached: refused, no card.
 * 6. The price is unknown: asks, because a limit can only bound what it counts.
 * 7. The run would pass the limit: refused, no card.
 * 8. Otherwise it fits: runs quietly and counts.
 *
 * @module services/connectors/spending/spend-decision
 */
import type { ApprovalSpend } from '@dorkos/shared/approval-schemas';
import type { SpendAskReason, SpendPreflight } from '../../core/capabilities/spend-permission.js';
import {
  SPEND_COPY,
  SPEND_CURRENCY,
  SPEND_LIMIT,
  SPEND_OUTSIDER,
  limitRefusal,
} from './spend-copy.js';

export type { SpendAskReason, SpendPreflight } from '../../core/capabilities/spend-permission.js';

/** What {@link decideSpend} answers. */
export type SpendDecision =
  | { kind: 'free' }
  | { kind: 'run'; priceMicro: number }
  | { kind: 'ask'; reason: SpendAskReason }
  | { kind: 'refuse'; code: typeof SPEND_OUTSIDER; message: string }
  | {
      kind: 'refuse';
      code: typeof SPEND_LIMIT;
      reason: 'reached' | 'would-pass';
      leftMicro: number;
      message: string;
    };

/** The facts one decision reads. */
export interface SpendFacts {
  paid: boolean;
  outsider: boolean;
  limitMicro: number | null;
  priceMicro: number | null;
  /** This month's total, or `'unreadable'` when it could not be read. */
  usedMicro: number | 'unreadable';
  /** When the month resets, for the refusal's words. */
  resetsAt?: Date;
}

/** See the module doc. */
export function decideSpend(facts: SpendFacts): SpendDecision {
  if (!facts.paid) return { kind: 'free' };
  if (facts.outsider) return { kind: 'refuse', code: SPEND_OUTSIDER, message: SPEND_COPY.outsider };
  if (facts.usedMicro === 'unreadable') return { kind: 'ask', reason: 'meter-unreadable' };
  if (facts.limitMicro === null) return { kind: 'ask', reason: 'no-limit' };
  const resetsAt = facts.resetsAt ?? new Date();
  const leftMicro = Math.max(0, facts.limitMicro - facts.usedMicro);
  if (facts.usedMicro >= facts.limitMicro) {
    return {
      kind: 'refuse',
      code: SPEND_LIMIT,
      reason: 'reached',
      leftMicro: 0,
      message: limitRefusal('reached', 0, resetsAt),
    };
  }
  if (facts.priceMicro === null) return { kind: 'ask', reason: 'unknown-price' };
  if (facts.usedMicro + facts.priceMicro > facts.limitMicro) {
    return {
      kind: 'refuse',
      code: SPEND_LIMIT,
      reason: 'would-pass',
      leftMicro,
      message: limitRefusal('would-pass', leftMicro, resetsAt),
    };
  }
  return { kind: 'run', priceMicro: facts.priceMicro };
}

/**
 * The card a run that asks carries.
 *
 * @param facts - What the decision read.
 */
export function spendCard(facts: SpendFacts): ApprovalSpend {
  const used = facts.usedMicro === 'unreadable' ? null : facts.usedMicro;
  return {
    priceMicro: facts.priceMicro === null ? null : String(facts.priceMicro),
    priceSource: facts.priceMicro === null ? null : 'person',
    limitMicro: facts.limitMicro === null ? null : String(facts.limitMicro),
    leftMicro:
      facts.limitMicro === null || used === null
        ? null
        : String(Math.max(0, facts.limitMicro - used)),
    currency: SPEND_CURRENCY,
  };
}

/**
 * The preflight's answer for one paid run, or `undefined` for a free one.
 *
 * @param facts - What the decision reads.
 */
export function spendPreflightOf(facts: SpendFacts): SpendPreflight | undefined {
  const decision = decideSpend(facts);
  switch (decision.kind) {
    case 'free':
      return undefined;
    case 'run':
      return { kind: 'run' };
    case 'ask':
      return { kind: 'ask', reason: decision.reason, card: spendCard(facts) };
    case 'refuse':
      return { kind: 'refuse', code: decision.code, message: decision.message };
  }
}
