/**
 * What happens to a report's lines when the report itself lands or is given
 * up on (spec `heartbeats` §9.3): lines are `reported` only once the report
 * reaches its reader, and go back in the queue if it is dropped. The agent's
 * `last_report_at` moves only when its report to its manager arrives, to the
 * moment its report beat began, so beat turns after that wait for the next one.
 *
 * @module services/heartbeats/raises/report-delivery
 */
import type { HeartbeatOutboxRow } from '@dorkos/db';
import type { HeartbeatStore } from '../heartbeat-store.js';
import { REPORT_KEY_PREFIX, type RaiseStore } from './raise-store.js';

/** What settling a report reads and writes. */
export interface ReportSettleDeps {
  /** The heartbeat tables. */
  store: HeartbeatStore;
  /** The report queue. */
  raises: RaiseStore;
  /** Who the agent reports to. */
  managerOf(agentId: string): string;
}

/**
 * Whether an outbox row is a report rather than a raise.
 *
 * @param row - The row.
 * @param row.key - Its key.
 */
export function isReportRow(row: Pick<HeartbeatOutboxRow, 'key'>): boolean {
  return row.key.startsWith(REPORT_KEY_PREFIX);
}

/**
 * Reports among these rows were delivered, or dropped.
 *
 * @param deps - The tables and the chain.
 * @param rows - Rows that left `held` together; raises among them are ignored.
 * @param delivered - Delivered, or dropped.
 * @param at - When (ISO 8601).
 */
export function settleReports(
  deps: ReportSettleDeps,
  rows: readonly Pick<HeartbeatOutboxRow, 'id' | 'key' | 'agentId' | 'beatId' | 'toAccount'>[],
  delivered: boolean,
  at: string
): void {
  const reports = rows.filter(isReportRow);
  deps.raises.settleReportRows(
    reports.map((row) => row.id),
    delivered,
    at
  );
  if (!delivered) return;
  for (const row of reports) {
    if (row.toAccount !== deps.managerOf(row.agentId)) continue;
    noteReported(deps, row.agentId, row.beatId, at);
  }
}

/**
 * The agent's report reached its manager: beat turns before its report beat
 * began are covered.
 *
 * @param deps - The tables.
 * @param agentId - The agent.
 * @param beatId - Its report beat.
 * @param at - When it arrived (ISO 8601), the fallback when the beat row is gone.
 */
export function noteReported(
  deps: Pick<ReportSettleDeps, 'store'>,
  agentId: string,
  beatId: string,
  at: string
): void {
  deps.store.patchState(agentId, { lastReportAt: deps.store.getBeat(beatId)?.startedAt ?? at });
}
