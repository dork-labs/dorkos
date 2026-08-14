/**
 * What your agents did while you were away, read off session state
 * (spec `team-room-home` D5.2, task 4.4).
 *
 * The production {@link WelcomeBackWorkSource}. It is a separate module from
 * the greeter for one reason: this is the half that knows sessions exist, and
 * sessions are runtime-owned (ADR-0310). Keeping it here leaves
 * `greeter.ts` — the gate, the caps and the copy — provable without a
 * runtime anywhere near it.
 *
 * **It wakes nobody.** Every number below comes from a session LISTING, which
 * is the cheapest thing a runtime can be asked for and costs no model turn. A
 * runtime that cannot answer contributes nothing rather than a guess: the
 * fan-out degrades per runtime (ADR-0310), and an agent whose sessions could
 * not be read has no news rather than empty news.
 *
 * @module server/services/rooms/welcome-back/work-source
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { Session } from '@dorkos/shared/types';
import { listRecentSessions } from '../../session/recent-sessions.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomStore } from '../room-store.js';
import type { AgentAbsenceWork, WelcomeBackWorkSource } from './greeter.js';

/**
 * How many sessions one scan carries back.
 *
 * The listing trims to this AFTER merging, so it bounds memory rather than
 * work — and it has to be high enough that the count in a greeting is exact,
 * because "worked on 3 sessions" is a fact and a trimmed list would quietly
 * make it a floor. Five hundred is far past what a person operating a fleet by
 * hand accumulates in one absence, and a machine that somehow passes it
 * undercounts rather than inventing anything.
 */
const SESSION_SCAN_LIMIT = 500;

/**
 * Read what each agent member of a room did in a window, from session state.
 *
 * **Room turns are deliberately excluded, and the exclusion is install-wide.**
 * A turn an agent ran in a room is already in that room, so counting it would
 * tell somebody about a conversation sitting on the screen they are reading the
 * greeting on. The set dropped is EVERY `(room, agent) → session` binding this
 * install holds (`sessionLedger.list()`), not just the ones belonging to the
 * room being greeted — and that is the right width rather than an oversight.
 * A session bound to another room is still a conversation the person can open
 * and read as a conversation, so it is not news either; and a session id is
 * unique across rooms, so nothing here can drop a session that was never bound
 * to anything. Narrowing it to one room would mean an agent's DM turns quietly
 * counting as work when the same turn in #team would not.
 *
 * The list is unfiltered and unpaginated by design (see `RoomSessionLedger`):
 * one row per `(room, agent)` pair that has ever answered, which is bounded by
 * how many agents a person has put in how many rooms.
 *
 * @param deps.store - The room store, for the roster and the room bindings.
 * @param deps.authors - The author registry, for which members are agents and
 *   which directory each one occupies.
 * @param deps.runtimes - Every runtime this install can list sessions from.
 *   Read per call, never captured: a runtime registered after boot has to count.
 */
export function createSessionWorkSource(deps: {
  store: RoomStore;
  authors: AuthorRegistry;
  runtimes(): AgentRuntime[];
}): WelcomeBackWorkSource {
  return {
    async since({ roomId, since }) {
      const members = deps.store.listMembers(roomId);
      const records = deps.authors.getMany(members.map((member) => member.authorId));
      const agents: Array<{ authorId: string; agentPath: string }> = [];
      for (const member of members) {
        const record = records.get(member.authorId);
        // `naturalKey` is the agent's directory for an agent author, which is
        // exactly what a session listing is keyed by.
        if (record?.kind === 'agent') {
          agents.push({ authorId: record.id, agentPath: record.naturalKey });
        }
      }
      const runtimes = deps.runtimes();
      if (agents.length === 0 || runtimes.length === 0) return [];

      const { sessions } = await listRecentSessions({
        runtimes,
        agentPaths: agents.map((agent) => agent.agentPath),
        limit: SESSION_SCAN_LIMIT,
      });

      // Every room binding this install holds, not this room's — see the module
      // header for why that is the right width.
      const inRooms = new Set(deps.store.sessionLedger.list().map((binding) => binding.sessionId));
      const sinceMs = Date.parse(since);
      const moved = new Map<string, Session[]>();
      for (const session of sessions) {
        // A session with no working directory belongs to no agent. The listing
        // has already dropped those (exact-cwd membership, DOR-203); this is
        // what makes that guarantee a type rather than a comment.
        if (session.cwd === undefined || inRooms.has(session.id)) continue;
        // Strictly after, never at: `since` is the instant the person was last
        // seen, so a session that moved exactly then moved while they were
        // still here and is not news.
        if (Date.parse(session.updatedAt) <= sinceMs) continue;
        const forPath = moved.get(session.cwd);
        if (forPath) forPath.push(session);
        else moved.set(session.cwd, [session]);
      }

      const work: AgentAbsenceWork[] = [];
      for (const agent of agents) {
        const theirs = moved.get(agent.agentPath);
        if (theirs === undefined || theirs.length === 0) continue;
        const latest = theirs.reduce((newest, session) =>
          Date.parse(session.updatedAt) > Date.parse(newest.updatedAt) ? session : newest
        );
        work.push({
          authorId: agent.authorId,
          agentPath: agent.agentPath,
          sessions: theirs.length,
          lastActiveAt: latest.updatedAt,
          // An untitled session is `null`, not an empty pair of quotes: the
          // line says less rather than quoting nothing.
          latestTitle: latest.title.trim() === '' ? null : latest.title,
        });
      }
      return work;
    },
  };
}
