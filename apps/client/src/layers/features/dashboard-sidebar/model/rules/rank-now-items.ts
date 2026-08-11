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
 * outright; a question needs a sentence; an error needs a look; an idle nudge
 * is the product being helpful and goes last.
 */
const TIER: Record<NowKind, number> = {
  'permission-prompt': 0,
  question: 1,
  error: 2,
  'idle-timeout': 3,
};

/**
 * Heads up's rows, in priority order — by tier, then oldest first inside a tier.
 *
 * Oldest first because the thing that has been waiting longest is the thing
 * most likely to have stopped something else. A row with an unparseable `since`
 * sorts last within its tier rather than throwing: one malformed signal must
 * not empty the zone.
 *
 * The row key breaks a final tie, so two signals raised in the same millisecond
 * never swap places between renders.
 *
 * @param rows - Heads up's rows, in any order.
 */
export function rankNowItems(rows: readonly SidebarRowModel[]): SidebarRowModel[] {
  return [...rows].sort((a, b) => {
    const tierA = TIER[a.attention?.kind ?? 'idle-timeout'];
    const tierB = TIER[b.attention?.kind ?? 'idle-timeout'];
    if (tierA !== tierB) return tierA - tierB;
    const sinceA = epochMs(a.attention?.since) ?? Number.POSITIVE_INFINITY;
    const sinceB = epochMs(b.attention?.since) ?? Number.POSITIVE_INFINITY;
    if (sinceA !== sinceB) return sinceA - sinceB;
    return a.key.localeCompare(b.key);
  });
}
