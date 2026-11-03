/**
 * Whether a tool call comes from a scheduled run (DOR-3703, Security ruling of
 * Nov 3, condition 3 and M7). A turn a scheduled run started counts as that
 * run: the run's own chat, a spin-off it started (`session_start`, kept in
 * `session_started_by`), and a chat whose running turn a message from it
 * started (`chat_send`, kept by `chat-started-turns.ts`), at any distance.
 *
 * The `chat_send` hop is kept in memory, from the turn's start, and a restart
 * mid-turn loses it. That turn also loses its recorded level, which is kept
 * the same way, so it fails toward the stricter reading: the decision holds a
 * chat with no recorded level to the lowest level (S-B), and an edit from it is
 * never vouched for (`contentEditVouched`).
 *
 * @module services/tasks/agent-mode/agent-mode-run-origin
 */
import type { TaskStore } from '../task-store.js';
import { getSessionStartedByStore } from '../../session/origin/session-started-by-store.js';
import { chatTurnSendersOf } from '../../session/chat-messages/chat-started-turns.js';
import { activeRunSessionsOf } from '../session/active-run-sessions.js';
import type { AgentModeCaller } from './agent-mode-decision.js';

/** The most chats walked, against a cycle nothing should make. */
const MAX_HOPS = 64;

/** Where the walk reads who started a chat and its turn. Injected so a test can fake each. */
export interface RunOriginSources {
  /** The scheduled runs among these chats, as `resolveTaskOrigins` answers. */
  runSessions: (sessionIds: string[]) => ReadonlySet<string>;
  /** The chat that started a chat with `session_start`, or `null`. */
  startedBy: (sessionId: string) => string | null;
  /** The chats whose messages started a chat's running turn. */
  turnSenders: (sessionId: string) => readonly string[];
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
  // A run that is running now is known by its chat before its row is (M-A).
  const running = activeRunSessionsOf(ids);
  try {
    if (typeof store.resolveTaskOrigins !== 'function') return new Set(ids);
    return new Set([...store.resolveTaskOrigins(ids).keys(), ...running]);
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
  };
}

/**
 * Whether any of these chats is, or was started by, a scheduled run.
 *
 * @param sessionIds - The calling chat, by every id it is known by.
 * @param sources - See {@link RunOriginSources}.
 */
export function startedByScheduledRun(sessionIds: string[], sources: RunOriginSources): boolean {
  const seen = new Set<string>();
  const queue = sessionIds.filter((id) => !!id);
  while (queue.length > 0 && seen.size < MAX_HOPS) {
    const batch = queue.splice(0).filter((id) => !seen.has(id));
    if (batch.length === 0) break;
    for (const id of batch) seen.add(id);
    if (sources.runSessions(batch).size > 0) return true;
    for (const id of batch) {
      const parent = sources.startedBy(id);
      if (parent) queue.push(parent);
      queue.push(...sources.turnSenders(id));
    }
  }
  return false;
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
  return ids.length > 0 && startedByScheduledRun(ids, sources)
    ? { ...caller, scheduledRun: true }
    : caller;
}

/** What a started-by record says about the chat at the root of a chain. */
type StartedByKind = (
  sessionId: string
) => { kind: 'extension' | 'chat'; extensionId: string | null } | null;

/**
 * Who started the calling chat's turn, as a person reads it (M6): a scheduled
 * run, an extension, another chat, or the person themselves.
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
  if (caller.scheduledRun) return 'a scheduled run';
  const sessionId = caller.sessionId;
  if (!sessionId) return 'an agent DorkOS cannot name';
  if (sources.turnSenders(sessionId).length > 0) return 'a message from another chat';
  const record = recordOf(sessionId);
  if (record?.kind === 'extension') return `the ${record.extensionId ?? 'unnamed'} extension`;
  return record?.kind === 'chat' ? 'another chat' : 'you';
}
