/**
 * An extension sending one of the person's agents a message (`ctx.agent.send`,
 * DOR-2683): the door behind it, the rules it keeps, and the delivery events
 * that acknowledge it.
 *
 * ## The path a message takes
 *
 * 1. **Who it is for.** `to` is tried as a Mesh agent id first. An agent's
 *    message goes to the one chat this extension keeps with that agent
 *    (`extension_agent_chats`): the first message opens it in the agent's home,
 *    through the start-work seam's `reserve` (so it says "Started by <app>" and
 *    counts against the extension's start limits), and every later message
 *    lands in the same chat. Otherwise `to` is a chat id, used as it is when
 *    DorkOS has bound it and it is a chat an extension may write into
 *    ({@link MESSAGEABLE_ORIGINS}).
 * 2. **What the agent reads.** {@link renderAppMessage}: the extension's words
 *    inside the nonce fence room members' words get (`untrusted-fence.ts`, which
 *    runs `defuseSystemTags` over them), labelled inside as coming from the
 *    named app and being data, not instructions. The fenced block is the
 *    message itself, so it survives the queue and a restart byte for byte.
 * 3. **How it is sent.** `dispatchSessionMessage` with the dispatcher's default
 *    `whenBusy: 'queue'`: a busy chat HOLDS the message in
 *    `session_message_queue`, under the receipt's own id, and runs it when the
 *    current turn ends. **That hold has no time limit** — the dispatcher's wait
 *    budget only forces a launch attempt, which a running turn's live lock
 *    refuses, and the message goes back in line (`queueWaitMs` in
 *    `message-dispatcher.ts`). So there is no `hold_expired`: a waiting message
 *    leaves the queue by running, or by a person removing it, and either way
 *    the extension hears.
 * 4. **What the extension can NOT say.** The input is strict: a `cwd`,
 *    `permissionMode`, `forAgent`, `runtime` or any other field is refused, so
 *    an extension cannot pick where the turn stands, who it acts as, or how
 *    much it may do. The origin is `extension-message`, which seeds no
 *    permission mode on a chat it opens, and the lock identity
 *    `extension:<id>` is a name that confers nothing.
 *
 * ## Capacity
 *
 * A message into an idle chat counts toward the launch cap every turn nobody
 * typed into counts toward (`AGENT_LAUNCH_MAX_LIVE`); one into a busy chat
 * does not, since it adds no turn beside the running one. When there is no
 * room — the cap is full, or opening the agent's chat would break the
 * extension's start limits — the message is not refused: it is HELD here
 * (`status: 'held'`, words kept) and the receipt says `queued` with reason
 * `at_capacity`. Held messages are retried every {@link HELD_RETRY_MS}, oldest
 * first, and survive a restart.
 *
 * ## The receipt and the ack
 *
 * `send` answers at once with `{ messageId, status, reason?, sessionId }`. What
 * follows reaches the extension through `ctx.agent.subscribe`, read off the
 * dispatcher's {@link onDispatchLifecycle} by message id: `turn.started` (the
 * ack), then `turn.done`, or `turn.failed` with a reason when the message will
 * never run. These are server-side and not tied to which chat a person has
 * open, unlike the page's `api.events` stream.
 *
 * ## Idempotency
 *
 * A second send with the same `(extension, idempotencyKey)` answers with the
 * first receipt and sends nothing, for 24 hours and for as long as the message
 * is unfinished. A send racing its own retry in the same process waits for the
 * first one's answer. A refused send leaves nothing behind, so a resend tries
 * again.
 *
 * @module services/extensions/agent-send/agent-send
 */
import crypto from 'node:crypto';
import type { MeshCore } from '@dorkos/mesh';
import {
  AgentSendError,
  type AgentDeliveryEvent,
  type AgentDeliveryFailureReason,
  type AgentSendReceipt,
} from '@dorkos/extension-api/server';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { logError, logger } from '../../../lib/logger.js';
import {
  dispatchSessionMessage,
  isSessionLaunchRefusal,
  type DispatchSessionMessageOpts,
  type DispatchSessionMessageResult,
} from '../../session/launch/launch-session.js';
import {
  onDispatchLifecycle,
  type DispatchLifecycleEvent,
} from '../../session/message-dispatcher.js';
import { getMessageQueueStore } from '../../session/message-queue-store.js';
import { peekProjector } from '../../session/session-state-projector.js';
import { mintFenceNonce } from '../../runtimes/shared/untrusted-fence.js';
import {
  AgentSendInputSchema,
  FAILURE_MESSAGE,
  MESSAGEABLE_ORIGINS,
  describeInputProblem,
  receiptOf,
  renderAppMessage,
  type AgentSendRequest,
} from './agent-send-message.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import type { AgentSendRecord, AgentSendStore } from './agent-send-store.js';
import type { StartReservation } from '../start-work.js';
import {
  describeSessionFor,
  isSessionBusy,
  liveSessionCwd,
  reserveKeptChat,
  resumeChatQueue,
  type SessionFacts,
} from './agent-send-defaults.js';

export type { SessionFacts } from './agent-send-defaults.js';

/** How often held messages are tried again. */
export const HELD_RETRY_MS = 5_000;

/** How many delivery events are kept for an extension nobody is listening for. */
export const UNHEARD_EVENTS_MAX = 200;

/** What the agent-send seam needs. Everything after `store` has a production default. */
export interface AgentSendDeps {
  /** Where messages and kept chats live. */
  store: AgentSendStore;
  /** An extension's manifest name, or its id when it is not installed. */
  extensionName: (extensionId: string) => string;
  /** Mesh, when it is running: resolves an agent id to its home. */
  meshCore: () => Pick<MeshCore, 'get' | 'getProjectPath'> | undefined;
  /**
   * The room binding port, read at call time: which chats a room answers for,
   * and the launch's own room guard (`ROOM_SESSION_MOVED`).
   */
  roomSessionPlace?: () => RoomSessionPlacePort | undefined;
  /** What DorkOS knows about a chat. */
  describeSession?: (sessionId: string) => Promise<SessionFacts>;
  /** The folder a chat runs in, when a live projector or its runtime knows. */
  sessionCwd?: (sessionId: string) => Promise<string | undefined>;
  /** Whether a chat has a turn running right now. */
  isBusy?: (sessionId: string) => Promise<boolean>;
  /** The send itself. */
  dispatch?: (opts: DispatchSessionMessageOpts) => Promise<DispatchSessionMessageResult>;
  /** Claims a start slot for a new kept chat (the start-work seam's `reserve`). */
  reserveChat?: (
    extensionId: string,
    sessionId: string
  ) => { ok: true; reservation: StartReservation } | { ok: false; message: string } | null;
  /** Whether the dispatcher still holds a queue row for a message. */
  isQueued?: (messageId: string) => boolean;
  /** Re-arm a chat's queued rows after a restart. */
  resumeQueue?: (sessionId: string, cwd: string | undefined) => Promise<void>;
  /** Subscribe to the dispatcher's lifecycle events. */
  onLifecycle?: (listener: (event: DispatchLifecycleEvent) => void) => () => void;
  /** A fence nonce (tests pin it). */
  nonce?: () => string;
  /** How often held messages are retried. */
  retryMs?: number;
}

/** Where a message is going, once resolved. */
interface ResolvedTarget {
  /** The chat, or null when an agent's chat is not open yet. */
  sessionId: string | null;
  /** Set when the target is an agent: its id and home. */
  agent?: { id: string; path: string };
}

/** How one attempt to hand a message to the dispatcher came out. */
type Attempt =
  | { kind: 'sent'; sessionId: string; queued: boolean }
  | { kind: 'held' }
  | { kind: 'refused'; code: 'not_found' | 'not_allowed' | 'unavailable'; message: string };

/** The agent-send seam. See the module documentation. */
export class AgentSendService {
  /** Sends in flight, by extension and key: a racing retry waits for the first. */
  private readonly inflight = new Map<string, Promise<AgentSendReceipt>>();
  /** Delivery listeners, by extension. */
  private readonly listeners = new Map<string, Set<(event: AgentDeliveryEvent) => void>>();
  /** Events nobody was listening for, by extension, delivered to the first listener. */
  private readonly unheard = new Map<string, AgentDeliveryEvent[]>();
  private readonly nonce: () => string;
  private readonly describeSession: (sessionId: string) => Promise<SessionFacts>;
  private readonly sessionCwd: (sessionId: string) => Promise<string | undefined>;
  private readonly isBusy: (sessionId: string) => Promise<boolean>;
  private readonly dispatchSessionMessage: NonNullable<AgentSendDeps['dispatch']>;
  private readonly reserveChat: NonNullable<AgentSendDeps['reserveChat']>;
  private readonly isQueued: (messageId: string) => boolean;
  private readonly resumeQueue: NonNullable<AgentSendDeps['resumeQueue']>;
  private readonly onLifecycle: NonNullable<AgentSendDeps['onLifecycle']>;
  /** Chat-opening sends, chained per (extension, agent), so two firsts open one chat. */
  private readonly agentLocks = new Map<string, Promise<unknown>>();
  /** Events for messages mid-dispatch, held until the chat's final id is known. */
  private readonly attempting = new Map<string, AgentDeliveryEvent[]>();
  /**
   * Extensions stopped since they last started. Their messages are never
   * held again: a send or retry that comes back "no room" after the stop is
   * failed with `stopped` instead, so nothing goes out once they are gone.
   */
  private readonly stoppedExtensions = new Set<string>();
  /** Messages this process wrote: never "left behind by a restart". */
  private readonly createdHere = new Set<string>();
  private unsubscribeLifecycle: (() => void) | null = null;
  private started = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private draining: Promise<void> | null = null;

  /**
   * Build the seam, already listening to the dispatcher: an extension may send
   * the moment it starts, which is before {@link AgentSendService.start}, and
   * those messages' turns must be heard. Call `start` once runtimes are
   * registered.
   *
   * @param deps - What it needs.
   */
  constructor(private readonly deps: AgentSendDeps) {
    this.nonce = deps.nonce ?? mintFenceNonce;
    this.describeSession = deps.describeSession ?? describeSessionFor(deps.roomSessionPlace);
    this.sessionCwd = deps.sessionCwd ?? liveSessionCwd;
    this.isBusy = deps.isBusy ?? isSessionBusy;
    this.dispatchSessionMessage = deps.dispatch ?? dispatchSessionMessage;
    this.reserveChat = deps.reserveChat ?? reserveKeptChat;
    this.isQueued = deps.isQueued ?? ((id) => getMessageQueueStore()?.get(id) !== undefined);
    this.resumeQueue = deps.resumeQueue ?? resumeChatQueue;
    this.onLifecycle = deps.onLifecycle ?? onDispatchLifecycle;
    this.unsubscribeLifecycle = this.onLifecycle((event) => this.onDispatch(event));
  }

  /**
   * Settle what a previous process left unfinished, and start retrying held
   * messages.
   *
   * Left behind by a restart: a `started` message's turn died with the old
   * process, and a `queued` one whose queue row is gone can no longer be told
   * apart from one that ran, so both are reported `interrupted`. A `queued`
   * message whose row survived is re-armed now, rather than waiting for the
   * next message to that chat to adopt it. Only rows a PREVIOUS process wrote
   * are judged: a message this process sent before `start` ran is live.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const resumed = new Set<string>();
    for (const row of this.deps.store.listByStatus(['queued', 'started'])) {
      if (this.createdHere.has(row.id)) continue;
      if (row.status === 'started' || !this.isQueued(row.id)) {
        this.fail(row, 'interrupted');
        continue;
      }
      if (!row.sessionId || resumed.has(row.sessionId)) continue;
      resumed.add(row.sessionId);
      await this.resumeQueue(row.sessionId, row.cwd ?? undefined).catch((err: unknown) =>
        logger.warn('[agent-send] could not re-arm a chat’s queued messages', {
          sessionId: row.sessionId,
          ...logError(err),
        })
      );
    }
    const retryMs = this.deps.retryMs ?? HELD_RETRY_MS;
    this.retryTimer = setInterval(() => void this.drainHeld(), retryMs);
    this.retryTimer.unref?.();
  }

  /**
   * Stop listening and stop retrying, for a server shutting down. Held
   * messages stay held for the next process.
   */
  stop(): void {
    this.stopped = true;
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = null;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Send an agent a message for an extension.
   *
   * @param extensionId - The extension sending it.
   * @param input - `to`, `text`, optional `context`, and `idempotencyKey`.
   * @returns The receipt.
   * @throws AgentSendError when the input breaks a rule or the target refuses.
   */
  async send(extensionId: string, input: unknown): Promise<AgentSendReceipt> {
    const parsed = AgentSendInputSchema.safeParse(input);
    if (!parsed.success) throw new AgentSendError('invalid_input', describeInputProblem(input));
    const request = parsed.data;
    const key = `${extensionId}\u0000${request.idempotencyKey}`;
    // Read and claimed with no await between, so a retry racing the first send
    // in this process gets its answer rather than a second dispatch.
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;
    const stored = this.deps.store.findByKey(extensionId, request.idempotencyKey);
    if (stored) return receiptOf(stored);
    const pending = this.sendOnce(extensionId, request).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, pending);
    return pending;
  }

  /**
   * Hear what happens to an extension's messages. Events kept while nobody
   * listened are delivered to this listener first.
   *
   * @param extensionId - The extension.
   * @param listener - Receives each delivery event.
   * @returns A function that stops listening.
   */
  subscribe(extensionId: string, listener: (event: AgentDeliveryEvent) => void): () => void {
    let set = this.listeners.get(extensionId);
    if (!set) this.listeners.set(extensionId, (set = new Set()));
    set.add(listener);
    const backlog = this.unheard.get(extensionId);
    if (backlog) {
      this.unheard.delete(extensionId);
      for (const event of backlog) this.call(extensionId, listener, event);
    }
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(extensionId) === set)
        this.listeners.delete(extensionId);
    };
  }

  /**
   * An extension stopped, reloaded, was turned off or removed: its held
   * messages (waiting for room, never handed to a chat) are failed with
   * `stopped`, so nothing it sent goes out after it is gone. Messages already
   * in a chat's queue are the person's to see and remove, and stay. A server
   * shutting down is not an extension stopping: after {@link stop}, this does
   * nothing, so held messages survive a restart.
   *
   * @param extensionId - The extension that stopped.
   */
  extensionStopped(extensionId: string): void {
    if (this.stopped) return;
    this.stoppedExtensions.add(extensionId);
    for (const row of this.deps.store.listByStatus(['held'])) {
      if (row.extensionId === extensionId) this.fail(row, 'stopped');
    }
  }

  /**
   * An extension started (again): its messages may be held for room once more.
   *
   * @param extensionId - The extension that started.
   */
  extensionStarted(extensionId: string): void {
    this.stoppedExtensions.delete(extensionId);
  }

  /**
   * Hold a message for room, or fail it with `stopped` when its extension
   * stopped while the attempt was in flight (a stop only fails rows that are
   * `held` at that instant).
   */
  private holdOrFail(row: AgentSendRecord): void {
    if (this.stoppedExtensions.has(row.extensionId)) {
      this.fail(row, 'stopped');
      return;
    }
    this.deps.store.update(row.id, { status: 'held' });
  }

  /**
   * Run `fn` after every earlier chat-opening send to the same agent from the
   * same extension, so two first messages racing each other open ONE chat (and
   * spend one start slot): the second finds the chat the first kept.
   */
  private withAgentLock<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
    if (key === null) return fn();
    const previous = this.agentLocks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.agentLocks.set(key, tail);
    void tail.then(() => {
      if (this.agentLocks.get(key) === tail) this.agentLocks.delete(key);
    });
    return run;
  }

  /** The lock key for messages to an agent, or null for a chat id. */
  private agentLockKey(extensionId: string, to: string): string | null {
    const mesh = this.deps.meshCore();
    return mesh?.get(to) && mesh.getProjectPath(to) ? `${extensionId}\u0000${to}` : null;
  }

  /** Validate the target, record the message, and make the first attempt. */
  private sendOnce(extensionId: string, request: AgentSendRequest): Promise<AgentSendReceipt> {
    return this.withAgentLock(this.agentLockKey(extensionId, request.to), () =>
      this.sendLocked(extensionId, request)
    );
  }

  private async sendLocked(
    extensionId: string,
    request: AgentSendRequest
  ): Promise<AgentSendReceipt> {
    this.deps.store.prune();
    const target = await this.resolveTarget(extensionId, request.to);
    const name = this.deps.extensionName(extensionId);
    const row = this.deps.store.insert({
      id: crypto.randomUUID(),
      extensionId,
      idempotencyKey: request.idempotencyKey,
      agentId: target.agent?.id ?? null,
      sessionId: target.sessionId,
      cwd: target.sessionId ? ((await this.sessionCwd(target.sessionId)) ?? null) : null,
      // Written BEFORE the dispatch, so a turn that starts inside it finds the
      // row to mark. Settled below once the dispatch answers.
      status: 'queued',
      receiptStatus: 'queued',
      receiptReason: null,
      failureReason: null,
      content: renderAppMessage(name, extensionId, request.text, request.context, this.nonce()),
    });
    this.createdHere.add(row.id);
    let attempt: Attempt;
    try {
      attempt = await this.attempt(row, target);
    } catch (err) {
      this.deps.store.delete(row.id);
      logger.warn('[agent-send] could not send an extension’s message', {
        extensionId,
        to: request.to,
        ...logError(err),
      });
      throw new AgentSendError(
        'unavailable',
        'DorkOS could not send the message just now. Try again.'
      );
    }
    if (attempt.kind === 'refused') {
      this.deps.store.delete(row.id);
      throw new AgentSendError(attempt.code, attempt.message);
    }
    if (attempt.kind === 'held') {
      this.deps.store.update(row.id, { receiptStatus: 'queued', receiptReason: 'at_capacity' });
      this.holdOrFail(row);
    } else {
      // A turn that already started (or even ended) inside the dispatch keeps
      // the status the lifecycle gave it; only the receipt is settled here.
      this.deps.store.update(row.id, {
        receiptStatus: attempt.queued ? 'queued' : 'started',
        receiptReason: attempt.queued ? 'busy' : null,
      });
    }
    return receiptOf(this.deps.store.get(row.id) ?? row);
  }

  /** Where a message is going, or the refusal that says why it cannot go. */
  private async resolveTarget(extensionId: string, to: string): Promise<ResolvedTarget> {
    const mesh = this.deps.meshCore();
    const agentPath = mesh?.get(to) ? mesh.getProjectPath(to) : undefined;
    if (agentPath) {
      const agent = { id: to, path: agentPath };
      const kept = this.deps.store.keptChat(extensionId, to);
      if (kept) {
        const facts = await this.describeSession(kept);
        // A kept chat still this agent's is used; one the agent moved away
        // from is replaced by a new chat on this send.
        if (facts.bound && facts.agentPath === agentPath) return { sessionId: kept, agent };
      }
      return { sessionId: null, agent };
    }
    const facts = await this.describeSession(to);
    if (!facts.bound) {
      // Without Mesh an agent id cannot be told from an unknown chat id, and
      // "not found" would be a lie about an agent that is merely not loaded yet.
      if (!mesh)
        throw new AgentSendError('unavailable', 'Agents aren’t loaded yet. Try again in a moment.');
      throw new AgentSendError('not_found', 'There is no agent or chat with that id here.');
    }
    if (
      facts.roomBound ||
      facts.launchOrigin === null ||
      !MESSAGEABLE_ORIGINS.has(facts.launchOrigin)
    ) {
      throw new AgentSendError(
        'not_allowed',
        'Extensions can only write into your own chats. Not a room’s, a bridged chat, a scheduled run, or an older chat DorkOS can’t place.'
      );
    }
    // Whose chat it is: a chat an extension keeps with an agent, or one in a
    // chain an extension started, belongs to that extension. Another
    // extension's is refused; the extension kinds must prove they are ours.
    const owner = this.deps.store.keptChatOwner(to) ?? facts.startedByExtension;
    const extensionKind =
      facts.launchOrigin === 'extension-start' || facts.launchOrigin === 'extension-message';
    if ((owner !== null && owner !== extensionId) || (extensionKind && owner !== extensionId)) {
      throw new AgentSendError('not_allowed', 'That chat belongs to another extension.');
    }
    return { sessionId: to };
  }

  /**
   * Hand one message to the dispatcher: now, or as a retry of a held one.
   * Opens the agent's kept chat first when it has none.
   */
  private async attempt(row: AgentSendRecord, target: ResolvedTarget): Promise<Attempt> {
    // Events for this message wait until the dispatch answers, so every one of
    // them, and the receipt, carries the one id the chat settles on.
    this.attempting.set(row.id, []);
    try {
      return await this.attemptBuffered(row, target);
    } finally {
      const held = this.attempting.get(row.id) ?? [];
      this.attempting.delete(row.id);
      const sessionId = this.deps.store.get(row.id)?.sessionId ?? null;
      for (const event of held) {
        this.deliver(row.extensionId, {
          ...event,
          ...(sessionId !== null ? { sessionId } : {}),
        } as AgentDeliveryEvent);
      }
    }
  }

  private async attemptBuffered(row: AgentSendRecord, target: ResolvedTarget): Promise<Attempt> {
    let sessionId = target.sessionId;
    let reservation: StartReservation | undefined;
    if (sessionId === null) {
      sessionId = crypto.randomUUID();
      const claimed = this.reserveChat(row.extensionId, sessionId);
      if (claimed && !claimed.ok) return { kind: 'held' };
      reservation = claimed?.reservation;
    }
    // On the row before the dispatch, so nothing that happens inside it can
    // report a chat id this message never had.
    this.deps.store.update(row.id, { sessionId });
    const busy = target.sessionId !== null && (await this.isBusy(sessionId).catch(() => false));
    const name = sanitizeIdentity(this.deps.extensionName(row.extensionId)) ?? row.extensionId;
    let result: DispatchSessionMessageResult;
    try {
      result = await this.dispatchSessionMessage({
        origin: { kind: 'extension-message' },
        sessionId,
        messageId: row.id,
        request: {
          content: row.content ?? '',
          ...(row.cwd ? { cwd: row.cwd } : {}),
          ...(target.agent ? { agentPath: target.agent.path } : {}),
          ...(reservation
            ? {
                seedContext: `This chat was opened by the ${name} app so it can send this agent messages.`,
              }
            : {}),
        },
        clientId: `extension:${row.extensionId}`,
        meshCore: this.deps.meshCore() as MeshCore | undefined,
        // The real port, so the launch's own room guard still fires for a chat
        // a room took over after the target was checked (ROOM_SESSION_MOVED).
        roomSessionPlace: this.deps.roomSessionPlace?.(),
        // A message into a busy chat adds no turn beside the running one.
        countsTowardLaunchCap: !busy,
        ...(reservation ? { onSettled: () => reservation.settle() } : {}),
      });
    } catch (err) {
      reservation?.cancel();
      this.deps.store.update(row.id, { sessionId: target.sessionId });
      throw err;
    }
    if (isSessionLaunchRefusal(result)) {
      reservation?.cancel();
      this.deps.store.update(row.id, { sessionId: target.sessionId });
      if (result.refused === 'LAUNCH_CAP_FULL') return { kind: 'held' };
      if (result.refused === 'ROOM_SESSION_MOVED' || result.refused === 'DESK_NOT_OWN') {
        return { kind: 'refused', code: 'not_allowed', message: result.message };
      }
      if (result.refused === 'INVALID_AGENT_PATH') {
        return { kind: 'refused', code: 'not_found', message: result.message };
      }
      return { kind: 'refused', code: 'unavailable', message: result.message };
    }
    if (!result.accepted) {
      reservation?.cancel();
      this.deps.store.update(row.id, { sessionId: target.sessionId });
      return {
        kind: 'refused',
        code: 'unavailable',
        message: 'The chat could not take the message. Try again.',
      };
    }
    const canonical = result.canonicalId ?? sessionId;
    if (reservation && canonical !== sessionId) reservation.rekey(canonical);
    if (target.agent) this.deps.store.keepChat(row.extensionId, target.agent.id, canonical);
    this.deps.store.update(row.id, {
      sessionId: canonical,
      cwd: peekProjector(sessionId)?.cwd ?? row.cwd,
      content: null,
    });
    return { kind: 'sent', sessionId: canonical, queued: result.queued };
  }

  /** Try every held message again, oldest first. One drain at a time. */
  async drainHeld(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      for (const row of this.deps.store.listByStatus(['held'])) {
        if (this.stoppedExtensions.has(row.extensionId)) continue;
        await this.retry(row).catch((err: unknown) =>
          logger.warn('[agent-send] a held message could not be retried', {
            messageId: row.id,
            ...logError(err),
          })
        );
      }
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /** One held message's retry, in its agent's chat-opening line. */
  private retry(row: AgentSendRecord): Promise<void> {
    return this.withAgentLock(row.agentId ? `${row.extensionId}\u0000${row.agentId}` : null, () =>
      this.retryLocked(row)
    );
  }

  /** One held message's retry: sent, still held, or failed for good. */
  private async retryLocked(row: AgentSendRecord): Promise<void> {
    // Failed meanwhile (its extension stopped): nothing to send.
    if (this.deps.store.get(row.id)?.status !== 'held') return;
    // An agent's message waits for Mesh rather than failing before it starts.
    if (row.agentId && !this.deps.meshCore()) return;
    let target: ResolvedTarget;
    try {
      target = row.agentId
        ? await this.resolveTarget(row.extensionId, row.agentId)
        : await this.resolveTarget(row.extensionId, row.sessionId ?? '');
    } catch {
      this.fail(row, 'undeliverable');
      return;
    }
    // `queued` BEFORE the dispatch, so a turn that starts inside it finds the
    // row ready to mark, exactly as a first send does.
    this.deps.store.update(row.id, { status: 'queued' });
    let attempt: Attempt;
    try {
      attempt = await this.attempt(row, target);
    } catch (err) {
      this.holdOrFail(row);
      throw err;
    }
    if (attempt.kind === 'refused') this.fail(row, 'undeliverable');
    else if (attempt.kind === 'held') this.holdOrFail(row);
  }

  /** Translate a dispatcher lifecycle event into this extension's delivery event. */
  private onDispatch(event: DispatchLifecycleEvent): void {
    const row = this.deps.store.get(event.messageId);
    if (!row) return;
    if (event.phase === 'started') {
      if (row.status !== 'queued') return;
      // The row's id, written before the dispatch; the turn's filing id only
      // for a row from before that rule.
      const sessionId = row.sessionId ?? event.sessionId;
      this.deps.store.update(row.id, { status: 'started' });
      this.deliver(row.extensionId, { kind: 'turn.started', messageId: row.id, sessionId });
      return;
    }
    if (event.phase === 'settled') {
      if (row.status === 'done' || row.status === 'failed') return;
      this.deps.store.update(row.id, { status: 'done' });
      this.deliver(row.extensionId, {
        kind: 'turn.done',
        messageId: row.id,
        sessionId: row.sessionId ?? event.sessionId,
        outcome: event.outcome === 'ok' ? 'ok' : 'error',
      });
      return;
    }
    if (row.status === 'queued' || row.status === 'held') this.fail(row, event.reason);
  }

  /** Mark a message failed for good, and tell its extension. */
  private fail(row: AgentSendRecord, reason: AgentDeliveryFailureReason): void {
    this.deps.store.update(row.id, { status: 'failed', failureReason: reason, content: null });
    this.deliver(row.extensionId, {
      kind: 'turn.failed',
      messageId: row.id,
      sessionId: row.sessionId,
      reason,
      message: FAILURE_MESSAGE[reason],
    });
  }

  /** Hand an event to the extension's listeners, or keep it for the first one. */
  private deliver(extensionId: string, event: AgentDeliveryEvent): void {
    const buffered = this.attempting.get(event.messageId);
    if (buffered) {
      buffered.push(event);
      return;
    }
    const set = this.listeners.get(extensionId);
    if (set && set.size > 0) {
      for (const listener of [...set]) this.call(extensionId, listener, event);
      return;
    }
    const backlog = this.unheard.get(extensionId) ?? [];
    backlog.push(event);
    // Bounded: an extension that never listens must not grow this forever.
    if (backlog.length > UNHEARD_EVENTS_MAX) backlog.splice(0, backlog.length - UNHEARD_EVENTS_MAX);
    this.unheard.set(extensionId, backlog);
  }

  /** Call one listener, so a throwing extension cannot break delivery or the dispatcher. */
  private call(
    extensionId: string,
    listener: (event: AgentDeliveryEvent) => void,
    event: AgentDeliveryEvent
  ): void {
    try {
      listener(event);
    } catch (err) {
      logger.warn(`[ext:${extensionId}] an agent delivery listener threw`, logError(err));
    }
  }
}

let current: AgentSendService | undefined;

/**
 * Wire the seam at boot (or clear it in a test).
 *
 * @param service - The seam, or undefined.
 */
export function setAgentSendService(service: AgentSendService | undefined): void {
  current = service;
}

/** The wired seam, or undefined before boot. */
export function getAgentSendService(): AgentSendService | undefined {
  return current;
}
