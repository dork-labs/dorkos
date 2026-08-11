/**
 * What "live" means, once, for every rule in this model (`design-decisions.md`
 * §18).
 *
 * Two questions and no more: which sessions are running, and whose. Before this
 * module the first was answered in `build-working-rollup.ts` and the second,
 * differently, inside `library-rows.ts` — so Heads up could say "1 working" while the
 * collapsed section that agent lives in said nothing at all (DOR-1137, audit
 * D5).
 *
 * @module features/dashboard-sidebar/model/rules/live-sessions
 */
import { humanOriginSessionIds } from '@/layers/entities/session';
import type { SidebarState } from '../sidebar-state';

/**
 * Every session running right now that counts — the human ones.
 *
 * **A scheduled run is not something that needs the operator, so it is not in
 * Heads up's number.** `design-decisions.md` §18 is a Signal → Rendering table, and
 * its automated row reads "Automated session activity → Nothing. No bold, no
 * badge." — directly under the line naming approval / question / wedged /
 * idle-timeout as "the only things that enter Heads up". A "6 working" that quietly
 * included two nightly tasks is automated activity rendered in the one zone
 * that promises to hold nothing but what needs you.
 *
 * **This rule is a ruling, not a reading of BC-9.** BC-9's own text carries no
 * exclusion; the contract was written before the question came up, and it was
 * settled in review of P2.2 (2026-08-10) together with the identical defect in
 * the session switcher's "N live" chip and in ⌘K's Continue list. One definition
 * of live everywhere: human-origin sessions, and the definition itself lives in
 * `entities/session` so those three surfaces read the same function.
 *
 * **The blocking carve-out survives, and it is the same §18 sentence**:
 * "Blocking states go to Heads up like the rest." An automated session that is
 * waiting on an approval, asking a question or wedged still enters Heads up — as an
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
export function liveSessionIds(state: SidebarState): readonly string[] {
  return humanOriginSessionIds(state.workingSessionIds, state.sessions);
}

/**
 * Where one running session is running, or `null` when nothing knows.
 *
 * The live stream first, the recent window second, and the order is the point.
 * `state.sessions` is the last ten sessions the REST window returned and is up
 * to thirty seconds stale, while `liveSessionCwds` comes off the status event
 * that made the session live in the first place — so a turn started ten seconds
 * ago has a directory in the second source and no record at all in the first.
 *
 * @param state - The snapshot.
 * @param sessionId - The session to place.
 */
function cwdOf(state: SidebarState, sessionId: string): string | null {
  const streamed = state.liveSessionCwds[sessionId];
  if (streamed !== undefined) return streamed;
  return state.sessions.find((session) => session.id === sessionId)?.cwd ?? null;
}

/**
 * The live sessions belonging to one agent — its row's dot, its "N live" chip,
 * and (through the row) its section's rollup when that section is folded.
 *
 * **Same source as {@link liveSessionIds}, scoped by directory.** Reading the
 * recent window alone — "a working id that also appears in `state.sessions`" —
 * is what made a fresh turn invisible to a folded section for the thirty
 * seconds before the window refetched, while Heads up had been counting it since the
 * first status event. BC-31 says signal is never lost by folding, and a row that
 * cannot see the session cannot hand its section anything to roll up.
 *
 * A live session whose directory nothing knows belongs to no agent and so to no
 * section. It stays in Heads up's count, where it is one honest number, rather than
 * being guessed into somebody's row.
 *
 * @param state - The snapshot.
 * @param path - The agent's directory, which is its identity.
 */
export function liveSessionIdsForPath(state: SidebarState, path: string): readonly string[] {
  return liveSessionIds(state).filter((id) => cwdOf(state, id) === path);
}
