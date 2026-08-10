/**
 * "N working" — one line, never N pulsing rows (BC-9).
 *
 * @module features/dashboard-sidebar/model/rules/build-working-rollup
 */
import { partitionSessionsByOrigin } from '@/layers/entities/session';
import type { SidebarRowModel } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import { rowKey } from './targets';

/**
 * The sessions this rollup is allowed to count — the human ones.
 *
 * **A scheduled run is not something that needs the operator, so it is not in
 * Now's number.** `design-decisions.md` §18 is a Signal → Rendering table, and
 * its automated row reads "Automated session activity → Nothing. No bold, no
 * badge." — directly under the line naming approval / question / wedged /
 * idle-timeout as "the only things that enter Now". A "6 working" that quietly
 * included two nightly tasks is automated activity rendered in the one zone
 * that promises to hold nothing but what needs you.
 *
 * **This rule is a ruling, not a reading of BC-9.** BC-9's own text carries no
 * exclusion; the contract was written before the question came up, and it was
 * settled in review of P2.2 (2026-08-10) together with the identical defect in
 * the session switcher's "N live" chip. One definition of live everywhere:
 * human-origin sessions. The written contract still does not say so, which is
 * why it says so here.
 *
 * **The blocking carve-out survives, and it is the same §18 sentence**:
 * "Blocking states go to Now like the rest." An automated session that is
 * waiting on an approval, asking a question or wedged still enters Now — as an
 * attention item, through `entities/attention`, which reads no origin at all
 * (`derive-attention-signals.ts`). Only the liveness COUNT excludes automation.
 *
 * A working session the snapshot cannot see at all is counted. Origin lives on
 * the session record, and `state.sessions` is a trimmed recent list, so an id
 * with no record is one whose origin is unknown rather than one known to be
 * automated — and hiding a human turn is the worse error of the two.
 *
 * @param state - The snapshot.
 */
function humanWorkingIds(state: SidebarState): readonly string[] {
  const automated = new Set(
    partitionSessionsByOrigin([...state.sessions]).automated.map((session) => session.id)
  );
  if (automated.size === 0) return state.workingSessionIds;
  return state.workingSessionIds.filter((id) => !automated.has(id));
}

/**
 * The single row that stands for every session streaming right now, or `null`
 * when there should be none.
 *
 * **Suppressed when the only working session is the one you are in.** The
 * anchor already shows that turn live at the top of Today, and Now restating
 * where the operator is standing is exactly how a zone that means "you are
 * needed" gets ignored. With two working sessions the rollup returns, because
 * then it is telling you about something you cannot see.
 *
 * Counts sessions, not rows: thirty agents working is one line that says
 * thirty, which is the whole point of the rollup. Which sessions those are is
 * {@link humanWorkingIds}' decision.
 *
 * @param state - The snapshot.
 */
export function buildWorkingRollup(state: SidebarState): SidebarRowModel | null {
  const working = humanWorkingIds(state);
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
