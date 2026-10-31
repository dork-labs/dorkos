/**
 * Every chat with a live turn right now, per agent, spin-offs included
 * (DOR-3460). The one server definition of "running": what `chat_read` calls
 * `running` or `needs-you`, read off the same projectors. Room turns and
 * scheduled runs count too, because they use an agent's capacity just the same,
 * so this can read higher than the sidebar's chip, which leaves them out.
 *
 * An agent reader never gets a person's own chat, not even its title (spec
 * `audit-trail` §3.4). It gets the number, as `get_session_count` already gives.
 *
 * @module services/session/running-chats
 */
import { chatMarkdownLink } from '@dorkos/shared/session-link';
import { isWithinDirectory } from '@dorkos/shared/paths';
import type {
  RunningChat,
  RunningChatsAgent,
  RunningChatsResponse,
  RunningChatState,
} from '@dorkos/shared/running-chats';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import type { MeshCore } from '@dorkos/mesh';
import { readableSessionIds } from '../../audit/session-visibility.js';
import type { AuditReader } from '../../audit/visibility.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { chatTitleOf } from '../chat-messages/chat-message-wiring.js';
import { chatStateOf } from '../chat-messages/chat-read.js';
import { getSessionStartedByStore } from '../origin/session-started-by-store.js';
import { listProjectorStatuses, peekProjector } from '../session-state-projector.js';

/** A live chat as the sources report it. */
interface LiveProjector {
  sessionId: string;
  cwd?: string | undefined;
  status: SessionStatus;
}

/** Where the read gets its facts. Replaced in tests. */
export interface RunningChatSources {
  /** Every session with a live projector. */
  statuses: () => LiveProjector[];
  /** Whether a session has a prompt waiting on someone. */
  needsYou: (sessionId: string) => boolean;
  /** The agent folder a session was bound to. */
  agentPathOf: (sessionId: string) => Promise<string | null>;
  /** A chat's title. */
  titleOf: (sessionId: string) => Promise<string | null>;
  /** The chat that started a session, if another chat did. */
  starterOf: (sessionId: string) => string | null;
}

const LIVE_SOURCES: RunningChatSources = {
  statuses: listProjectorStatuses,
  needsYou: (sessionId) => peekProjector(sessionId)?.hasPendingInteractions() ?? false,
  agentPathOf: (sessionId) => runtimeRegistry.getSessionAgentPath(sessionId).catch(() => null),
  titleOf: chatTitleOf,
  starterOf: (sessionId) => {
    const record = getSessionStartedByStore()?.get(sessionId);
    return record?.kind === 'chat' ? record.startedBySessionId : null;
  },
};

/** The roster fields this read uses. */
type Roster = Pick<MeshCore, 'listWithPaths'>;

/** Which agent folder owns a chat: its binding, else the deepest folder holding its cwd. */
function ownerFolder(
  folders: readonly string[],
  bound: string | null,
  cwd: string | undefined
): string | null {
  if (bound && folders.includes(bound)) return bound;
  if (!cwd) return null;
  const holding = folders.filter((folder) => isWithinDirectory(cwd, folder));
  return holding.sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * Read every running chat, grouped by agent, as `reader` may see them.
 *
 * In memory, so a turn a restart cut off is gone from here at once, and one
 * still running after a restart shows when its projector is rebuilt.
 *
 * @param roster - The agent registry, or undefined when Mesh is off.
 * @param reader - Who is asking.
 * @param sources - Where the facts come from.
 */
export async function listRunningChats(
  roster: Roster | undefined,
  reader: AuditReader,
  sources: RunningChatSources = LIVE_SOURCES
): Promise<RunningChatsResponse> {
  const live = sources.statuses().flatMap((entry) => {
    const state = chatStateOf({
      status: entry.status,
      needsYou: sources.needsYou(entry.sessionId),
    });
    return state === 'running' || state === 'needs-you'
      ? [{ ...entry, state: state as RunningChatState }]
      : [];
  });
  live.sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  const starters = new Map(live.map((chat) => [chat.sessionId, sources.starterOf(chat.sessionId)]));
  const readable = readableSessionIds(reader, [
    ...new Set([
      ...live.map((chat) => chat.sessionId),
      ...[...starters.values()].filter((id): id is string => id !== null),
    ]),
  ]);

  const agents = roster?.listWithPaths() ?? [];
  const folders = agents.map((agent) => agent.projectPath);
  const rows = await Promise.all(
    live.map(async (chat) => {
      const folder = ownerFolder(folders, await sources.agentPathOf(chat.sessionId), chat.cwd);
      if (!readable.has(chat.sessionId)) return { folder, chat: null };
      const title = await sources.titleOf(chat.sessionId);
      const starter = starters.get(chat.sessionId) ?? null;
      const row: RunningChat = {
        id: chat.sessionId,
        title,
        link: chatMarkdownLink(chat.sessionId, title),
        state: chat.state,
        spinOff: starter !== null,
        startedBy:
          starter && readable.has(starter)
            ? { id: starter, title: await sources.titleOf(starter) }
            : null,
      };
      return { folder, chat: row };
    })
  );

  const groupFor = (folder: string | null) => {
    const own = rows.filter((row) => row.folder === folder);
    const chats = own.flatMap((row) => (row.chat ? [row.chat] : []));
    return { count: own.length, privateCount: own.length - chats.length, chats };
  };
  const grouped: RunningChatsAgent[] = agents.map((agent) => ({
    agentId: agent.id,
    name: agent.displayName ?? agent.name,
    projectPath: agent.projectPath,
    ...groupFor(agent.projectPath),
  }));
  grouped.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return { total: rows.length, agents: grouped, unassigned: groupFor(null) };
}
