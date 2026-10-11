import type { AgentSession } from '../../agent-types.js';

/** Select the original entries whose native query remains reloadable; writes no session state. */
export function selectReloadableSessions(
  sessions: Map<string, AgentSession>
): Array<{ sessionId: string; session: AgentSession }> {
  const reloadable: Array<{ sessionId: string; session: AgentSession }> = [];
  for (const [sessionId, session] of sessions) {
    if (session.activeQuery ?? session.lastQuery) {
      reloadable.push({ sessionId, session });
    }
  }
  return reloadable;
}
