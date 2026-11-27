/**
 * Every chat with a live turn right now, per agent, spin-offs included
 * (DOR-3460). The one server definition of "running": what `chat_read` calls
 * `running` or `needs-you`, read off the same projectors. Room turns and
 * scheduled runs count too, because they use an agent's capacity just the same,
 * so this can read higher than the sidebar's chip, which leaves them out.
 *
 * A chat whose turn has ended while work it started still runs — a helper, a
 * background shell, a Monitor — is listed too, as `background` (DOR-2065): it
 * holds its agent's process and will speak again, so it is not free.
 *
 * An agent reader never gets a person's own chat, not even its title (spec
 * `audit-trail` §3.4). It gets the number, as `get_session_count` already gives.
 *
 * Filed with the chat messages on the space side, because it decides what each
 * reader may see; which chats still have background work is the computer
 * side's half, `session/running-chats/background-work.ts` (spec
 * `computer-side-starts-alone` §5.12).
 *
 * @module services/session/chat-messages/screen/running-chats
 */
import { dorkReferenceOrNull } from '@dorkos/shared/dork-ref';
import { chatRefMarkdownLink } from '@dorkos/shared/session-link';
import { isWithinDirectory } from '@dorkos/shared/paths';
import type {
  RunningChat,
  RunningChatsAgent,
  RunningChatsResponse,
  RunningChatState,
  SessionCapacity,
} from '@dorkos/shared/running-chats';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import type { MeshCore } from '@dorkos/mesh';
import { readableSessionIds } from '../../../audit/session-visibility.js';
import type { AuditReader } from '../../../audit/visibility.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { chatTitleOf } from '../chat-message-wiring.js';
import { chatStateOf } from '../chat-read.js';
import { getSessionStartedByStore } from '../../origin/session-started-by-store.js';
import { listProjectorStatuses, peekProjector } from '../../session-state-projector.js';
import { backgroundWorkOf, type LiveProjector } from '../../running-chats/background-work.js';
import { chatHoldsOutsideText } from '../../../core/turn-power/chat-outside-words.js';

/** Where the read gets its facts. Replaced in tests. */
export interface RunningChatSources {
  /** Record caps use the admission predicate, independently of visible projector counts. */
  capacity?: () => SessionCapacity[];
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
  /** `true` while a session's background work still runs; absent when nothing says so. */
  backgroundWork?: (sessionId: string, status: SessionStatus) => true | undefined;
}

const LIVE_SOURCES: RunningChatSources = {
  capacity: () =>
    Object.keys(runtimeRegistry.getAllCapabilities()).flatMap((type) => {
      const capacity = runtimeRegistry.get(type).getSessionCapacity?.();
      return capacity ? [capacity] : [];
    }),
  statuses: listProjectorStatuses,
  needsYou: (sessionId) => peekProjector(sessionId)?.hasPendingInteractions() ?? false,
  agentPathOf: (sessionId) => runtimeRegistry.getSessionAgentPath(sessionId).catch(() => null),
  titleOf: chatTitleOf,
  starterOf: (sessionId) => {
    const record = getSessionStartedByStore()?.get(sessionId);
    return record?.kind === 'chat' ? record.startedBySessionId : null;
  },
  backgroundWork: backgroundWorkOf,
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

/** How a read is narrowed for who is asking. */
export interface RunningChatsReadOptions {
  /**
   * Leave every title out, the starter's too (DOR-3971). A title is often a chat's opening words,
   * and a stranger can set a bridged group's name, so a turn where the status reads run unasked reads none of them. The link
   * still opens the chat.
   */
  withoutTitles?: boolean;
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
 * @param options - How the read is narrowed.
 */
export async function listRunningChats(
  roster: Roster | undefined,
  reader: AuditReader,
  sources: RunningChatSources = LIVE_SOURCES,
  options: RunningChatsReadOptions = {}
): Promise<RunningChatsResponse> {
  const titleOf = options.withoutTitles ? async () => null : sources.titleOf;
  const live = sources.statuses().flatMap((entry) => {
    const turn = chatStateOf({
      status: entry.status,
      needsYou: sources.needsYou(entry.sessionId),
    });
    const backgroundWork = sources.backgroundWork?.(entry.sessionId, entry.status);
    // `background` only for a chat that finished cleanly: a failed, stopped or
    // limit-paused one keeps saying so elsewhere, and is not listed here.
    const state: RunningChatState | null =
      turn === 'running' || turn === 'needs-you'
        ? turn
        : turn === 'done' && backgroundWork === true
          ? 'background'
          : null;
    return state ? [{ ...entry, state, backgroundWork }] : [];
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
      const title = await titleOf(chat.sessionId);
      const starter = starters.get(chat.sessionId) ?? null;
      const row: RunningChat = {
        id: chat.sessionId,
        title,
        link: chatRefMarkdownLink(chat.sessionId, title),
        ref: dorkReferenceOrNull('chat', chat.sessionId),
        state: chat.state,
        ...(chat.backgroundWork !== undefined ? { backgroundWork: chat.backgroundWork } : {}),
        spinOff: starter !== null,
        startedBy:
          starter && readable.has(starter) ? { id: starter, title: await titleOf(starter) } : null,
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

  const capacity = sources.capacity?.() ?? [];
  return {
    total: rows.length,
    agents: grouped,
    unassigned: groupFor(null),
    ...(capacity.length > 0 ? { capacity } : {}),
  };
}

/**
 * Whether a `running_chats` answer hands its reader outside words (DOR-3969): a listed chat holds
 * them, by the check `chat_read` uses, and the answer carries titles, which may quote them. A list
 * read without titles (a Never ask turn, DOR-3971) hands on nothing.
 *
 * @param running - The list as read.
 * @param withoutTitles - Whether the list was read without titles.
 */
export function runningChatsHandOutsideWords(
  running: RunningChatsResponse,
  withoutTitles: boolean
): boolean {
  if (withoutTitles) return false;
  const chats = [...running.agents.flatMap((agent) => agent.chats), ...running.unassigned.chats];
  return chats.some((chat) => chatHoldsOutsideText(chat.id));
}
