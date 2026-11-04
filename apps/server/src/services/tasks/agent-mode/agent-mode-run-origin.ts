/**
 * Whether a tool call comes from a scheduled run (DOR-3703, Security ruling of
 * Nov 3, condition 3 and M7). A turn a scheduled run started counts as that
 * run: the run's own chat, a spin-off it started (`session_start`, kept in
 * `session_started_by`), and a chat whose running turn a message from it
 * started (`chat_send`, kept by `chat-started-turns.ts`), at any distance. A
 * heartbeat beat is a scheduled run too (MB2, `agent-mode-beats.ts`). A run is
 * found by its row, which holds its chat from before the first turn and moves
 * with the chat's rekey, so a restart keeps the lineage (MB1). A spin-off carries
 * the answer on its own started-by row, stamped when it starts, because retention
 * prunes the run rows (ME).
 *
 * The `chat_send` hop is kept in memory, from the turn's start, and a restart
 * mid-turn loses it. That turn also loses its recorded level, which is kept
 * the same way, so it fails toward the stricter reading: the decision holds a
 * chat with no recorded level to the lowest level (S-B), and an edit from it is
 * never vouched for (`contentEditVouched`).
 *
 * @module services/tasks/agent-mode/agent-mode-run-origin
 */
import { activeTurnStarterOf } from '../../session/origin/active-turn-starter.js';
import type { TaskStore } from '../task-store.js';
import { getSessionStartedByStore } from '../../session/origin/session-started-by-store.js';
import { chatTurnSendersOf } from '../../session/chat-messages/chat-started-turns.js';
import { activeRunSessionsOf } from '../session/active-run-sessions.js';
import { primaryOf } from '../../session/resolution/session-key-registry.js';
import { beatChatsAmong } from './agent-mode-beats.js';
import type { AgentModeCaller } from './agent-mode-decision.js';

/** The most chats walked, against a cycle nothing should make. */
const MAX_HOPS = 64;

/** Where the walk reads who started a chat and its turn. Injected so a test can fake each. */
export interface RunOriginSources {
  /** Display provenance of this running send; never used by the scheduled-run walk. */
  turnStarter?: (sessionId: string) => string | undefined;
  /** The scheduled runs among these chats, as `resolveTaskOrigins` answers. */
  runSessions: (sessionIds: string[]) => ReadonlySet<string>;
  /** The chat that started a chat with `session_start`, or `null`. */
  startedBy: (sessionId: string) => string | null;
  /** The chats whose messages started a chat's running turn. */
  turnSenders: (sessionId: string) => readonly string[];
  /** The heartbeat beats among these chats (MB2); none when absent. */
  beatSessions?: (sessionIds: string[]) => ReadonlySet<string>;
  /** What a chat's own start stamped as the scheduled thing behind it (ME); none when absent. */
  stampOf?: (sessionId: string) => ScheduledOrigin | null;
}

/** The scheduled thing behind a chat: a task's run, or a heartbeat beat. */
export type ScheduledOrigin = 'run' | 'heartbeat';

/**
 * What a chat's started-by row stamped as the scheduled thing behind it (ME), by
 * either id the chat is known by. The stamp outlives the run row it was read
 * from, which retention prunes. A stamp nothing can read counts as a run.
 *
 * @param sessionId - The chat.
 */
function stampedOriginOf(sessionId: string): ScheduledOrigin | null {
  try {
    const store = getSessionStartedByStore();
    const stamp =
      store?.get(sessionId)?.scheduledOrigin ?? store?.get(primaryOf(sessionId))?.scheduledOrigin;
    if (stamp === null || stamp === undefined) return null;
    return stamp === 'heartbeat' ? 'heartbeat' : 'run';
  } catch {
    return 'run';
  }
}

/**
 * The scheduled runs among these chats, failing closed: a store that cannot
 * answer (no lookup, or one that throws) counts every chat as a scheduled run,
 * so nothing it asked about is vouched for.
 *
 * @param store - The task store, which knows every run's chat.
 * @param ids - The chats.
 */
function runSessionsOf(
  store: Partial<Pick<TaskStore, 'resolveTaskOrigins'>>,
  ids: string[]
): ReadonlySet<string> {
  // A chat is matched by either id it is known by: the one it was asked with
  // and the one the runtime settled on (MB1); the run rows move with a rekey.
  const known = [...new Set(ids.flatMap((id) => [id, primaryOf(id)]))];
  // A run that is running now is known by its chat before its row is (M-A).
  const running = activeRunSessionsOf(known);
  try {
    if (typeof store.resolveTaskOrigins !== 'function') return new Set(ids);
    return new Set([...store.resolveTaskOrigins(known).keys(), ...running]);
  } catch {
    return new Set(ids);
  }
}

/**
 * The live sources over one store.
 *
 * @param store - The task store, which knows every run's chat.
 */
export function liveRunOriginSources(
  store: Pick<TaskStore, 'resolveTaskOrigins'>
): RunOriginSources {
  return {
    runSessions: (ids) => runSessionsOf(store, ids),
    startedBy: (id) => getSessionStartedByStore()?.get(id)?.startedBySessionId ?? null,
    turnSenders: chatTurnSendersOf,
    turnStarter: activeTurnStarterOf,
    beatSessions: (ids) => beatChatsAmong(ids),
    stampOf: stampedOriginOf,
  };
}

/**
 * What a new chat started from this one should be stamped with (ME): the walk's
 * answer now, while the run rows and the live sets behind it still hold. A walk
 * that throws stamps a run, so a chat nothing can vouch for is never ordinary.
 *
 * @param parentSessionId - The chat starting the new one.
 * @param store - The task store, which knows finished runs' chats. With the
 *   scheduler off there is none, and beats, stamps and live runs still answer.
 */
export function scheduledOriginStamp(
  parentSessionId: string,
  store?: Pick<TaskStore, 'resolveTaskOrigins'>
): ScheduledOrigin | null {
  try {
    return scheduledOriginOf(
      [parentSessionId],
      liveRunOriginSources(store ?? { resolveTaskOrigins: () => new Map() })
    );
  } catch {
    return 'run';
  }
}

/**
 * Whether any of these chats is, or was started by, a scheduled run.
 *
 * @param sessionIds - The calling chat, by every id it is known by.
 * @param sources - See {@link RunOriginSources}.
 */
export function startedByScheduledRun(sessionIds: string[], sources: RunOriginSources): boolean {
  return scheduledOriginOf(sessionIds, sources) !== null;
}

/**
 * What scheduled thing, if any, these chats are or were started by: a task's
 * run, or a heartbeat beat (MB2), which counts as one.
 *
 * @param sessionIds - The calling chat, by every id it is known by.
 * @param sources - See {@link RunOriginSources}.
 */
export function scheduledOriginOf(
  sessionIds: string[],
  sources: RunOriginSources
): ScheduledOrigin | null {
  const seen = new Set<string>();
  const queue = sessionIds.filter((id) => !!id);
  while (queue.length > 0 && seen.size < MAX_HOPS) {
    const batch = queue.splice(0).filter((id) => !seen.has(id));
    if (batch.length === 0) break;
    for (const id of batch) seen.add(id);
    if (sources.runSessions(batch).size > 0) return 'run';
    if ((sources.beatSessions?.(batch).size ?? 0) > 0) return 'heartbeat';
    for (const id of batch) {
      const stamp = sources.stampOf?.(id);
      if (stamp) return stamp;
      const parent = sources.startedBy(id);
      if (parent) queue.push(parent);
      queue.push(...sources.turnSenders(id));
    }
  }
  return null;
}

/**
 * The caller, with whether it comes from a scheduled run.
 *
 * @param caller - The caller as the surface verified it.
 * @param sources - See {@link RunOriginSources}.
 */
export function withRunOrigin(caller: AgentModeCaller, sources: RunOriginSources): AgentModeCaller {
  const ids = [caller.sessionId, ...(caller.turnSessionIds ?? [])].filter(
    (id): id is string => !!id
  );
  const origin = ids.length > 0 ? scheduledOriginOf(ids, sources) : null;
  if (origin === null) return caller;
  return { ...caller, scheduledRun: true, ...(origin === 'heartbeat' ? { heartbeat: true } : {}) };
}

/** What a started-by record says about the chat at the root of a chain. */
type StartedByKind = (
  sessionId: string
) => { kind: 'extension' | 'chat'; extensionId: string | null } | null;

/**
 * Who started the calling chat's turn, as a person reads it (M6): a heartbeat,
 * a scheduled run, an extension, another chat, or the person themselves.
 *
 * @param caller - The caller, with {@link withRunOrigin} applied.
 * @param sources - See {@link RunOriginSources}.
 * @param recordOf - The chat's started-by record; the live store by default.
 */
export function turnStarterOf(
  caller: AgentModeCaller,
  sources: RunOriginSources,
  recordOf: StartedByKind = (id) => getSessionStartedByStore()?.get(id) ?? null
): string {
  if (caller.heartbeat) return 'a heartbeat';
  if (caller.scheduledRun) return 'a scheduled run';
  const sessionId = caller.sessionId;
  if (!sessionId) return 'an agent DorkOS cannot name';
  const starter = sources.turnStarter?.(sessionId);
  if (starter !== undefined) return starter;
  if (sources.turnSenders(sessionId).length > 0) return 'a message from another chat';
  const record = recordOf(sessionId);
  if (record?.kind === 'extension') return `the ${record.extensionId ?? 'unnamed'} extension`;
  return record?.kind === 'chat' ? 'another chat' : 'you';
}
