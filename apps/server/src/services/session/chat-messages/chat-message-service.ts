/**
 * Chats messaging chats (spec `spin-off-chats`, ADR 261009-171114): the one
 * place `chat_send`, `chat_read` and `chat_stop` are carried out, whatever
 * runtime the calling chat runs on.
 *
 * ## Sending
 *
 * 1. **Where it goes.** `to` is tried as a Mesh agent id first: the message
 *    goes to the DM chat the sending agent keeps with that agent
 *    (`chat_agent_dms`), opened in the receiving agent's home on the first
 *    message. Otherwise `to` is a chat id, which must be one this server bound
 *    and one a chat may write into ({@link CHAT_SENDABLE_ORIGINS}).
 * 2. **Who sent it.** The calling chat and its agent, read off the verified
 *    turn, never the input. A `chat_messages` row is written BEFORE the
 *    dispatch, with the fence nonce and the sender's level, so the turn it
 *    starts finds both.
 * 3. **How it arrives.** Queue by default (the dispatcher holds it while the
 *    receiver is busy; an idle receiver starts at once). Agent messages that
 *    wait together are appended into one queue row, so they run as one turn.
 *    `steer` joins the running turn only when the receiver's turn runs no
 *    looser than the sender, because a steer cannot be held to a ceiling the
 *    running turn already passed; otherwise it waits in the queue and the
 *    receipt says why. `interrupt` puts the message at the head of the queue
 *    and stops the running turn, so it runs next.
 * 4. **The power it carries.** The turn runs no looser than the sending
 *    chat's latest turn ({@link senderCeiling}), applied by the dispatcher when
 *    the queue row launches.
 *
 * ## No loop guard
 *
 * Chats may talk to each other for days, weeks or months with no person in
 * between (Dorian 2026-10-08). Nothing here counts turns or caps a
 * conversation; the launch cap counts machine load only.
 *
 * @module services/session/chat-messages/chat-message-service
 */
import crypto from 'node:crypto';
import type { MeshCore } from '@dorkos/mesh';
import type { ChatMessageRow } from '@dorkos/db';
import type {
  TurnPermissionBound,
  TurnPermissionCeiling,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import { isNoLooserThan } from '@dorkos/shared/permission-semantics';
import type {
  ChatDelivery,
  ChatMessageKind,
  ChatMessageStatus,
  ChatStopNotice,
  SentChatMessage,
} from '@dorkos/shared/chat-messages';
import { logError, logger } from '../../../lib/logger.js';
import { recordAudit } from '../../audit/audit-trail.js';
import {
  dispatchSessionMessage,
  isSessionLaunchRefusal,
  type DispatchSessionMessageOpts,
  type DispatchSessionMessageResult,
} from '../launch/launch-session.js';
import {
  emitQueueUpdate,
  isQueuedMessageLaunching,
  onDispatchLifecycle,
  type DispatchLifecycleEvent,
} from '../message-dispatcher.js';
import { getMessageQueueStore } from '../message-queue-store.js';
import { queueKeyOf } from '../resolution/session-key-registry.js';
import { cancelQueuedMessage } from '../queued-message-edits.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import type { SessionFacts } from '../../extensions/agent-send/agent-send-defaults.js';
import { chatClientId, isChatClientId } from './chat-client-id.js';
import { renderChatMessage } from './chat-message-fence.js';
import { stampOf } from './chat-message-stamps.js';
import type { ChatMessageStore } from './chat-message-store.js';

/**
 * The launch origins of chats another chat may write into or stop: a person's
 * own chat, one an agent or an extension started, one a chat message opened,
 * and a carry-over or resume of one.
 *
 * Deny by default, as `ctx.agent.send` is. Left out on purpose: a room's
 * conversation (agents speak in rooms with `post_to_room`), a chat bridged
 * from Telegram or Slack (its replies go to people off this machine), a relay
 * DM, a connector event's chat, a schedule's run, and the test harness. `null`
 * is not in it: a chat bound before the column existed could be any of those.
 */
export const CHAT_SENDABLE_ORIGINS: ReadonlySet<string> = new Set([
  'interactive',
  'agent-launch',
  'chat-message',
  'extension-start',
  'extension-message',
  'account-handoff',
  'account-resume',
]);

/** Agent messages enqueued this close to the waiting one they follow are batched into it. */
export const CHAT_BATCH_WINDOW_MS = 2 * 60_000;

/** The longest message. */
export const CHAT_MESSAGE_MAX = 20_000;

/** The longest Sent-card summary. */
export const CHAT_SUMMARY_MAX = 80;

/** The longest stop reason. */
export const CHAT_STOP_REASON_MAX = 200;

/** The calling chat, as the verified turn names it. */
export interface ChatCaller {
  /** The calling chat's id. */
  sessionId: string;
  /** The calling agent's home. */
  agentPath: string;
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

/** What `chat_send` answers. */
export interface ChatSendReceipt {
  /** The chat message's id. */
  messageId: string;
  /** The chat it went to. */
  chatId: string;
  /** Where it is now. */
  status: ChatMessageStatus;
  /** Its place in the receiving chat's queue while it waits (1 is next). */
  position?: number;
  /** A plain sentence when it did not arrive exactly as asked. */
  note?: string;
}

/** A refusal `chat_send`, `chat_read` or `chat_stop` answers with. */
export class ChatMessageError extends Error {
  /**
   * Build a refusal.
   *
   * @param code - A stable code.
   * @param message - A plain sentence for the calling agent.
   */
  constructor(
    readonly code:
      | 'NO_CHAT'
      | 'SELF'
      | 'NOT_FOUND'
      | 'NOT_ALLOWED'
      | 'NOT_READABLE'
      | 'INVALID_INPUT'
      | 'UNAVAILABLE',
    message: string
  ) {
    super(message);
    this.name = 'ChatMessageError';
  }
}

/** What the chat-message service needs. Everything after `meshCore` has a production default in boot. */
export interface ChatMessageServiceDeps {
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
  /** The send itself. */
  dispatch?: (opts: DispatchSessionMessageOpts) => Promise<DispatchSessionMessageResult>;
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
  /** The level a chat's latest turn ran at, or undefined when not known. */
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

/** The calling agent's name and Mesh id. */
interface AgentFacts {
  agentId: string | null;
  agentName: string;
}

/** Where a send is going, once resolved. */
interface Target {
  /** The chat, or null when an agent's DM chat is not open yet. */
  sessionId: string | null;
  /** Set when the target is an agent. */
  agent?: { id: string; path: string };
  /** The id a new DM chat is opened under, minted before the send. */
  newSessionId?: string;
}

/** The chat-message service. See the module documentation. */
export class ChatMessageService {
  private readonly dispatch: NonNullable<ChatMessageServiceDeps['dispatch']>;
  private readonly now: () => number;
  private readonly unsubscribe: () => void;
  /** Sends opening an agent's DM chat, chained per (sender, agent), so two firsts open one chat. */
  private readonly dmLocks = new Map<string, Promise<unknown>>();

  /**
   * Build the service, already listening to the dispatcher.
   *
   * @param deps - What it needs.
   */
  constructor(private readonly deps: ChatMessageServiceDeps) {
    this.dispatch = deps.dispatch ?? dispatchSessionMessage;
    this.now = deps.now ?? Date.now;
    this.unsubscribe = (deps.onLifecycle ?? onDispatchLifecycle)((event) => this.onDispatch(event));
  }

  /** Stop listening, for a server shutting down. */
  stop(): void {
    this.unsubscribe();
  }

  /**
   * The ceiling a queue row a chat sent launches under: every sender's bound
   * when the row carries several, `runtime-default` for a row with no record.
   *
   * @param queueMessageId - The dispatcher's message id.
   */
  ceilingForQueuedMessage(queueMessageId: string): TurnPermissionCeiling {
    const rows = this.deps.store.listByQueueMessage(queueMessageId);
    if (rows.length === 0) return 'runtime-default';
    const bounds = rows.map((row) => parseCeiling(row.ceilingJson));
    return bounds.length === 1 ? bounds[0]! : bounds;
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
    const words = input.message;
    if (words.trim() === '')
      throw new ChatMessageError('INVALID_INPUT', 'Say what the message is.');
    if (words.length > CHAT_MESSAGE_MAX) {
      throw new ChatMessageError(
        'INVALID_INPUT',
        `Keep a message under ${CHAT_MESSAGE_MAX.toLocaleString('en-US')} characters.`
      );
    }
    const delivery = input.delivery ?? 'queue';
    const agentLock = this.agentLockKey(caller, input.to);
    return this.withDmLock(agentLock, () => this.sendLocked(caller, input, delivery, kind));
  }

  private async sendLocked(
    caller: ChatCaller,
    input: ChatSendInput,
    delivery: ChatDelivery,
    kind: Extract<ChatMessageKind, 'message' | 'report'>
  ): Promise<ChatSendReceipt> {
    const target = await this.resolveTarget(caller, input.to);
    const sender = this.agentFacts(caller.agentPath);
    const fromChatTitle = await this.deps.chatTitle(caller.sessionId).catch(() => null);
    const replyToId = this.replyTarget(caller, target.sessionId, input.replyTo);
    const messageId = crypto.randomUUID();
    const rendered = renderChatMessage(
      {
        messageId,
        agentName: sender.agentName,
        agentId: sender.agentId,
        chatId: caller.sessionId,
        chatTitle: fromChatTitle,
      },
      kind,
      text(input),
      this.deps.nonce?.()
    );
    const ceiling = senderCeiling(this.deps.turnLevelOf(caller.sessionId));
    // A new DM chat's id is minted here, before the row, so a window already
    // watching it can match the message to its sender from the first event.
    if (target.sessionId === null) target.newSessionId = crypto.randomUUID();
    const row = this.deps.store.insert({
      id: messageId,
      toSessionId: target.sessionId ?? target.newSessionId ?? '',
      fromSessionId: caller.sessionId,
      fromAgentPath: caller.agentPath,
      fromAgentId: sender.agentId,
      fromAgentName: sender.agentName,
      fromChatTitle,
      kind,
      text: text(input),
      summary: input.summary?.trim() ? input.summary.trim().slice(0, CHAT_SUMMARY_MAX) : null,
      nonce: rendered.nonce,
      delivery,
      status: 'queued',
      queueMessageId: crypto.randomUUID(),
      ceilingJson: JSON.stringify(ceiling),
      replyToId,
    });

    let receipt: ChatSendReceipt;
    try {
      receipt = await this.deliver(caller, row, target, rendered.text, delivery);
    } catch (err) {
      this.deps.store.delete(row.id);
      if (err instanceof ChatMessageError) throw err;
      logger.warn('[chat_send] could not send a chat message', {
        from: caller.sessionId,
        to: input.to,
        ...logError(err),
      });
      throw new ChatMessageError(
        'UNAVAILABLE',
        'DorkOS could not send the message just now. Try again.'
      );
    }
    if (replyToId) this.markReplied(replyToId);
    this.deps.emitActivity(caller.sessionId);
    this.deps.emitActivity(receipt.chatId);
    return receipt;
  }

  /** Hand one message to the dispatcher, by the delivery asked for. */
  private async deliver(
    caller: ChatCaller,
    row: ChatMessageRow,
    target: Target,
    content: string,
    delivery: ChatDelivery
  ): Promise<ChatSendReceipt> {
    const busy =
      target.sessionId !== null && (await this.deps.isBusy(target.sessionId).catch(() => false));

    // Batching: agent messages that wait together run as one turn.
    if (delivery === 'queue' && target.sessionId !== null && busy) {
      const batched = this.batchInto(target.sessionId, row, content);
      if (batched) return batched;
    }

    let note: string | undefined;
    if (delivery === 'steer' && target.sessionId !== null && busy) {
      // Only into a turn that runs no looser than the sender: a running turn
      // cannot be lowered to the sender's ceiling.
      if (!this.maySteer(caller.sessionId, target.sessionId)) {
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

    const sessionId = target.sessionId ?? target.newSessionId ?? crypto.randomUUID();
    const cwd = target.sessionId ? await this.deps.sessionCwd(target.sessionId) : undefined;
    const result = await this.dispatch({
      origin: { kind: 'chat-message' },
      sessionId,
      messageId: row.queueMessageId ?? undefined,
      request: {
        content,
        ...(cwd ? { cwd } : {}),
        ...(target.agent ? { agentPath: target.agent.path } : {}),
      },
      clientId: chatClientId(caller.sessionId),
      meshCore: this.deps.meshCore() as MeshCore | undefined,
      roomSessionPlace: this.deps.roomSessionPlace?.(),
      // A message into a busy chat adds no turn beside the running one.
      countsTowardLaunchCap: !busy,
    });
    if (isSessionLaunchRefusal(result)) {
      throw new ChatMessageError(
        result.refused === 'LAUNCH_CAP_FULL' ? 'UNAVAILABLE' : 'NOT_ALLOWED',
        result.message
      );
    }
    if (!result.accepted) {
      throw new ChatMessageError('UNAVAILABLE', 'The chat could not take the message. Try again.');
    }
    const chatId = result.canonicalId ?? sessionId;
    if (target.agent && target.sessionId === null) {
      this.deps.store.keepDmChat(caller.agentPath, target.agent.id, chatId);
    }

    // A turn that started inside the dispatch already moved the row on.
    const current = this.deps.store.get(row.id);
    const status: ChatMessageStatus =
      current && current.status !== 'queued'
        ? current.status
        : result.queued
          ? 'queued'
          : 'working';
    this.deps.store.update(row.id, { toSessionId: chatId, status });

    let position = result.queued ? result.queuePosition : undefined;
    if (delivery === 'interrupt' && result.queued && row.queueMessageId) {
      position = this.moveToHead(chatId, row.queueMessageId);
      // Stopped AFTER the move, so the turn ending releases this message and
      // not whatever was ahead of it.
      const stopped = await this.deps.interruptTurn(chatId).catch(() => false);
      if (!stopped) note = 'Nothing was running there, so it simply runs next.';
    }
    return {
      messageId: row.id,
      chatId,
      status,
      ...(position !== undefined && status === 'queued' ? { position } : {}),
      ...(note ? { note } : {}),
    };
  }

  /**
   * Append a message to the agent-sent row waiting at the tail of a chat's
   * queue, when there is one young enough, so they run as one turn.
   */
  private batchInto(
    sessionId: string,
    row: ChatMessageRow,
    content: string
  ): ChatSendReceipt | null {
    const queue = getMessageQueueStore();
    if (!queue) return null;
    const rows = queue.list(queueKeyOf(sessionId));
    const tail = rows.at(-1);
    if (!tail || !isChatClientId(tail.enqueuedBy) || tail.disposition !== 'queue') return null;
    if (this.now() - tail.enqueuedAt > CHAT_BATCH_WINDOW_MS) return null;
    // Read and written in one tick: a row whose words are being read into a
    // turn right now would lose anything appended to it.
    if (isQueuedMessageLaunching(tail.id)) return null;
    if (!queue.updateContent(tail.id, `${tail.content}\n\n${content}`)) return null;
    this.deps.store.update(row.id, { toSessionId: sessionId, queueMessageId: tail.id });
    emitQueueUpdate(sessionId);
    return {
      messageId: row.id,
      chatId: sessionId,
      status: 'queued',
      position: rows.length,
      note: 'It joins the other agent messages waiting there, and they run as one turn.',
    };
  }

  /** Move a queue row to the head of its chat's queue; its new position. */
  private moveToHead(sessionId: string, queueMessageId: string): number {
    const queue = getMessageQueueStore();
    const head = queue?.list(queueKeyOf(sessionId))[0];
    if (queue && head && head.id !== queueMessageId) {
      queue.move(queueMessageId, { before: head.id });
      emitQueueUpdate(sessionId);
    }
    return 1;
  }

  /**
   * Whether a steer from one chat may join another's running turn: only when
   * that turn runs no looser than the sender, since a running turn cannot be
   * lowered to a ceiling. Unknown levels never steer.
   */
  private maySteer(fromSessionId: string, toSessionId: string): boolean {
    const sender = this.deps.turnLevelOf(fromSessionId);
    const receiver = this.deps.turnLevelOf(toSessionId);
    if (!sender || !receiver) return false;
    if (!isNoLooserThan(sender, receiver)) return false;
    return !receiver.auto || sender.auto === true || sender.asks === 'never';
  }

  /**
   * The chat message a send answers: the one named, when it was sent to the
   * calling chat by the target; else the newest unanswered one the target
   * sent the calling chat.
   */
  private replyTarget(
    caller: ChatCaller,
    targetSessionId: string | null,
    replyTo: string | undefined
  ): string | null {
    if (replyTo !== undefined) {
      const row = this.deps.store.get(replyTo);
      if (!row || row.toSessionId !== caller.sessionId) {
        throw new ChatMessageError(
          'NOT_FOUND',
          'replyTo must be the id of a message another chat sent this one.'
        );
      }
      return row.id;
    }
    if (targetSessionId === null) return null;
    return this.deps.store.latestUnanswered(targetSessionId, caller.sessionId)?.id ?? null;
  }

  /** Mark a chat message answered, and tell its sender's windows. */
  private markReplied(id: string): void {
    const row = this.deps.store.update(id, { status: 'replied' });
    if (row) this.deps.emitActivity(row.fromSessionId);
  }

  /** Where a send is going, or the refusal that says why it cannot go. */
  private async resolveTarget(caller: ChatCaller, to: string): Promise<Target> {
    const mesh = this.deps.meshCore();
    const agentPath = mesh?.get(to) ? mesh.getProjectPath(to) : undefined;
    if (agentPath) {
      const agent = { id: to, path: agentPath };
      const kept = this.deps.store.dmChat(caller.agentPath, to);
      if (kept && kept !== caller.sessionId) {
        const facts = await this.deps.describeSession(kept);
        if (facts.bound && facts.agentPath === agentPath && !facts.roomBound) {
          return { sessionId: kept, agent };
        }
      }
      return { sessionId: null, agent };
    }
    if (to === caller.sessionId || (await this.sameChat(to, caller.sessionId))) {
      throw new ChatMessageError(
        'SELF',
        'That is your own chat. Send to another chat or agent, or just keep working.'
      );
    }
    await this.assertSendable(to, mesh !== undefined);
    return { sessionId: to };
  }

  /** Refuse a chat id this chat may not write into or stop. */
  private async assertSendable(sessionId: string, meshUp: boolean): Promise<SessionFacts> {
    const facts = await this.deps.describeSession(sessionId);
    if (!facts.bound) {
      if (!meshUp) {
        throw new ChatMessageError(
          'UNAVAILABLE',
          'Agents aren’t loaded yet. Try again in a moment.'
        );
      }
      throw new ChatMessageError('NOT_FOUND', 'There is no agent or chat with that id here.');
    }
    if (
      facts.roomBound ||
      facts.launchOrigin === null ||
      !CHAT_SENDABLE_ORIGINS.has(facts.launchOrigin)
    ) {
      throw new ChatMessageError(
        'NOT_ALLOWED',
        'That chat belongs to a room, a Telegram or Slack chat, or a scheduled run. Post in the ' +
          'room with post_to_room instead, or pick another chat.'
      );
    }
    return facts;
  }

  /**
   * Whether a chat can be sent chat messages at all: one bound here that is
   * not a room's, a bridged chat, or a scheduled run. A spin-off of a chat
   * that cannot is never promised reports it could not deliver.
   *
   * @param sessionId - The chat.
   */
  async canReceive(sessionId: string): Promise<boolean> {
    try {
      await this.assertSendable(sessionId, true);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether two ids name the same chat (a request id and its canonical one). */
  private async sameChat(a: string, b: string): Promise<boolean> {
    const [ca, cb] = await Promise.all([
      this.deps.canonicalId(a).catch(() => a),
      this.deps.canonicalId(b).catch(() => b),
    ]);
    return ca === cb;
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
      ceilingJson: JSON.stringify(senderCeiling(this.deps.turnLevelOf(caller.sessionId))),
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
    if (input.chat === caller.sessionId || (await this.sameChat(input.chat, caller.sessionId))) {
      throw new ChatMessageError('SELF', 'That is your own chat. End your turn instead.');
    }
    await this.assertSendable(input.chat, this.deps.meshCore() !== undefined);
    const reason = input.reason?.trim() ? input.reason.trim().slice(0, CHAT_STOP_REASON_MAX) : null;
    const sender = this.agentFacts(caller.agentPath);
    const fromChatTitle = await this.deps.chatTitle(caller.sessionId).catch(() => null);
    const byLine = `Stopped by ${sender.agentName}${fromChatTitle ? ` · ${fromChatTitle}` : ''}`;

    // Other chats' queued messages go first, synchronously, so the turn ending
    // below cannot release one of them.
    let dropped = 0;
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

    const stopped = await this.deps.interruptTurn(input.chat).catch((err: unknown) => {
      logger.warn('[chat_stop] could not stop a chat', { chat: input.chat, ...logError(err) });
      return false;
    });

    this.deps.store.insert({
      id: crypto.randomUUID(),
      toSessionId: input.chat,
      fromSessionId: caller.sessionId,
      fromAgentPath: caller.agentPath,
      fromAgentId: sender.agentId,
      fromAgentName: sender.agentName,
      fromChatTitle,
      kind: 'stop',
      text: reason ?? '',
      summary: null,
      nonce: null,
      delivery: 'interrupt',
      status: stopped ? 'delivered' : 'failed',
      queueMessageId: null,
      ceilingJson: JSON.stringify('runtime-default'),
      replyToId: null,
    });
    recordAudit({
      action: 'chat.stopped',
      operation: 'execute',
      target: {
        type: 'session',
        id: input.chat,
        ...(await this.deps.chatTitle(input.chat).then(
          (name) => (name ? { name } : {}),
          () => ({})
        )),
      },
      outcome: stopped ? 'ok' : 'failed',
      ...(reason ? { reason } : {}),
      summary: stopped
        ? `${byLine}${reason ? `: ${reason}` : ''}`
        : `Tried to stop a chat that was not running`,
    });
    this.deps.emitActivity(caller.sessionId);
    this.deps.emitActivity(input.chat);
    return {
      stopped,
      chatId: input.chat,
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
    const queue = getMessageQueueStore();
    const sent: SentChatMessage[] = [];
    for (const row of sentRows) {
      const to = await agentOf(row.toSessionId);
      const chatTitle = await titleOf(row.toSessionId);
      let position: number | undefined;
      if (row.status === 'queued' && row.queueMessageId && queue) {
        const index = queue
          .list(queueKeyOf(row.toSessionId))
          .findIndex((q) => q.id === row.queueMessageId);
        if (index >= 0) position = index + 1;
      }
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
    if (rows.length === 0) return;
    for (const row of rows) {
      let status: ChatMessageStatus | null = null;
      let failureReason: string | undefined;
      if (event.phase === 'started' && row.status === 'queued') status = 'working';
      else if (event.phase === 'settled' && (row.status === 'working' || row.status === 'queued')) {
        status = event.outcome === 'ok' ? 'delivered' : 'failed';
        if (event.outcome !== 'ok') failureReason = 'The chat’s turn ended with an error.';
      } else if (event.phase === 'dropped' && row.status === 'queued') {
        status = 'failed';
        failureReason =
          event.reason === 'session_gone'
            ? 'The chat it was waiting in no longer exists.'
            : 'Someone took it off the chat’s queue, or pressed Stop.';
      }
      if (status === null) continue;
      this.deps.store.update(row.id, {
        status,
        ...(failureReason ? { failureReason } : {}),
      });
      this.deps.emitActivity(row.fromSessionId);
      this.deps.emitActivity(row.toSessionId);
    }
  }
}

/** The words a message carries, trimmed of the whitespace around them. */
function text(input: ChatSendInput): string {
  return input.message.trim();
}

/**
 * The ceiling a message from a chat carries: the level its latest turn ran
 * at, or the receiving runtime's default when that is not known (a restart, a
 * chat this process never ran a turn on). Never looser than the sender.
 *
 * @param level - The sending chat's latest turn level, when known.
 */
export function senderCeiling(level: TurnPermissionLevel | undefined): TurnPermissionBound {
  return level ?? 'runtime-default';
}

/** Read a stored ceiling; anything unreadable is the runtime's default. */
function parseCeiling(json: string): TurnPermissionBound {
  try {
    const value = JSON.parse(json) as unknown;
    if (value === 'runtime-default') return value;
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { asks?: unknown }).asks === 'string' &&
      typeof (value as { reach?: unknown }).reach === 'string'
    ) {
      return value as TurnPermissionLevel;
    }
  } catch {
    // fall through
  }
  return 'runtime-default';
}

let current: ChatMessageService | undefined;

/**
 * Wire the service at boot (or clear it in a test).
 *
 * @param service - The service, or undefined.
 */
export function setChatMessageService(service: ChatMessageService | undefined): void {
  current = service;
}

/** The wired service, or undefined before boot. */
export function getChatMessageService(): ChatMessageService | undefined {
  return current;
}
