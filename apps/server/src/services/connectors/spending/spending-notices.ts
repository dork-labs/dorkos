/**
 * Which spending notices a run's count crosses into (DOR-4204 PR 2, spec §5):
 * 80% of the limit, and the limit itself. Pure: the gate raises what this
 * returns, and the registry dedupes each per month and limit.
 *
 * @module services/connectors/spending/spending-notices
 */
import type { SpendingNoticePayload } from './spending-notifications.js';

/** One notice to raise. */
export interface SpendingNotice {
  kind: 'spending.near-limit' | 'spending.limit-reached';
  payload: SpendingNoticePayload;
}

/** The month's total before and after one run, and the limit it counts against. */
export interface SpendingCrossing {
  beforeMicro: number;
  afterMicro: number;
  limitMicro: number | null;
  month: string;
  resetsAt: Date;
}

/** The share of the limit that earns the first notice. */
const NEAR = 0.8;

/**
 * The notices a run crosses into, oldest threshold first.
 *
 * @param crossing - The month's total before and after the run.
 */
export function spendingNoticesAfter(crossing: SpendingCrossing): SpendingNotice[] {
  const { beforeMicro, afterMicro, limitMicro } = crossing;
  if (limitMicro === null) return [];
  const payload: SpendingNoticePayload = {
    month: crossing.month,
    limitMicro: String(limitMicro),
    leftMicro: String(Math.max(0, limitMicro - afterMicro)),
    resetsAt: crossing.resetsAt.toISOString(),
  };
  const near = limitMicro * NEAR;
  const out: SpendingNotice[] = [];
  if (beforeMicro < near && afterMicro >= near) out.push({ kind: 'spending.near-limit', payload });
  if (beforeMicro < limitMicro && afterMicro >= limitMicro) {
    out.push({ kind: 'spending.limit-reached', payload });
  }
  return out;
}
