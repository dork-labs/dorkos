/**
 * Chats messaging chats (spec `spin-off-chats`, ADR 261009-171114): the one
 * place `chat_send`, `chat_read` and `chat_stop` are carried out, whatever
 * runtime the calling chat runs on.
 *
 * ## Sending
 *
 * 1. **Where it goes.** An agent's DM chat or a chat id, resolved by
 *    `chat-target.ts`, which also says which chats a chat may write into. Room-seat ids
 *    use the distinct verified seat route; bridged seats accept active answers only.
 * 2. **Who sent it.** The calling chat and its agent, read off the verified
 *    turn, never the input. A `chat_messages` row is written BEFORE the
 *    dispatch, with the fence nonce and the sender's level, so the turn it
 *    starts finds both.
 * 3. **How it arrives.** Through the turn port (T6b, `sending/chat-turn-hand-over.ts`),
 *    as the sending chat, so a full machine makes it wait for a slot with its
 *    place. Queue by default (the dispatcher holds it while the
 *    receiver is busy; an idle receiver starts at once). Every message keeps
 *    its own queue row. At the receiver's next turn boundary, the dispatcher
 *    joins adjacent agent rows into one turn, in the order they were sent
 *    (DOR-3054, DOR-3060).
 *    `steer` joins the running turn only when the receiver's turn runs no
 *    looser than the sender, because a steer cannot be held to a ceiling the
 *    running turn already passed; otherwise it waits in the queue and the
 *    receipt says why. Private seats always queue an aside, including steer/interrupt requests.
 *    Ordinary `interrupt` puts the message at the head of the queue
 *    and stops the running turn, so it runs next.
 * 4. **The power it carries.** None: the turn runs at the receiving agent's own
 *    level, except a teammate's chain, which rides on (`senderCeilingJson`).
 *
 * ## No loop guard
 *
 * Chats may talk to each other for days, weeks or months with no person in
 * between (Dorian 2026-10-08). Nothing here counts turns or caps a
 * ordinary-chat conversation; the launch cap counts machine load only. Private room-seat
 * messages instead use the bounded seat inbox and the existing room automatic-turn budget.
 *
 * @module services/session/chat-messages/chat-message-service
 */
import { CHAT_STOP_REASON_MAX } from './sending/chat-message-limits.js';
export { CHAT_SUMMARY_MAX, CHAT_STOP_REASON_MAX } from './sending/chat-message-limits.js';
import { answeringRoomTurn, sendChatMessage } from './sending/chat-send-message.js';
import type { ChatUsagePause } from './sending/chat-usage-recovery.js';
import type { RoomSeatMessagesPort } from '../../rooms/handoff/seat-message-types.js';
import { mayChatSteer, rowsCeiling, senderCeilingJson } from './chat-message-ceiling.js';
import crypto from 'node:crypto';
import type { MeshCore } from '@dorkos/mesh';
import type { WaitReason } from '@dorkos/shared/turn-port';
import type { ChatMessageRow } from '@dorkos/db';
import type { TurnPermissionCeiling, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type { TurnMarks } from '../../core/turn-power/turn-marks.js';
import type {
  ChatDelivery,
  ChatMessageKind,
  ChatMessageStatus,
  ChatStopNotice,
  SentChatMessage,
} from '@dorkos/shared/chat-messages';
import { pausedChatMessageNote } from './chat-message-receipt.js';
import { chatStopByLine, stopChatTurn } from './stops/chat-stop-record.js';
import { onDispatchLifecycle, type DispatchLifecycleEvent } from '../message-dispatcher.js';
import { getMessageQueueStore } from '../message-queue-store.js';
import { queueKeyOf } from '../resolution/session-key-registry.js';
import {
  noteChatTurnSettled,
  noteChatTurnStarted,
  noteOtherTurnStarted,
} from './chat-started-turns.js';
import { cancelQueuedMessage } from '../queued-message-edits.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import type { SessionFacts } from '../../extensions/agent-send/agent-send-defaults.js';
import { CHAT_MESSAGE_MAX, isChatClientId } from '@dorkos/shared/chat-client-id';
import { renderChatMessage } from './chat-message-fence.js';
import { stampOf } from './chat-message-stamps.js';
import type { FreshDmBirth } from './sending/chat-message-birth.js';
import type { ChatMessageStore } from './chat-message-store.js';
import { adoptHeldChatMessages } from './chat-held-adoption.js';
import {
  handOverChatMessage,
  MACHINE_FULL_NOTE,
  withdrawWaitingChatMessages,
  type ChatTurnPort,
} from './sending/chat-turn-hand-over.js';
import { attachChatRuns } from './sending/direct-chat-opening.js';
import { ChatMessageError } from './chat-message-error.js';
import * as standing from './chat-queue-standing.js';
import { assertChatSendable, sameChat, type ChatTarget } from './chat-target.js';
import { assertChatStoppable } from './stops/chat-stop-target.js';

export { ChatMessageError } from './chat-message-error.js';
export { CHAT_SENDABLE_ORIGINS, CHAT_UNATTENDED_ORIGINS } from './chat-target.js';

/** The calling chat, as the verified turn names it. */
export interface ChatCaller {
  /** The calling chat's id. */
  sessionId: string;
  /** The calling agent's home. */
  agentPath: string;
  /** For a report, set by the server alone: the marks of the turn it speaks for, read as it ended. */
  marksAtTurnEnd?: TurnMarks;
  /** Server report snapshot: outside words read before a restart remain outside words. */
  outsideWordsAtTurnEnd?: boolean;
}

/** What `chat_send` takes. */
export interface ChatSendInput {
  /** A chat id or an agent id. */
  to: string;
  /** The words (markdown). */
  message: string;
  /** The Sent card's one-line label. */
  summary?: string;
  /** How it should arrive. Default `queue`. */
  delivery?: ChatDelivery;
  /** The chat message this answers. */
  replyTo?: string;
}

/** What `chat_send` answers; while it waits, with its place in line. */
export interface ChatSendReceipt extends Partial<standing.QueueStanding> {
  /** The chat message's id. */
  messageId: string;
  /** The chat it went to. */
  chatId: string;
  /** Where it is now. */
  status: ChatMessageStatus;
  /** Why, when it already failed before this answer. */
  failureReason?: string;
  /** A plain sentence when it did not arrive exactly as asked. */
  note?: string;
}

/** What the chat-message service needs. Everything after `meshCore` has a production default in boot. */
export interface ChatMessageServiceDeps {
  /** Dedicated private-seat delivery, resolved after rooms boot. */
  seatMessages?: () => RoomSeatMessagesPort | undefined;
  /** Dispose this service's composition lifetime without touching a newer inbox. */
  stopSeatMessages?: () => void;

  /** The store. */
  store: ChatMessageStore;
  /** Mesh, when running. */
  meshCore: () => Pick<MeshCore, 'get' | 'getProjectPath' | 'listWithPaths'> | undefined;
  /** The room binding port. */
  roomSessionPlace?: () => RoomSessionPlacePort | undefined;
  /** What DorkOS knows about a chat. */
  describeSession: (sessionId: string) => Promise<SessionFacts>;
  /** A chat's title, or null. */
  chatTitle: (sessionId: string) => Promise<string | null>;
  /** The folder a chat runs in, when known. */
  sessionCwd: (sessionId: string) => Promise<string | undefined>;
  /** Whether a chat has a turn running. */
  isBusy: (sessionId: string) => Promise<boolean>;
  /** A current usage pause, so the sender is told before acceptance. */
  usagePauseOf?: (sessionId: string, cwd?: string) => Promise<ChatUsagePause | null>;
  /** The turn port a message starts its turn through (T6b), handed in at startup. */
  turns?: ChatTurnPort;
  /**
   * Join a chat's running turn with a message (a steer), whoever's window
   * holds that turn. True when it landed. Agents can do what people can; the
   * service has already checked the turn runs no looser than the sender.
   */
  steerInto: (sessionId: string, content: string, messageId: string) => Promise<boolean>;
  /** The id a chat is known by now, whichever id it was named by. */
  canonicalId: (sessionId: string) => Promise<string>;
  /** Stop a chat's running turn. True when one was running and was asked to stop. */
  interruptTurn: (sessionId: string) => Promise<boolean>;
  /** The level a chat hands on (its latest turn's), or undefined when not known. */
  turnLevelOf: (sessionId: string) => TurnPermissionLevel | undefined;
  /** Tell a chat's windows its messaging changed. */
  emitActivity: (sessionId: string) => void;
  /** Subscribe to the dispatcher's lifecycle. */
  onLifecycle?: (listener: (event: DispatchLifecycleEvent) => void) => () => void;
  /** A fence nonce (tests pin it). */
  nonce?: () => string;
  /** The clock (tests pin it). */
  now?: () => number;
}

/** What a sender is told about a message that waits before its words reach the chat's queue. */
function waitNote(reason: WaitReason | undefined): string | undefined {
  return reason === 'machine_full' ? MACHINE_FULL_NOTE : undefined;
}

/** The calling agent's name and Mesh id. */
interface AgentFacts {
  agentId: string | null;
  agentName: string;
}

/** The chat-message service. See the module documentation. */
export class ChatMessageService {
  private readonly now: () => number;
  private readonly unsubscribe: () => void;
  /** The space face this service's words are registered with, and how to let go. */
  private attached: { port: object; detach: () => void } | undefined;
  /** Sends opening an agent's DM chat, chained per (sender, agent), so two firsts open one chat. */
  private stopped = false;
  private seatInbox: RoomSeatMessagesPort | undefined;
  private readonly dmLocks = new Map<string, Promise<unknown>>();

  /**
   * Build the service, already listening to the dispatcher.
   *
   * @param deps - What it needs.
   */
  constructor(private readonly deps: ChatMessageServiceDeps) {
    const resolveSeat = deps.seatMessages;
    if (resolveSeat)
      this.deps = { ...deps, seatMessages: () => (this.seatInbox ??= resolveSeat()) };

    this.now = deps.now ?? Date.now;
    this.unsubscribe = (deps.onLifecycle ?? onDispatchLifecycle)((event) => this.onDispatch(event));
  }

  /** Stop listening, for a server shutting down. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe();
    this.attached?.detach();
    this.seatInbox?.stop();
    this.deps.stopSeatMessages?.();
  }

  /**
   * At boot: read waiting messages' words for the turn port, and start through
   * it the messages an earlier version held for a launch slot.
   */
  startTurns(): Promise<void> {
    this.attach();
    return adoptHeldChatMessages(this.deps);
  }

  /** Register its receipts as its waiting runs' words, and watch those runs, once per space face. */
  private attach(): void {
    const port = this.deps.turns?.port();
    if (!port || port === this.attached?.port || this.stopped) return;
    this.attached?.detach();
    this.attached = { port, detach: attachChatRuns(port, this.deps) };
  }

  /**
   * The ceiling a queue row a chat sent launches under: a teammate's chain any of its senders
   * carried, or nothing.
   *
   * @param queueMessageId - The dispatcher's message id.
   */
  ceilingForQueuedMessage(queueMessageId: string): TurnPermissionCeiling | undefined {
    return rowsCeiling(this.deps.store.listByQueueMessage(queueMessageId));
  }

  /**
   * Send a chat a message from the calling chat.
   *
   * @param caller - The calling chat, from the verified turn.
   * @param input - What to send.
   * @param kind - `message`, or `start`/`report` for the server's own sends.
   * @throws ChatMessageError when the input breaks a rule or the target refuses.
   */
  async send(
    caller: ChatCaller,
    input: ChatSendInput,
    kind: Extract<ChatMessageKind, 'message' | 'report'> = 'message'
  ): Promise<ChatSendReceipt> {
    if (this.stopped)
      throw new ChatMessageError('UNAVAILABLE', 'Messaging stopped. Try again after restart.');
    if (input.message.trim() === '')
      throw new ChatMessageError('INVALID_INPUT', 'Say what the message is.');
    if (input.message.length > CHAT_MESSAGE_MAX) {
      throw new ChatMessageError(
        'INVALID_INPUT',
        `Keep a message under ${CHAT_MESSAGE_MAX.toLocaleString('en-US')} characters.`
      );
    }
    const agentLock = this.agentLockKey(caller, input.to);
    return answeringRoomTurn(this.deps, caller, kind, () =>
      this.withDmLock(agentLock, () => this.sendLocked(caller, input, kind))
    );
  }

  private async sendLocked(
    caller: ChatCaller,
    input: ChatSendInput,
    kind: Extract<ChatMessageKind, 'message' | 'report'>
  ): Promise<ChatSendReceipt> {
    return sendChatMessage({
      deps: this.deps,
      caller,
      input,
      delivery: input.delivery ?? 'queue',
      kind,
      sender: this.agentFacts(caller.agentPath),
      deliver: (...args) => this.deliver(...args),
    });
  }

  /** Start one message's turn through the turn port, or steer it in, by the delivery asked for. */
  private async deliver(
    caller: ChatCaller,
    row: ChatMessageRow,
    target: ChatTarget,
    content: string,
    delivery: ChatDelivery,
    birth?: FreshDmBirth,
    onAccepted?: () => void
  ): Promise<ChatSendReceipt> {
    // Null when the check failed: not known to be busy, so nothing is steered.
    const busy =
      target.sessionId !== null && (await this.deps.isBusy(target.sessionId).catch(() => null));

    let note: string | undefined;
    if (delivery === 'steer' && target.sessionId !== null && busy) {
      // Only into a turn that runs no looser than the sender: a running turn
      // cannot be lowered to the sender's ceiling.
      if (!mayChatSteer(this.deps, caller.sessionId, target.sessionId)) {
        note =
          'It waits for the turn to end instead of joining it, because that turn may do more ' +
          'than your chat can.';
      } else if (row.queueMessageId) {
        const landed = await this.deps
          .steerInto(target.sessionId, content, row.queueMessageId)
          .catch(() => false);
        if (landed) {
          this.deps.store.update(row.id, {
            toSessionId: target.sessionId,
            status: 'steered',
            queueMessageId: null,
          });
          return { messageId: row.id, chatId: target.sessionId, status: 'steered' };
        }
        note =
          'That chat can’t take a message mid-turn right now, so it waits for the turn to end.';
      }
    }

    const sessionId = target.sessionId ?? target.newSessionId;
    if (!sessionId || (target.sessionId === null && !birth))
      throw new ChatMessageError('UNAVAILABLE', 'DorkOS could not resolve this chat.');
    const cwd = target.sessionId ? await this.deps.sessionCwd(target.sessionId) : undefined;
    // Through the turn port (T6b): a full machine makes it wait for a slot, with
    // its place, rather than refusing a new chat or holding it here.
    this.attach();
    const handed = await handOverChatMessage(this.deps.turns, {
      fromSessionId: caller.sessionId,
      row,
      sessionId,
      ...(target.agent ? { agent: target.agent } : {}),
      ...(cwd ? { cwd } : {}),
      content,
      ...(birth ? { birth } : {}),
    });
    onAccepted?.();
    const { chatId } = handed;
    if (target.agent && target.sessionId === null) {
      this.deps.store.keepDmChat(caller.agentPath, target.agent.id, chatId);
    }
    const queued = handed.kind === 'waiting' || handed.queued;

    // A turn that started inside the hand-over already moved the row on.
    const current = this.deps.store.get(row.id);
    const status: ChatMessageStatus =
      current && current.status !== 'queued' ? current.status : queued ? 'queued' : 'working';
    this.deps.store.update(row.id, { toSessionId: chatId, status });

    let position = queued ? handed.queuePosition : undefined;
    if (handed.kind === 'waiting') note = waitNote(handed.waitReason) ?? note;
    else if (delivery === 'interrupt' && handed.queued && row.queueMessageId) {
      position = standing.moveToHead(chatId, row.queueMessageId);
      // Stopped AFTER the move, so the turn ending releases this message and
      // not whatever was ahead of it. Recorded as this chat's stop (DOR-4668).
      const stopped = await stopChatTurn(this.deps, { chatId, sender: row, via: 'interrupt' });
      if (!stopped) note = 'Nothing was running there, so it simply runs next.';
    }
    note = pausedChatMessageNote({ status, chatId, cwd, agentPath: target.agent?.path }) ?? note;
    return {
      messageId: row.id,
      chatId,
      status,
      ...standing.waitingPlace(chatId, row, status, position),
      ...(status === 'failed' && current?.failureReason
        ? { failureReason: current.failureReason }
        : {}),
      ...(note ? { note } : {}),
    };
  }

  /**
   * Whether a chat takes a spin-off's reports as ordinary dispatcher
   * messages: any chat a chat message may reach, and a room's old chat no
   * room answers for now (`takesReportsAsChat`, DOR-3753). Private seat
   * asides are a separate route and do not make this predicate true. A
   * spin-off is never promised ordinary reports into a chat that cannot
   * take them.
   *
   * @param sessionId - The chat.
   */
  async canReceive(sessionId: string): Promise<boolean> {
    try {
      await assertChatSendable(this.deps, sessionId, true, 'report');
      return true;
    } catch {
      return false;
    }
  }

  /** The lock key for sends that may open an agent's DM chat, or null for a chat id. */
  private agentLockKey(caller: ChatCaller, to: string): string | null {
    const mesh = this.deps.meshCore();
    return mesh?.get(to) && mesh.getProjectPath(to) ? `${caller.agentPath}\u0000${to}` : null;
  }

  private withDmLock<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
    if (key === null) return fn();
    const previous = this.dmLocks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.dmLocks.set(key, tail);
    void tail.then(() => {
      if (this.dmLocks.get(key) === tail) this.dmLocks.delete(key);
    });
    return run;
  }

  /** The calling agent's Mesh id and name. */
  private agentFacts(agentPath: string): AgentFacts {
    const agent = this.deps
      .meshCore()
      ?.listWithPaths()
      .find((a) => a.projectPath === agentPath);
    if (!agent) return { agentId: null, agentName: 'An agent' };
    return { agentId: agent.id, agentName: agent.displayName ?? agent.name };
  }

  /**
   * Record the first message of a spin-off chat `session_start` is about to
   * start, and render it with the sender stamp (spec `spin-off-chats` §1). The
   * start keeps its own power rules (`inherited-start-permission`); this only
   * says who sent the words.
   *
   * @param caller - The starting chat.
   * @param toSessionId - The id the new chat is being started under.
   * @param prompt - The first message.
   * @param queueMessageId - The dispatcher message id the launch will use.
   * @returns The chat message id and the text the new chat's agent reads.
   */
  async beginStart(
    caller: ChatCaller,
    toSessionId: string,
    prompt: string,
    queueMessageId: string
  ): Promise<{ id: string; content: string }> {
    const sender = this.agentFacts(caller.agentPath);
    const fromChatTitle = await this.deps.chatTitle(caller.sessionId).catch(() => null);
    const startId = crypto.randomUUID();
    const rendered = renderChatMessage(
      {
        messageId: startId,
        agentName: sender.agentName,
        agentId: sender.agentId,
        chatId: caller.sessionId,
        chatTitle: fromChatTitle,
      },
      'start',
      prompt.trim(),
      this.deps.nonce?.()
    );
    const row = this.deps.store.insert({
      id: startId,
      toSessionId,
      fromSessionId: caller.sessionId,
      fromAgentPath: caller.agentPath,
      fromAgentId: sender.agentId,
      fromAgentName: sender.agentName,
      fromChatTitle,
      kind: 'start',
      text: prompt.trim(),
      summary: null,
      nonce: rendered.nonce,
      delivery: 'queue',
      status: 'queued',
      queueMessageId,
      ceilingJson: senderCeilingJson(this.deps, caller),
      replyToId: null,
    });
    return { id: row.id, content: rendered.text };
  }

  /**
   * Settle a start {@link beginStart} recorded: under the chat's final id when
   * it started, removed when it never did.
   *
   * @param id - The chat message id.
   * @param canonicalId - The started chat's id, or null when the start was refused.
   */
  settleStart(id: string, canonicalId: string | null): void {
    if (canonicalId === null) {
      this.deps.store.delete(id);
      return;
    }
    const row = this.deps.store.get(id);
    if (!row) return;
    this.deps.store.update(id, {
      toSessionId: canonicalId,
      ...(row.status === 'queued' ? { status: 'working' as const } : {}),
    });
    this.deps.emitActivity(row.fromSessionId);
  }

  /**
   * Stop a chat's running turn, the way the Stop button does, for another
   * chat's agent. Messages other chats queued there are dropped with it; the
   * person's own queued words stay and run next.
   *
   * @param caller - The calling chat.
   * @param input - The chat and an optional reason.
   * @returns Whether a turn was running and was asked to stop.
   * @throws ChatMessageError when the chat may not be stopped.
   */
  async stopChat(
    caller: ChatCaller,
    input: { chat: string; reason?: string }
  ): Promise<{ stopped: boolean; chatId: string; droppedMessages: number; note: string }> {
    if (
      input.chat === caller.sessionId ||
      (await sameChat(this.deps, input.chat, caller.sessionId))
    ) {
      throw new ChatMessageError('SELF', 'That is your own chat. End your turn instead.');
    }
    await assertChatStoppable(this.deps, input.chat);
    const reason = input.reason?.trim() ? input.reason.trim().slice(0, CHAT_STOP_REASON_MAX) : null;
    const sender = this.agentFacts(caller.agentPath);
    const fromChatTitle = await this.deps.chatTitle(caller.sessionId).catch(() => null);
    const byLine = chatStopByLine(sender.agentName, fromChatTitle);

    // Other chats' queued messages go first, synchronously, so the turn ending
    // below cannot release one of them.
    let dropped = 0;
    const withdrawn = withdrawWaitingChatMessages(
      this.deps.turns,
      this.deps.store,
      input.chat,
      `${byLine} before it ran.`
    );
    for (const row of withdrawn) this.deps.emitActivity(row.fromSessionId);
    const queue = getMessageQueueStore();
    for (const queued of queue?.list(queueKeyOf(input.chat)) ?? []) {
      if (!isChatClientId(queued.enqueuedBy)) continue;
      for (const chatRow of this.deps.store.listByQueueMessage(queued.id)) {
        this.deps.store.update(chatRow.id, {
          status: 'failed',
          failureReason: `${byLine} before it ran.`,
        });
        this.deps.emitActivity(chatRow.fromSessionId);
      }
      if (cancelQueuedMessage(input.chat, queued.id)) dropped += 1;
    }

    // The id it is known by now, where its windows and its "Stopped by" line read.
    const chatId = await this.deps.canonicalId(input.chat).catch(() => input.chat);
    const stopped = await stopChatTurn(this.deps, {
      chatId,
      sender: {
        fromSessionId: caller.sessionId,
        fromAgentPath: caller.agentPath,
        fromAgentId: sender.agentId,
        fromAgentName: sender.agentName,
        fromChatTitle,
      },
      via: 'stop',
      reason,
    });
    this.deps.emitActivity(caller.sessionId);
    this.deps.emitActivity(chatId);
    return {
      stopped,
      chatId,
      droppedMessages: dropped,
      note: stopped
        ? `Stopped. The chat shows "${byLine}${reason ? `: ${reason}` : ''}".`
        : 'Nothing was running there.',
    };
  }

  /**
   * What a chat sent and what was done to it, for its windows: the Sent cards
   * and the "Stopped by" lines.
   *
   * @param sessionId - The chat.
   */
  async activityOf(
    sessionId: string
  ): Promise<{ sent: SentChatMessage[]; stops: ChatStopNotice[] }> {
    const sentRows = this.deps.store.listSentFrom(sessionId);
    const titles = new Map<string, string | null>();
    const agentNames = new Map<string, { name?: string; id?: string }>();
    const titleOf = async (id: string) => {
      if (!titles.has(id)) titles.set(id, await this.deps.chatTitle(id).catch(() => null));
      return titles.get(id) ?? null;
    };
    const agentOf = async (id: string) => {
      if (!agentNames.has(id)) {
        const facts = await this.deps.describeSession(id).catch(() => null);
        const agent = facts?.agentPath
          ? this.deps
              .meshCore()
              ?.listWithPaths()
              .find((a) => a.projectPath === facts.agentPath)
          : undefined;
        agentNames.set(id, agent ? { name: agent.displayName ?? agent.name, id: agent.id } : {});
      }
      return agentNames.get(id)!;
    };
    const sent: SentChatMessage[] = [];
    for (const row of sentRows) {
      const to = await agentOf(row.toSessionId);
      const chatTitle = await titleOf(row.toSessionId);
      const { position } = standing.waitingPlace(row.toSessionId, row, row.status, undefined);
      const reply = this.deps.store
        .listSentFrom(row.toSessionId)
        .find((other) => other.replyToId === row.id);
      sent.push({
        id: row.id,
        kind: row.kind,
        to: {
          chatId: row.toSessionId,
          ...(chatTitle ? { chatTitle } : {}),
          ...(to.name ? { agentName: to.name } : {}),
          ...(to.id ? { agentId: to.id } : {}),
        },
        text: row.text,
        ...(row.summary ? { summary: row.summary } : {}),
        delivery: row.delivery,
        status: row.status,
        ...(position !== undefined ? { position } : {}),
        ...(row.failureReason ? { failureReason: row.failureReason } : {}),
        ...(reply ? { replyId: reply.id } : {}),
        sentAt: row.createdAt,
      });
    }
    const stops = this.deps.store
      .listStopsOf(sessionId)
      .filter((row) => row.status === 'delivered')
      .map((row) => {
        const stamp = stampOf(row);
        return {
          id: row.id,
          by: stamp.from,
          ...(row.text ? { reason: row.text } : {}),
          at: row.createdAt,
        };
      });
    return { sent, stops };
  }

  /** Follow a sent message through the receiving chat's queue and turn. */
  private onDispatch(event: DispatchLifecycleEvent): void {
    const rows = this.deps.store.listByQueueMessage(event.messageId);
    if (rows.length === 0) {
      // A turn no chat message rides on — a person's, a schedule's — is
      // somebody asking: its finish may notify, whatever the turn before was.
      if (event.phase === 'started') noteOtherTurnStarted(event.sessionId);
      return;
    }
    if (event.phase === 'started') noteChatTurnStarted(event.sessionId, this.now(), rows);
    // A held turn ended too, without settling (DOR-4353).
    else if (event.phase !== 'dropped') noteChatTurnSettled(event.sessionId);
    for (const row of rows) {
      let status: ChatMessageStatus | null = null;
      let failureReason: string | undefined;
      if (event.phase === 'started' && row.status === 'queued') status = 'working';
      // A pause stopped its turn before the agent read it: it waits in the
      // queue again, held until the pause lifts, so it reads as queued (DOR-4353).
      else if (event.phase === 'held' && row.status === 'working') status = 'queued';
      else if (event.phase === 'settled' && (row.status === 'working' || row.status === 'queued')) {
        status = standing.settledStatus(event.outcome, event.reason);
        if (status === 'failed') failureReason = standing.settledFailureReason(event.reason);
      } else if (event.phase === 'dropped' && row.status === 'queued') {
        status = 'failed';
        failureReason =
          event.reason === 'session_gone'
            ? 'The chat it was waiting in no longer exists.'
            : 'Someone took it off the chat’s queue, or pressed Stop.';
      }
      if (status === null) continue;
      this.deps.store.update(row.id, { status, ...(failureReason ? { failureReason } : {}) });
      this.deps.emitActivity(row.fromSessionId);
      this.deps.emitActivity(row.toSessionId);
    }
  }
}
