/**
 * The production halves of chats messaging chats (spec `spin-off-chats`): how
 * the service reads a chat's title, folder, level and history, stops a turn,
 * and tells a chat's windows its messaging changed. Split from the service so
 * the service reads as rules; tests replace each of these.
 *
 * @module services/session/chat-messages/chat-message-wiring
 */
import type { MeshCore } from '@dorkos/mesh';
import type { Db } from '@dorkos/db';
import { filterKickoffHistory } from '@dorkos/shared/kickoff';
import type { HistoryMessage } from '@dorkos/shared/types';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { lastTurnLevelOf } from '../../core/turn-power/turn-levels.js';
import {
  describeSessionFor,
  isSessionBusy,
  liveSessionCwd,
} from '../../extensions/agent-send/agent-send-defaults.js';
import { searchMessages } from '../../search/query.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import { setQueuedChatCeilingResolver } from '../message-dispatcher.js';
import { rememberedChatTitle } from '../origin/started-by-origin-overlay.js';
import { getSessionStartedByStore } from '../origin/session-started-by-store.js';
import { resolveSessionCwdOrNull } from '../resolution/resolve-read-cwd.js';
import { peekProjector } from '../session-state-projector.js';
import { logError, logger } from '../../../lib/logger.js';
import type { ChatCaller } from './chat-message-service.js';
import { ChatMessageService, setChatMessageService } from './chat-message-service.js';
import { setChatMessageStore, type ChatMessageStore } from './chat-message-store.js';
import { stampHistory } from './chat-message-stamps.js';
import type { ChatReadDeps } from './chat-read.js';

/** How far down a chat's chain of spin-offs a reader may follow. */
const DESCENDANT_DEPTH = 8;

/**
 * A chat's title: the one this process last listed, else its runtime's.
 *
 * @param sessionId - The chat.
 */
export async function chatTitleOf(sessionId: string): Promise<string | null> {
  const remembered = rememberedChatTitle(sessionId);
  if (remembered) return remembered;
  try {
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const found = await runtime.findSession?.(runtime.getInternalSessionId(sessionId) ?? sessionId);
    return found?.title ?? null;
  } catch {
    return null;
  }
}

/**
 * Stop a chat's running turn, the way the Stop button does, without touching
 * its queue. True when a turn was running and the runtime took the stop.
 *
 * @param sessionId - The chat.
 */
export async function interruptChatTurn(sessionId: string): Promise<boolean> {
  if (!(await isSessionBusy(sessionId).catch(() => false))) return false;
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const receipt = await runtime.interruptQuery(sessionId);
  return (
    receipt.outcome === 'acked' || receipt.outcome === 'closed' || receipt.outcome === 'unconfirmed'
  );
}

/**
 * Tell a chat's open windows its messaging changed.
 *
 * @param sessionId - The chat.
 */
export function emitChatActivity(sessionId: string): void {
  if (!sessionId) return;
  peekProjector(sessionId)?.ingest({ type: 'chat_activity' });
}

/**
 * A chat's history as a reader gets it: the runtime's own, without the
 * kickoff, with senders stamped.
 *
 * @param sessionId - The chat.
 */
export async function chatHistoryOf(sessionId: string): Promise<HistoryMessage[]> {
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const internal = runtime.getInternalSessionId(sessionId) ?? sessionId;
  const cwd = await resolveSessionCwdOrNull(runtime, sessionId, undefined);
  if (!cwd) return [];
  const messages = await runtime.getMessageHistory(cwd, internal);
  return stampHistory([...new Set([sessionId, internal])], filterKickoffHistory(messages));
}

/**
 * Every chat a chat may read (spec `spin-off-chats` §4): itself, the chat that
 * started it, the chats it started and theirs, and the chats it has exchanged
 * messages with.
 *
 * @param store - The chat-message store.
 * @param caller - The reading chat.
 * @param target - The chat it wants to read.
 */
export function mayReadChat(store: ChatMessageStore, caller: ChatCaller, target: string): boolean {
  if (target === caller.sessionId) return true;
  const startedBy = getSessionStartedByStore();
  if (startedBy?.get(caller.sessionId)?.startedBySessionId === target) return true;
  if (store.correspondentsOf(caller.sessionId).has(target)) return true;
  if (!startedBy) return false;
  let frontier = [caller.sessionId];
  const seen = new Set(frontier);
  for (let depth = 0; depth < DESCENDANT_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of startedBy.childrenOf(id)) {
        if (child === target) return true;
        if (!seen.has(child)) {
          seen.add(child);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  return false;
}

/** What boot hands {@link wireChatMessaging}. */
export interface WireChatMessagingDeps {
  /** The database (search index, stores). */
  db: Db;
  /** The store. */
  store: ChatMessageStore;
  /** Mesh, when running. */
  meshCore: () => MeshCore | undefined;
  /** The room binding port. */
  roomSessionPlace: () => RoomSessionPlacePort | undefined;
}

/**
 * Build the chat-message service and its read side, wire both, and hand the
 * dispatcher the ceiling of a chat-sent queue row.
 *
 * @param deps - What boot holds.
 * @returns The capability deps for the `chat` domain, and the service.
 */
export function wireChatMessaging(deps: WireChatMessagingDeps): {
  service: ChatMessageService;
  read: ChatReadDeps;
} {
  setChatMessageStore(deps.store);
  const service = new ChatMessageService({
    store: deps.store,
    meshCore: deps.meshCore,
    roomSessionPlace: deps.roomSessionPlace,
    describeSession: describeSessionFor(deps.roomSessionPlace),
    chatTitle: chatTitleOf,
    sessionCwd: liveSessionCwd,
    isBusy: isSessionBusy,
    interruptTurn: interruptChatTurn,
    turnLevelOf: lastTurnLevelOf,
    emitActivity: emitChatActivity,
  });
  setChatMessageService(service);
  setQueuedChatCeilingResolver((messageId) => service.ceilingForQueuedMessage(messageId));
  const read: ChatReadDeps = {
    store: deps.store,
    mayRead: async (caller, target) => mayReadChat(deps.store, caller, target),
    history: chatHistoryOf,
    status: (sessionId) => {
      const projector = peekProjector(sessionId);
      return projector
        ? { status: projector.getStatus(), needsYou: projector.hasPendingInteractions() }
        : null;
    },
    describe: async (sessionId) => {
      const title = await chatTitleOf(sessionId);
      const agentPath = await runtimeRegistry.getSessionAgentPath(sessionId).catch(() => null);
      const agent = agentPath
        ? deps
            .meshCore()
            ?.listWithPaths()
            .find((a) => a.projectPath === agentPath)
        : undefined;
      return { title, agent: agent ? (agent.displayName ?? agent.name) : null };
    },
    search: async (sessionId, query, limit) => {
      try {
        const runtime = await runtimeRegistry.resolveForSession(sessionId);
        const originKey = runtime.getInternalSessionId(sessionId) ?? sessionId;
        return searchMessages(deps.db, {
          scopes: [
            { sourceId: runtime.type, visibility: 'containers', containers: [{ originKey }] },
          ],
          query,
          limit,
        }).flatMap((hit) => (hit.messageId ? [hit.messageId] : []));
      } catch (err) {
        logger.warn('[chat_read] search failed', { sessionId, ...logError(err) });
        return [];
      }
    },
  };
  return { service, read };
}
