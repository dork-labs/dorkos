/**
 * "N working" — one line, never N pulsing rows (BC-9).
 *
 * @module features/dashboard-sidebar/model/rules/build-working-rollup
 */
import type { SidebarRowModel } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import { liveSessionIds } from './live-sessions';
import { rowKey } from './targets';

/**
 * The single row that stands for every session streaming right now, or `null`
 * when there should be none.
 *
 * **Suppressed when the only working session is the one you are in.** The
 * anchor already shows that turn live at the top of Today, and Heads up restating
 * where the operator is standing is exactly how a zone that means "you are
 * needed" gets ignored. With two working sessions the rollup returns, because
 * then it is telling you about something you cannot see.
 *
 * Counts sessions, not rows: thirty agents working is one line that says
 * thirty, which is the whole point of the rollup. Which sessions those are is
 * {@link liveSessionIds}' decision, and it is the same decision an agent row
 * makes about its own dot — one definition, so Heads up and a folded Library section
 * cannot disagree about what is running (DOR-1137).
 *
 * @param state - The snapshot.
 */
export function buildWorkingRollup(state: SidebarState): SidebarRowModel | null {
  const working = liveSessionIds(state);
  if (working.length === 0) return null;
  const active = state.activeTarget;
  if (working.length === 1 && active?.kind === 'session' && active.sessionId === working[0]) {
    return null;
  }
  const target = { kind: 'rollup', rollup: 'working' } as const;
  return {
    key: rowKey(target),
    target,
    glyph: { kind: 'icon', icon: 'working' },
    primary: `${working.length} working`,
    status: 'working',
    reservesVerbLine: false,
    unread: { tier: 'none' },
    muted: false,
    draggable: false,
    actions: ['open'],
    reason: 'rollup:working',
  };
}
