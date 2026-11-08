/**
 * Which chats are heartbeat beats (DOR-3703, MB2). A beat is unattended and on
 * a timer, so it counts as a scheduled run everywhere a run's lineage is read
 * (`agent-mode-run-origin.ts`): a beat, its spin-offs, the chats its messages
 * start or steer into, and the room turns its posts wake may only change timing
 * or lower, never raise a mode or accept a changed file. A beat never counts as
 * an ordinary turn either (`file-cap/ordinary-turns.ts`).
 *
 * The heartbeat store answers both questions; `heartbeats-wiring.ts` wires it.
 * A beat's row holds its chat from before its turn starts (MD), and the live
 * registry answers for a turn running now, whatever its row says.
 *
 * @module services/tasks/agent-mode/agent-mode-beats
 */
import { isBeatTurn } from '../../heartbeats/beat-turns.js';
import { primaryOf } from '../../session/resolution/session-key-registry.js';

/** The beat chats of one agent. */
type BeatsOfAgent = (agentId: string) => ReadonlySet<string>;

/** The beat chats among some chats. */
type BeatsAmong = (sessionIds: readonly string[]) => ReadonlySet<string>;

let ofAgent: BeatsOfAgent = () => new Set();
let among: BeatsAmong = () => new Set();

/**
 * Where an agent's beat chats are read, for the row note (a beat is never an
 * ordinary turn).
 *
 * @param source - The agent's beat chats; `null` forgets it.
 */
export function setBeatSessionSource(source: BeatsOfAgent | null): void {
  ofAgent = source ?? (() => new Set());
}

/**
 * Where the beat chats among some chats are read, for a run's lineage (MB2).
 *
 * @param source - The beat chats among those asked about; `null` forgets it.
 */
export function setBeatChatLookup(source: BeatsAmong | null): void {
  among = source ?? (() => new Set());
}

/**
 * An agent's beat chats.
 *
 * @param agentId - The agent's Mesh id.
 */
export function beatSessionsOf(agentId: string): ReadonlySet<string> {
  return ofAgent(agentId);
}

/**
 * The beat chats among these chats, failing closed: a lookup that throws counts
 * every one of them as a beat, so nothing it asked about is vouched for.
 *
 * @param sessionIds - The chats.
 */
export function beatChatsAmong(sessionIds: readonly string[]): ReadonlySet<string> {
  const live = sessionIds.filter((id) => isBeatTurn(id));
  // A chat is matched by either id it is known by, as a run's is.
  const known = [...new Set(sessionIds.flatMap((id) => [id, primaryOf(id)]))];
  try {
    return new Set([...among(known), ...live]);
  } catch {
    return new Set(sessionIds);
  }
}
