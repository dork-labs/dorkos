/**
 * Whether a capped task's own agent could lift the cap itself (DOR-3703, M4,
 * the PM's row note). Only an ordinary turn can: a chat a person, a room or
 * another chat started, never a scheduled run or anything one started (M7).
 *
 * The rule, from session history: the agent has at least one chat in its own
 * folder updated in the last {@link ORDINARY_TURN_WINDOW_DAYS} days that no
 * scheduled run started (nor a spin-off or a message one started, M7) and that
 * is not one of its heartbeat beats. With none, the task's row says a person
 * has to approve the current file. A history that cannot be read says the same: the
 * row then asks a person rather than promise an agent that may never come.
 *
 * @module services/tasks/agent-mode/file-cap/ordinary-turns
 */
import type { TaskStore } from '../../task-store.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { listRecentSessions } from '../../../session/catalog/recent-sessions.js';
import { liveRunOriginSources, startedByScheduledRun } from '../agent-mode-run-origin.js';

/** How far back an ordinary chat counts. */
export const ORDINARY_TURN_WINDOW_DAYS = 7;

/** How many of the agent's newest chats are looked at. */
const CHATS_READ = 50;

/** Answers whether an agent had an ordinary turn lately; injected in tests. */
export type OrdinaryTurnsSource = (agentPath: string, agentId: string) => Promise<boolean>;

/** The chats an agent's heartbeat beats ran in; the heartbeat store's, once it is wired. */
type BeatSessions = (agentId: string) => ReadonlySet<string>;

let beatSessions: BeatSessions = () => new Set();

/**
 * Tell this module where an agent's heartbeat beats ran (`heartbeats-wiring.ts`):
 * a beat is never an ordinary turn.
 *
 * @param source - The agent's beat chats; `null` forgets it.
 */
export function setBeatSessionSource(source: BeatSessions | null): void {
  beatSessions = source ?? (() => new Set());
}

/**
 * The live source, over the store that knows every scheduled run's chat.
 *
 * @param store - The task store.
 * @param now - The clock, for tests.
 */
export function liveOrdinaryTurns(
  store: Pick<TaskStore, 'resolveTaskOrigins'>,
  now: () => number = Date.now
): OrdinaryTurnsSource {
  return async (agentPath, agentId) => {
    try {
      const beats = beatSessions(agentId);
      const { sessions } = await listRecentSessions({
        runtimes: runtimeRegistry.listRuntimes(),
        agentPaths: [agentPath],
        limit: CHATS_READ,
      });
      const since = now() - ORDINARY_TURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const origins = liveRunOriginSources(store);
      return sessions.some(
        (session) =>
          Date.parse(session.updatedAt) >= since &&
          !beats.has(session.id) &&
          !startedByScheduledRun([session.id], origins)
      );
    } catch {
      return false;
    }
  };
}
