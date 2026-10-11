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
import type { HistoryMessage, PendingInteractionDTO } from '@dorkos/shared/types';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { lastTurnLevelOf } from '../../core/turn-power/turn-levels.js';
import {
  describeSessionFor,
  isSessionBusy,
  liveSessionCwd,
} from '../../extensions/agent-send/agent-send-defaults.js';
import { searchMessages } from '../../search/query.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import { deliverSteer, setQueuedChatCeilingResolver } from '../message-dispatcher.js';
import { rememberedChatTitle } from '../origin/started-by-origin-overlay.js';
import {
  getSessionStartedByStore,
  type SessionStartedByStore,
} from '../origin/session-started-by-store.js';
import { auditTrail } from '../../audit/audit-trail.js';
import {
  canReadSession,
  readSessionVisibilities,
  type SessionInvolvement,
} from '../../audit/session-visibility.js';
import type { AuditReader } from '../../audit/visibility.js';
import { resolveSessionCwdOrNull } from '../resolution/resolve-read-cwd.js';
import {
  onProjectorInteractionChange,
  onProjectorStatusChange,
  onProjectorTurnBoundary,
  peekProjector,
} from '../session-state-projector.js';
import { logError, logger } from '../../../lib/logger.js';
import type { ChatCaller } from './chat-message-service.js';
import { ChatMessageService, setChatMessageService } from './chat-message-service.js';
import { setChatMessageStore, type ChatMessageStore } from './chat-message-store.js';
import { stampHistory } from './chat-message-stamps.js';
import { ChatReportBack } from './chat-report-back.js';
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
 * Join a chat's running turn with another chat's message — a steer — through
 * the dispatcher's one steer path, as the window that holds the turn. True when
 * it landed. The caller has already checked the turn runs no looser than the
 * sender (`ChatMessageService.maySteer`).
 *
 * @param sessionId - The chat.
 * @param content - What the agent reads.
 * @param messageId - The message's id, which the `turn_input` carries.
 */
export async function steerChatTurn(
  sessionId: string,
  content: string,
  messageId: string
): Promise<boolean> {
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const lockKey = runtime.getInternalSessionId(sessionId) ?? sessionId;
  const holder = runtime.getLockInfo(lockKey)?.clientId;
  if (!holder) return false;
  const result = await deliverSteer({ sessionId, clientId: holder, content, messageId, runtime });
  return result.authorized && result.delivered;
}

/**
 * The id a chat is known by now.
 *
 * @param sessionId - Either id it answers to.
 */
export async function canonicalChatId(sessionId: string): Promise<string> {
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  return runtime.getInternalSessionId(sessionId) ?? sessionId;
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
 * started it, the chats it started and theirs, and the chats that have sent it
 * a message. Sending a chat a message, or stopping it, does not make it
 * readable: send reaches further than read until roles exist.
 *
 * Inside that, the reader rule still holds (spec `audit-trail` §3.4): a
 * person's own chat is read only under `canReadSession`'s one exception, when
 * that chat itself started the reader. A private chat that merely messaged the
 * reader, or one it reaches only as a descendant, is refused.
 *
 * @param store - The chat-message store.
 * @param caller - The reading chat.
 * @param target - The chat it wants to read.
 */
export function mayReadChat(store: ChatMessageStore, caller: ChatCaller, target: string): boolean {
  if (target === caller.sessionId) return true;
  const startedBy = getSessionStartedByStore();
  const involvedBy: SessionInvolvement = {
    startedReader: startedBy?.get(caller.sessionId)?.startedBySessionId === target,
  };
  const related =
    involvedBy.startedReader ||
    store.sendersTo(caller.sessionId).has(target) ||
    (startedBy !== undefined && startedDescendant(startedBy, caller.sessionId, target));
  if (!related) return false;
  const visibility = readSessionVisibilities([target]).get(target) ?? 'participants';
  return canReadSession(chatReader(caller), visibility, involvedBy);
}

/**
 * Whether a chat may know of `target` at all, by the reader rule alone (spec
 * `audit-trail` §3.4): itself, agent work it may read, or the private chat that
 * started it. No relation is needed, and a message sent is not one.
 *
 * @param caller - The chat asking.
 * @param target - The chat it asks about.
 */
export function maySeeChat(caller: ChatCaller, target: string): boolean {
  if (target === caller.sessionId) return true;
  const startedReader =
    getSessionStartedByStore()?.get(caller.sessionId)?.startedBySessionId === target;
  const visibility = readSessionVisibilities([target]).get(target) ?? 'participants';
  return canReadSession(chatReader(caller), visibility, { startedReader });
}

/** Whether `target` is in the chain of chats `root` started, a few levels down. */
function startedDescendant(
  startedBy: SessionStartedByStore,
  root: string,
  target: string
): boolean {
  let frontier = [root];
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

/** The agent behind a reading chat, as the reader rule names it. */
function chatReader(caller: ChatCaller): AuditReader {
  const accounts = auditTrail()?.accounts;
  return {
    kind: 'agent',
    accountId: accounts ? accounts.agentAtHome(caller.agentPath).accountId : 'unidentified',
  };
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
    steerInto: steerChatTurn,
    canonicalId: canonicalChatId,
    turnLevelOf: lastTurnLevelOf,
    emitActivity: emitChatActivity,
  });
  setChatMessageService(service);
  wireChatReportBack(service, deps.store);
  setQueuedChatCeilingResolver((messageId) => service.ceilingForQueuedMessage(messageId));
  const read: ChatReadDeps = {
    store: deps.store,
    mayRead: async (caller, target) => mayReadChat(deps.store, caller, target),
    maySeeTitle: async (caller, target) => maySeeChat(caller, target),
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

/**
 * What an ask is about, in one plain line, for a spin-off's "needs the person"
 * report.
 *
 * @param interaction - The pending ask.
 */
export function describeAsk(interaction: PendingInteractionDTO): string {
  switch (interaction.type) {
    case 'approval':
      return `It asks to use ${interaction.displayName ?? interaction.toolName}${
        interaction.description ? `: ${interaction.description}` : '.'
      }`;
    case 'question':
      return `It asks: ${interaction.questions.map((q) => q.question).join(' / ')}`;
    case 'elicitation':
      return `${interaction.serverName} asks: ${interaction.message}`;
    default:
      return 'It is waiting for an answer.';
  }
}

/** How many carry-overs and moves a report follows before it gives up. */
const CARRY_DEPTH = 10;

/**
 * The parent a chat reports to, or null when it does not report: the chat
 * that started it, found past any account moves on either side. A chat
 * carried to another account reports for the chat it replaced, to that
 * chat's starter; and a parent that was carried reports onward to the chat
 * it was carried to, not to the one on the exhausted account.
 *
 * @param sessionId - The chat whose turn ended.
 */
export function reportTargetOf(sessionId: string): { parentSessionId: string } | null {
  const startedBy = getSessionStartedByStore();
  let record = startedBy?.get(sessionId) ?? null;
  for (let i = 0; record?.carried && record.startedBySessionId && i < CARRY_DEPTH; i += 1) {
    record = startedBy?.get(record.startedBySessionId) ?? null;
  }
  if (!record || record.kind !== 'chat' || !record.reportBack || !record.startedBySessionId) {
    return null;
  }
  let parent = record.startedBySessionId;
  for (let i = 0; i < CARRY_DEPTH; i += 1) {
    const next = startedBy?.carriedSuccessorOf(parent);
    if (!next) break;
    parent = next;
  }
  return { parentSessionId: parent };
}

/**
 * Make spin-off chats report back on their own (spec `spin-off-chats` §5):
 * listen for every turn that ends and every ask that opens, on every runtime.
 *
 * @param service - The chat-message service the reports are sent through.
 * @param store - The chat-message store.
 * @returns A function that stops listening.
 */
export function wireChatReportBack(
  service: ChatMessageService,
  store: ChatMessageStore
): () => void {
  const reportBack = new ChatReportBack({
    service,
    store,
    reportTargetOf: (sessionId) => reportTargetOf(sessionId),
    agentPathOf: (sessionId) => runtimeRegistry.getSessionAgentPath(sessionId),
    holdsBackgroundWork: async (sessionId) => {
      const runtime = await runtimeRegistry.resolveForSession(sessionId);
      return runtime.holdsBackgroundWork?.(sessionId) === true;
    },
    statusOf: (sessionId) => peekProjector(sessionId)?.getStatus() ?? null,
    history: chatHistoryOf,
  });
  // What each chat's open ask is about, kept from the interaction events so the
  // "needs the person" report can say it; a DorkOS capability hold has none.
  const askWhat = new Map<string, string>();
  const turnStarts = new Map<string, number>();
  const offTurn = onProjectorTurnBoundary((sessionId, kind) => {
    if (kind !== 'turn_end') return;
    // Read NOW, in the boundary itself: a queued message starts the next turn
    // a moment later and would change both.
    const ended = peekProjector(sessionId)?.getStatus() ?? null;
    const window = { from: turnStarts.get(sessionId), to: Date.now() };
    turnStarts.delete(sessionId);
    void reportBack.onTurnEnd(sessionId, ended, window).catch((err: unknown) =>
      logger.warn('[chat report-back] turn end could not be reported', {
        sessionId,
        ...logError(err),
      })
    );
  });
  const offAsk = onProjectorInteractionChange((change) => {
    if (change.type === 'pending') askWhat.set(change.sessionId, describeAsk(change.interaction));
    else askWhat.delete(change.sessionId);
  });
  // Every way a chat starts waiting on the person — an approval, a question,
  // an MCP form, a DorkOS capability hold — moves its lifecycle to `blocked`.
  let waits = 0;
  const offStatus = onProjectorStatusChange(({ sessionId, status }) => {
    // When each turn starts, so its report reads only the words it wrote.
    if (status.lifecycle === 'streaming' && !turnStarts.has(sessionId)) {
      turnStarts.set(sessionId, Date.now());
    }
    if (status.lifecycle !== 'blocked') return;
    waits += 1;
    void reportBack
      .onWaiting(sessionId, {
        key: `${sessionId}:${waits}`,
        what: askWhat.get(sessionId) ?? 'It is waiting for the person to approve something.',
      })
      .catch((err: unknown) =>
        logger.warn('[chat report-back] a wait could not be reported', {
          sessionId,
          ...logError(err),
        })
      );
  });
  return () => {
    offTurn();
    offAsk();
    offStatus();
  };
}
