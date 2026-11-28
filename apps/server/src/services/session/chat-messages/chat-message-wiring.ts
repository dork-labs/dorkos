/**
 * The production halves of chats messaging chats (spec `spin-off-chats`): how
 * the service reads a chat's title, folder, level and history, stops a turn,
 * and tells a chat's windows its messaging changed. Split from the service so
 * the service reads as rules; tests replace each of these.
 *
 * @module services/session/chat-messages/chat-message-wiring
 */
import { noteSteeredInto } from './chat-started-turns.js';
import { setQueuedChatView } from '../message-queue-store.js';
import { queuedChatViewOf } from './queued/queued-chat-view.js';
import type { MeshCore } from '@dorkos/mesh';
import type { Db } from '@dorkos/db';
import { filterKickoffHistory } from '@dorkos/shared/kickoff';
import type { HistoryMessage, PendingInteractionDTO } from '@dorkos/shared/types';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { sessionAgentById } from '../../core/agent-identity/session-agent.js';
import { marksOf, passedOnLevelOf } from '../../core/turn-power/turn-levels.js';
import {
  describeSessionFor,
  isSessionBusy,
  liveSessionCwd,
} from '../../extensions/agent-send/agent-send-defaults.js';
import { searchMessages } from '../../search/query.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import {
  deliverSteer,
  setQueuedChatCeilingResolver,
  setQueuedChatHoldResolver,
  setQueuedChatWordsResolver,
} from '../message-dispatcher.js';
import { setQueuedChatJoiner } from '../message-dispatcher/state.js';
import { rememberedChatTitle } from '../origin/started-by-origin-overlay.js';
import { getSessionStartedByStore } from '../origin/session-started-by-store.js';
import { auditTrail } from '../../audit/audit-trail.js';
import {
  canReadSession,
  readSessionVisibilities,
  type SessionInvolvement,
} from '../../audit/session-visibility.js';
import type { AuditReader } from '../../audit/visibility.js';
import { resolveSessionCwdOrNull } from '../resolution/resolve-read-cwd.js';
import { followChatRekey } from '../turn-identity/follow-chat-rekey.js';
import {
  onProjectorInteractionChange,
  onProjectorStatusChange,
  onProjectorTurnBoundary,
  peekProjector,
} from '../session-state-projector.js';
import { logError, logger } from '../../../lib/logger.js';
import type { ChatCaller } from './chat-message-service.js';
import { ChatMessageService } from './chat-message-service.js';
import { rowsCarryHold, rowsCarryWords } from './chat-message-ceiling.js';
import {
  wireRoomSeatMessageLifetime,
  getRoomSeatReports,
  setChatMessageService,
} from './chat-message-current.js';
import { setChatMessageStore, type ChatMessageStore } from './chat-message-store.js';
import { stampHistory } from './chat-message-stamps.js';
import { setChatReportBack } from './chat-message-current.js';
import { reportStartedAtFromStore, reportTargetFromStore } from './report-back/report-target.js';
import { randomUUID } from 'node:crypto';
import { ChatReportBack, type RoomSeatReport } from './chat-report-back.js';
import type { ChatReadDeps } from './chat-read.js';
import { notifyUndeliveredReport } from './report-undelivered.js';
import { resolveAgentIdForPath } from '../../mesh/agent-path-lookup.js';
import { notify } from '../../notifications/notification-service.js';
import { getSpinOffStartup } from './startup/spin-off-startup.js';
import { wireSpinOffStartup } from './startup/wire-spin-off-startup.js';
import { readOperatorDisplayName } from '../../core/config/operator-display-name.js';
import { setQueuedChatActionsDeps } from './queued/queued-chat-actions.js';
import { chatUsagePauseOf } from './sending/chat-usage-pause.js';
import type { ChatTurnPort } from './sending/chat-turn-hand-over.js';

/**
 * An access bound, not a display one: how many levels down its chain of
 * spin-offs (carried moves included) a chat may read. It is the reach the
 * hand-written walk had before `childrenOf` took a depth, and it is apart from
 * the lineage query's `LINEAGE_MAX_DEPTH` on purpose. Widening it changes who
 * can read what, so it is its own change, with Security's read.
 */
const READ_REACH_DEPTH = 8;

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
 * started it, the chats it started and theirs, and the chats its agent has
 * exchanged chat messages with, from this chat or any other of its own. So a
 * beat or a scheduled run can read the chat it asked a question, and the
 * agent's next chat can read it too. Stopping a chat does not make it
 * readable.
 *
 * Inside that, the reader rule still holds (spec `audit-trail` §3.4): a
 * person's own chat is read only under `canReadSession`'s one exception, when
 * that chat itself started the reader. A private chat the agent messaged, one
 * that messaged it, or one it reaches only as a descendant, is refused.
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
    store.agentExchangedWith(caller.agentPath, target) ||
    startedBy?.childrenOf(caller.sessionId, READ_REACH_DEPTH).includes(target) === true;
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
  /** The turn port a message starts its turn through (T6b). */
  turns?: ChatTurnPort;
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
  const seatMessages = wireRoomSeatMessageLifetime(deps.store, emitChatActivity);
  const service = new ChatMessageService({
    store: deps.store,
    seatMessages: seatMessages.get,
    stopSeatMessages: seatMessages.stop,
    meshCore: deps.meshCore,
    roomSessionPlace: deps.roomSessionPlace,
    ...(deps.turns ? { turns: deps.turns } : {}),
    describeSession: describeSessionFor(deps.roomSessionPlace),
    chatTitle: chatTitleOf,
    sessionCwd: liveSessionCwd,
    isBusy: isSessionBusy,
    usagePauseOf: chatUsagePauseOf,
    interruptTurn: interruptChatTurn,
    // A steer that lands carries its sender into the running turn (DOR-3703, M7).
    steerInto: async (sessionId, content, messageId) => {
      const landed = await steerChatTurn(sessionId, content, messageId);
      if (landed) {
        const from = deps.store.listByQueueMessage(messageId).map((row) => row.fromSessionId);
        noteSteeredInto(sessionId, from);
      }
      return landed;
    },
    canonicalId: canonicalChatId,
    turnLevelOf: passedOnLevelOf,
    emitActivity: emitChatActivity,
  });
  setChatMessageService(service);
  // Send now and Don't deliver on another chat's queued message (DOR-3060).
  setQueuedChatActionsDeps({
    store: deps.store,
    isBusy: isSessionBusy,
    turnLevelOf: passedOnLevelOf,
    steerInto: steerChatTurn,
    emitActivity: emitChatActivity,
    operatorName: readOperatorDisplayName,
  });
  wireChatReportBack(service, deps.store);
  setQueuedChatCeilingResolver((messageId) => service.ceilingForQueuedMessage(messageId));
  setQueuedChatHoldResolver((messageId) => rowsCarryHold(deps.store.listByQueueMessage(messageId)));
  setQueuedChatJoiner((fromRowId, toRowId) => {
    for (const row of deps.store.listByQueueMessage(fromRowId)) {
      deps.store.update(row.id, { queueMessageId: toRowId });
    }
  });
  setQueuedChatWordsResolver((messageId) =>
    rowsCarryWords(deps.store.listByQueueMessage(messageId))
  );
  // A person reads a row another chat sent as its senders and their words,
  // never the fenced envelope it holds for the model (DOR-3060).
  setQueuedChatView((row) => queuedChatViewOf((id) => deps.store.listByQueueMessage(id), row));
  const read: ChatReadDeps = {
    store: deps.store,
    mayRead: async (caller, target) => mayReadChat(deps.store, caller, target),
    maySeeTitle: async (caller, target) => maySeeChat(caller, target),
    history: chatHistoryOf,
    currentId: followChatRekey,
    startupFailure: (sessionId) => getSpinOffStartup()?.failureOf(sessionId) ?? null,
    status: (sessionId) => {
      const projector = peekProjector(sessionId);
      return projector
        ? { status: projector.getStatus(), needsYou: projector.hasPendingInteractions() }
        : null;
    },
    describe: async (sessionId) => {
      const title = await chatTitleOf(sessionId);
      // The chat's agent by `session-agent`, so a chat started with only its
      // agent's folder still names that agent (DOR-5038).
      const agentPath = await sessionAgentById(sessionId).catch(() => undefined);
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
/** The server-recorded parent, including verified account carries on either side. */
export function reportTargetOf(sessionId: string): { parentSessionId: string } | null {
  return reportTargetFromStore(getSessionStartedByStore(), sessionId);
}

/**
 * Deliver a spin-off's report to a parent that is a room's seat, as a turn
 * there (DOR-3488). The parent is looked up under the id it was named by and
 * the one it is known by now, since a seat's first turn is renamed mid-turn.
 * Settles only once the seat's turn has run or the report has given up, so a
 * report that never landed can be tried again (DOR-3720).
 *
 * @param parentSessionId - The chat the spin-off reports to.
 * @param report - The report.
 * @returns True when the seat's turn ran; false when neither id is a seat that takes it.
 * @throws Error when it is a seat and the report did not reach it.
 */
export async function deliverToRoomSeat(
  parentSessionId: string,
  report: RoomSeatReport
): Promise<boolean> {
  const seats = getRoomSeatReports();
  if (!seats) return false;
  const canonical = await canonicalChatId(parentSessionId).catch(() => parentSessionId);
  // Both ids are tried in turn: the first can be a seat's old chat that refuses this report. A
  // saved report goes only to the seat the outbox checked when it saved it.
  const { seat: checked, ...rest } = report;
  const candidates = [...new Set([parentSessionId, canonical])].filter((id) => {
    const seat = seats.seatOf(id);
    if (seat === null) return false;
    return !checked || (seat.roomId === checked.roomId && seat.authorId === checked.authorId);
  });
  if (candidates.length === 0) return false;
  const fromTitle = await chatTitleOf(report.fromSessionId);
  // A seat that moved checks this against the move (DOR-3753): only the server's record, set
  // last so no start a caller handed in survives.
  const startedAt = reportStartedAtFromStore(getSessionStartedByStore(), report.fromSessionId);
  const sent = { ...rest, fromTitle, startedAt: startedAt ?? undefined };
  return new Promise<boolean>((resolve, reject) => {
    const settled = (ran: boolean) => {
      if (ran) resolve(true);
      else reject(new Error('The report did not reach the room seat.'));
    };
    if (!candidates.some((seat) => seats.deliver(seat, sent, settled))) resolve(false);
  });
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
    outbox: store.handoffOutbox,
    service,
    store,
    reportTargetOf: (sessionId) => reportTargetOf(sessionId),
    agentPathOf: async (sessionId) =>
      (await runtimeRegistry.getSessionAgentPath(sessionId).catch(() => null)) ??
      getSpinOffStartup()?.agentPathOf(sessionId) ??
      null,
    marksOfTurn: (sessionId) => marksOf(sessionId, undefined),
    holdsBackgroundWork: async (sessionId) => {
      const runtime = await runtimeRegistry.resolveForSession(sessionId);
      return runtime.holdsBackgroundWork?.(sessionId) === true;
    },
    statusOf: (sessionId) => peekProjector(sessionId)?.getStatus() ?? null,
    history: chatHistoryOf,
    toRoomSeat: (parentSessionId, report) => deliverToRoomSeat(parentSessionId, report),
    onUndelivered: (report) =>
      notifyUndeliveredReport(report, {
        titleOf: chatTitleOf,
        agentPathOf: (id) => runtimeRegistry.getSessionAgentPath(id),
        agentIdOf: resolveAgentIdForPath,
        notify,
      }),
  });
  setChatReportBack(reportBack);
  const stopStartup = wireSpinOffStartup(reportBack);
  // What each chat's open ask is about, kept from the interaction events so the
  // "needs the person" report can say it; a DorkOS capability hold has none.
  const askWhat = new Map<string, string>();
  const turnStarts = new Map<string, number>();
  const offTurn = onProjectorTurnBoundary((sessionId, kind) => {
    if (kind !== 'turn_end' || getSpinOffStartup()?.isWatching(sessionId)) return;
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
  const waitEpoch = randomUUID();
  const offStatus = onProjectorStatusChange(({ sessionId, status }) => {
    // When each turn starts, so its report reads only the words it wrote.
    if (status.lifecycle === 'streaming' && !turnStarts.has(sessionId)) {
      turnStarts.set(sessionId, Date.now());
    }
    if (status.lifecycle !== 'blocked') return;
    waits += 1;
    void reportBack
      .onWaiting(sessionId, {
        key: `${sessionId}:${waitEpoch}:${waits}`,
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
    reportBack.stop();
    stopStartup();
    offTurn();
    offAsk();
    offStatus();
  };
}
