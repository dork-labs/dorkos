/**
 * The order Heads up answers in (BC-6).
 *
 * @module features/dashboard-sidebar/model/rules/rank-now-items
 */
import type { NowKind, SidebarRowModel } from '../build-sidebar-model';
import { epochMs } from './targets';

/**
 * Which blockage is asked about first.
 *
 * Ordered by how cheaply the operator can clear it and how much is stopped
 * while they do not: a permission prompt is one keystroke and blocks a turn
 * outright; a question needs a sentence; a parked schedule needs a yes or a no
 * and is holding up work that has not started; an error needs a look, and
 * whatever it stopped has already stopped.
 *
 * A schedule sits above the error and below the two prompts on purpose. It is
 * genuinely blocked — `tasks_create` never arms one (DOR-504) — but it is the
 * only blockage with no clock on it: a prompt expires in ten minutes and a
 * capability hold in two hours, while a proposal keeps until it is decided.
 * That is the same reasoning, and the same resulting order, the Inbox popover
 * already draws its three waiting groups in.
 */
const TIER: Record<NowKind, number> = {
  'permission-prompt': 0,
  question: 1,
  'schedule-approval': 2,
  error: 3,
};

/** The tier a row with no attention block sorts at — last, and never thrown. */
const UNRANKED_TIER = Number.MAX_SAFE_INTEGER;

/**
 * Heads up's rows, in priority order — by tier, then oldest first inside a tier.
 *
 * Oldest first because the thing that has been waiting longest is the thing
 * most likely to have stopped something else. A row with an unparseable `since`
 * sorts last within its tier rather than throwing, and a row with no attention
 * block at all sorts after every tier: one malformed signal must not empty the
 * zone.
 *
 * The row key breaks a final tie, so two signals raised in the same millisecond
 * never swap places between renders.
 *
 * @param rows - Heads up's rows, in any order.
 */
export function rankNowItems(rows: readonly SidebarRowModel[]): SidebarRowModel[] {
  return [...rows].sort((a, b) => {
    const tierA = a.attention === undefined ? UNRANKED_TIER : TIER[a.attention.kind];
    const tierB = b.attention === undefined ? UNRANKED_TIER : TIER[b.attention.kind];
    if (tierA !== tierB) return tierA - tierB;
    const sinceA = epochMs(a.attention?.since) ?? Number.POSITIVE_INFINITY;
    const sinceB = epochMs(b.attention?.since) ?? Number.POSITIVE_INFINITY;
    if (sinceA !== sinceB) return sinceA - sinceB;
    return a.key.localeCompare(b.key);
  });
}
