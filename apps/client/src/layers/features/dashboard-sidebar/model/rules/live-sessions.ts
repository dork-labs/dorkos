/**
 * What "live" means, once, for every rule in this model.
 *
 * Two questions and no more: which sessions are running, and whose. They used
 * to be answered in two places, differently, so one surface could say "1
 * working" while the folded section that agent lives in said nothing at all
 * (DOR-1137, audit D5).
 *
 * @module features/dashboard-sidebar/model/rules/live-sessions
 */
import { nonAutomatedSessionIds } from '@/layers/entities/session';
import type { SidebarState } from '../sidebar-state';

/**
 * Every session running right now that counts — everything but automated
 * chats (spec `your-activity-first` D8: a spin-off chat still counts, because a
 * person asked for it through a chat).
 *
 * **A scheduled run lights no row.** Automated activity is rendered nowhere in
 * the panel — no bold, no badge, no dot — and a "working" dot that quietly
 * meant a nightly task would be exactly that. One definition of live
 * everywhere, living in `entities/session` so the session switcher's "N live"
 * chip and ⌘K's Continue list read the same function.
 *
 * A working session the snapshot cannot see at all is counted. Ownership lives on
 * the session record, and `state.sessions` is a trimmed recent list, so an id
 * with no record is one whose ownership is unknown rather than one known to be
 * automated — and hiding a human turn is the worse error of the two.
 *
 * @param state - The snapshot.
 */
export function liveSessionIds(state: SidebarState): readonly string[] {
  return nonAutomatedSessionIds(state.workingSessionIds, state.sessions);
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
 * seconds before the window refetched. BC-31 says signal is never lost by
 * folding, and a row that cannot see the session cannot hand its section
 * anything to roll up.
 *
 * A live session whose directory nothing knows belongs to no agent and so to no
 * section, rather than being guessed into somebody's row.
 *
 * @param state - The snapshot.
 * @param path - The agent's directory, which is its identity.
 */
export function liveSessionIdsForPath(state: SidebarState, path: string): readonly string[] {
  return liveSessionIds(state).filter((id) => cwdOf(state, id) === path);
}
