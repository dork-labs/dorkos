/**
 * Which sessions the strip counts as working — the rule, without the store.
 *
 * Pulled out of `useWorkingSessions` so it can be asserted beside the sidebar's
 * and ⌘K's answers to the same question (`src/__tests__/one-live-definition`).
 * A rule that only exists inside a hook can only be checked by re-typing it,
 * and a re-typed rule is the drift it was supposed to prevent (DOR-1137).
 *
 * @module features/presence-strip/lib/working-sessions
 */
import type { Session } from '@dorkos/shared/types';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { humanOriginSessionIds } from '@/layers/entities/session';
import type { WorkingSession } from './presence-rows';

/**
 * The sessions this client can honestly say are working, fleet-wide.
 *
 * Three gates, and each drops a different kind of untruth:
 *
 * - **Lifecycle.** `streaming` only. `blocked` is an agent WAITING on a person
 *   — the opposite of working, and already the triage header's subject two
 *   lines up; `error` and `interrupted` are turns that have stopped.
 * - **Attribution.** A session reaches this only once its runtime reported a
 *   working directory for it. An unattributable turn is not presence — it is a
 *   fact about the machine with nobody's name on it.
 * - **Origin.** Human sessions only (`design-decisions.md` §18), the same rule
 *   Now's "N working" counts by — and Now's rollup NAVIGATES to this strip, so
 *   the two saying different numbers was a disagreement the operator could see
 *   in one click.
 *
 * The origin gate is this half's alone. The strip's other half is room claims,
 * which are automated by definition: an agent answering a trigger in `#team`
 * IS "replying in #team", and applying the rule there would empty the feature.
 *
 * @param statuses - The session-list store's status map.
 * @param statusCwds - Its session-id → directory map, filled by the same events.
 * @param sessions - Its session-metadata map, read for one field: `origin`.
 */
export function selectWorkingSessions(
  statuses: Readonly<Record<string, SessionStatus | undefined>>,
  statusCwds: Readonly<Record<string, string>>,
  sessions: Readonly<Record<string, Session>>
): WorkingSession[] {
  const human = new Set(humanOriginSessionIds(Object.keys(statusCwds), Object.values(sessions)));
  const out: WorkingSession[] = [];
  for (const [sessionId, cwd] of Object.entries(statusCwds)) {
    if (statuses[sessionId]?.lifecycle !== 'streaming') continue;
    if (!human.has(sessionId)) continue;
    out.push({ sessionId, cwd });
  }
  return out;
}
