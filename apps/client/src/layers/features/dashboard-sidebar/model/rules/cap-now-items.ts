/**
 * Now never scrolls — three rows and an overflow, forever (BC-7, BC-8).
 *
 * @module features/dashboard-sidebar/model/rules/cap-now-items
 */
import type { SidebarRowModel } from '../build-sidebar-model';
import { rowKey } from './targets';

/**
 * How many things that need you Now shows before it stops counting them out
 * one by one.
 *
 * Three, because Now's whole promise is that it is readable at a glance from
 * across a desk. A fourth row is the beginning of a list, and a list is what
 * the home surface is for.
 */
export const NOW_ATTENTION_CAP = 3;

/**
 * Where "+ N more" goes: the home surface's triage header, which already holds
 * the full list.
 *
 * Now never grows a second list. The href lives here rather than on the row
 * because the row's target is a rollup — a rollup says what it summarizes, and
 * a renderer decides where summaries lead.
 */
export const NOW_OVERFLOW_HREF = '/';

/**
 * Now's rows, capped, with everything past the cap folded into one row.
 *
 * @param rows - Now's attention rows, already ranked.
 */
export function capNowItems(rows: readonly SidebarRowModel[]): SidebarRowModel[] {
  if (rows.length <= NOW_ATTENTION_CAP) return [...rows];
  const visible = rows.slice(0, NOW_ATTENTION_CAP);
  const hidden = rows.length - NOW_ATTENTION_CAP;
  const target = { kind: 'rollup', rollup: 'now-overflow' } as const;
  return [
    ...visible,
    {
      key: rowKey(target),
      target,
      glyph: { kind: 'icon', icon: 'overflow' },
      primary: `+ ${hidden} more`,
      status: 'needs-you',
      reservesVerbLine: false,
      unread: { tier: 'none' },
      muted: false,
      draggable: false,
      actions: ['open'],
      reason: 'rollup:now-overflow',
    },
  ];
}
