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
 * 3. **How it is sent.** Through the turn port (`services/runs`, spec
 *    `turns-survive-restarts` §3): `start()` saves a run under the message's
 *    own id and answers at once, and the run is handed to the chat at once. A
 *    mini app's words belong in a composer (§3.5): the dispatcher queues them
 *    as a row under that same id, so a busy chat HOLDS the message where the
 *    person can see, reorder or remove it, and runs it when the current turn
 *    ends. Until the row is written the words stay in this message's own row
 *    (the run's `sourceRef`), so a restart in between loses nothing; once the
 *    queue has them, this row lets them go. **That hold has no time limit**,
 *    so there is no `hold_expired`: a waiting message leaves the queue by
 *    running, or by a person removing it, and either way the extension hears.
 * 4. **What the extension can NOT say.** The input is strict: a `cwd`,
 *    `permissionMode`, `forAgent`, `runtime` or any other field is refused, so
 *    an extension cannot pick where the turn stands, who it acts as, or how
 *    much it may do. The origin is `extension-message`, which seeds no
 *    permission mode on a chat it opens, and the lock identity
 *    `extension:<id>` is a name that confers nothing.
 *
 * ## Capacity
 *
 * A message counts toward the launch cap every turn nobody typed into counts
 * toward (`runtimes.maxAgentChats`). When the cap is full it is not refused:
 * its run waits until there is room, and the receipt says `at_capacity`. Opening the agent's chat when that
 * would break the extension's own start limits is the one wait kept here: the
 * message is HELD (`status: 'held'`, words kept), retried every
 * {@link HELD_RETRY_MS}, oldest first, and survives a restart.
 *
 * ## The receipt and the ack
 *
 * `send` answers at once with `{ messageId, status, reason?, sessionId }`:
 * `queued` from the moment its run is saved, with `busy` when another turn
 * holds the chat and `at_capacity` when admission held it for room; a message
 * simply not handed over yet has no reason. A resend answers with where the
 * message is now. What follows reaches the extension through
 * `ctx.agent.subscribe`, read off the run (`agent-send-runs.ts`):
 * `turn.started` (the ack), then `turn.done`, or `turn.failed` with a reason
 * when the message will never run. These are server-side and not tied to
 * which chat a person has open, unlike the page's `api.events` stream.
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
import { outsideAuditScope } from '../../audit/audit-context.js';
import crypto from 'node:crypto';
import { ulid } from 'ulidx';
import type { MeshCore } from '@dorkos/mesh';
import {
  AgentSendError,
  type AgentDeliveryEvent,
  type AgentDeliveryFailureReason,
  type AgentSendReceipt,
  type AgentSendWaitReason,
} from '@dorkos/extension-api/server';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { logError, logger } from '../../../lib/logger.js';
import { RunIdSchema } from '@dorkos/shared/turn-port';
import {
  RUN_ENDS,
  TurnStartRefusedError,
  turnPort,
  type SpaceTurnPort,
  type TurnRun,
} from '../../runs/index.js';
import { mintFenceNonce } from '../../core/untrusted-text/untrusted-fence.js';
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
  liveSessionCwd,
  reserveKeptChat,
  resumeChatQueueFor,
  type SessionFacts,
} from './agent-send-defaults.js';
import {
  messageOfRun,
  runOfRow,
  SEND_SOURCE,
  sendSourceRef,
  stepOf,
  waitOf,
} from './agent-send-runs.js';
import { DeliveryListeners } from './agent-send-listeners.js';

export type { SessionFacts } from './agent-send-defaults.js';

/** How often held messages are tried again. */
export const HELD_RETRY_MS = 5_000;

export { UNHEARD_EVENTS_MAX } from './agent-send-listeners.js';

/** What the agent-send seam needs. Everything after `store` has a production default. */
export interface AgentSendDeps {
  /** Where messages and kept chats live. */
  store: AgentSendStore;
  /** An extension's manifest name, or its id when it is not installed. */
  extensionName: (extensionId: string) => string;
  /** Mesh, when it is running: resolves an agent id to its home. */
  meshCore: () => Pick<MeshCore, 'get' | 'getProjectPath' | 'listWithPaths'> | undefined;
  /**
   * The room binding port, read at call time: which chats a room answers for,
   * and the launch's own room guard (`ROOM_SESSION_MOVED`).
   */
  roomSessionPlace?: () => RoomSessionPlacePort | undefined;
  /** What DorkOS knows about a chat. */
  describeSession?: (sessionId: string) => Promise<SessionFacts>;
  /** The folder a chat runs in, when a live projector or its runtime knows. */
  sessionCwd?: (sessionId: string) => Promise<string | undefined>;
  /** Claims a start slot for a new kept chat (the start-work seam's `reserve`). */
  reserveChat?: (
    extensionId: string,
    sessionId: string
  ) => { ok: true; reservation: StartReservation } | { ok: false; message: string } | null;
  /** The turn port's space face, read at call time; the server's own by default. */
  port?: () => SpaceTurnPort | undefined;
  /** Re-arm a chat's queued rows after a restart, a mini app's included. */
  resumeQueue?: (sessionId: string, cwd: string | undefined) => Promise<void>;
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

/** How one attempt to hand a message to the turn port came out. */
type Attempt =
  | { kind: 'sent'; sessionId: string; reason: AgentSendWaitReason | null }
  | { kind: 'held' }
  | { kind: 'refused'; code: 'not_found' | 'not_allowed' | 'unavailable'; message: string };

/** The agent-send seam. See the module documentation. */
export class AgentSendService {
  /** Sends in flight, by extension and key: a racing retry waits for the first. */
  private readonly inflight = new Map<string, Promise<AgentSendReceipt>>();
  /** Each extension's listeners, and the events it has not heard yet. */
  private readonly hearers = new DeliveryListeners();
  private readonly nonce: () => string;
  private readonly describeSession: (sessionId: string) => Promise<SessionFacts>;
  private readonly sessionCwd: (sessionId: string) => Promise<string | undefined>;
  private readonly reserveChat: NonNullable<AgentSendDeps['reserveChat']>;
  private readonly port: () => SpaceTurnPort | undefined;
  private readonly resumeQueue: NonNullable<AgentSendDeps['resumeQueue']>;
  /** The port this seam reads its runs from, once it has heard of one. */
  private attachedTo: SpaceTurnPort | undefined;
  private detach: (() => void) | null = null;
  /** Start slots held for the kept chats messages are opening, by message, until their run ends. */
  private readonly reservations = new Map<string, StartReservation>();
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
  private started = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private draining: Promise<void> | null = null;

  /**
   * Build the seam, already listening to the turn port: an extension may send
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
    this.reserveChat = deps.reserveChat ?? reserveKeptChat;
    this.port = deps.port ?? turnPort;
    this.resumeQueue =
      deps.resumeQueue ??
      resumeChatQueueFor(deps.meshCore, deps.roomSessionPlace, { orFromApps: true });
    this.attach();
  }

  /**
   * The turn port, with this seam reading its messages' words for it and
   * hearing their runs. Attached once, the first time there is a port.
   */
  private attach(): SpaceTurnPort | undefined {
    const port = this.port();
    if (!port || port === this.attachedTo || this.stopped) return port;
    this.detach?.();
    this.attachedTo = port;
    // A message's words, until its turn starts: what the port hands over,
    // again after a restart if it must.
    const unregister = port.registerSource(SEND_SOURCE, {
      read: (id) => this.deps.store.get(id)?.content ?? undefined,
    });
    const unwatch = port.watch((run) => this.onRun(run));
    this.detach = () => {
      unregister();
      unwatch();
    };
    return port;
  }

  /**
   * Settle what a previous process left unfinished, and start retrying held
   * messages.
   *
   * A message an earlier process saved a run for reads its run now: still
   * waiting, it goes on waiting and runs; started, it hears its run's end (a
   * turn its process took with it reads `interrupted`). One with no run (an
   * earlier build queued it in the chat itself) can no longer be told apart
   * from one that ran, so it is reported `interrupted`. Only rows a PREVIOUS
   * process wrote are judged: a message this process sent before `start` ran
   * is live.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const port = this.attach();
    const resumed = new Set<string>();
    for (const row of this.deps.store.listByStatus(['queued', 'started'])) {
      if (this.createdHere.has(row.id)) continue;
      const run = port ? runOfRow(port, row) : undefined;
      if (run) this.onRun(run);
      // An earlier version queued it in the chat itself: still there, the
      // queue still runs it, and its run (once adopted) is heard by its row's id.
      else if (row.status !== 'queued' || !port?.waitsInQueue(row.id)) {
        this.fail(row, 'interrupted');
        continue;
      }
      // Waiting in a chat's queue: re-armed now, so an idle chat runs it
      // without waiting for the next message there.
      // By the chat its run is kept under now: a moved chat's rows moved with it.
      const chat = run?.sessionId ?? row.sessionId;
      const waiting = this.deps.store.get(row.id)?.status === 'queued';
      if (!waiting || !chat || resumed.has(chat)) continue;
      resumed.add(chat);
      await this.resumeQueue(chat, row.cwd ?? undefined).catch((err: unknown) =>
        logger.warn('[agent-send] could not re-arm a chat’s queued messages', {
          sessionId: chat,
          ...logError(err),
        })
      );
    }
    const retryMs = this.deps.retryMs ?? HELD_RETRY_MS;
    this.retryTimer = setInterval(
      outsideAuditScope(() => void this.drainHeld()),
      retryMs
    );
    this.retryTimer.unref?.();
  }

  /**
   * Stop listening and stop retrying, for a server shutting down. Held
   * messages stay held for the next process.
   */
  stop(): void {
    this.stopped = true;
    this.detach?.();
    this.detach = null;
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
    if (stored) return this.receiptNow(stored);
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
    return this.hearers.subscribe(extensionId, listener);
  }

  /**
   * An extension stopped, reloaded, was turned off or removed: nothing it sent
   * goes out after it is gone. Its held messages (waiting for its start limits)
   * are failed with `stopped`. When the stop was asked for (`takeBack`), its
   * messages still waiting to start (their run queued, in a chat's queue or
   * not handed over yet) are failed too, and their runs taken back; a message
   * whose launch has begun runs to its end. A child that crashed is not a
   * stop anyone asked for: what it sent stays where the person can see it. A
   * server shutting down is not an extension stopping either: after
   * {@link stop}, this does nothing, so waiting messages survive a restart.
   *
   * @param extensionId - The extension that stopped.
   * @param opts.takeBack - A person or DorkOS asked for the stop (a turn-off,
   *   a removal, a reload): take back its messages still waiting to start.
   */
  extensionStopped(extensionId: string, opts: { takeBack?: boolean } = {}): void {
    if (this.stopped) return;
    this.stoppedExtensions.add(extensionId);
    const port = this.attach();
    for (const row of this.deps.store.listByStatus(['held', 'queued'])) {
      if (row.extensionId !== extensionId) continue;
      if (row.status === 'queued') {
        if (!opts.takeBack) continue;
        const run = port ? runOfRow(port, row) : undefined;
        // Its launch has begun: it runs, or fails, and its row says which.
        if (run && !port?.withdraw(run.id, 'stopped')) continue;
      }
      this.fail(row, 'stopped');
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
      // A ULID: the message, its run and the queue row its words become share it.
      id: ulid(),
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
      // Saved, and waiting to start: the run says when it does.
      this.deps.store.update(row.id, { receiptStatus: 'queued', receiptReason: attempt.reason });
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
        // Not bound yet, opened by a message whose run has not ended: bound
        // when that run is handed over, and still this agent's. A bound chat
        // the agent moved away from is never reused, however busy it is.
        const opening =
          !facts.bound &&
          this.port()
            ?.list(kept)
            .some((run) => !RUN_ENDS.has(run.status));
        if (opening) return { sessionId: kept, agent };
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
   * Hand one message to the turn port: now, or as a retry of a held one.
   * Opens the agent's kept chat first when it has none.
   */
  private async attempt(row: AgentSendRecord, target: ResolvedTarget): Promise<Attempt> {
    // Events for this message wait until the port answers, so the receipt
    // always goes first.
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
    const door = this.attach();
    if (!door) {
      reservation?.cancel();
      throw new Error('The turn port is not wired yet');
    }
    // On the row before the start, so nothing that happens after it can
    // report a chat id this message never had.
    this.deps.store.update(row.id, { sessionId });
    const name = sanitizeIdentity(this.deps.extensionName(row.extensionId)) ?? row.extensionId;
    let runId: string;
    try {
      ({ runId } = door.start(
        {
          origin: { kind: 'extension-message' },
          sessionId,
          ...(target.agent ? { agentId: target.agent.id } : {}),
          // The chat's folder when known, an agent's home for its new chat, and
          // otherwise nothing: the launch path places it as it always has.
          ...(row.cwd ? { cwd: row.cwd } : target.agent ? { cwd: target.agent.path } : {}),
          content: row.content ?? '',
          tier: 'owner',
          sourceRef: sendSourceRef(row.id),
          ...(reservation
            ? {
                seedContext: `This chat was opened by the ${name} app so it can send this agent messages.`,
              }
            : {}),
        },
        // A message from before runs were named by it (a UUID) gets a run id of its own.
        RunIdSchema.safeParse(row.id).success ? { runId: row.id } : {}
      ));
    } catch (err) {
      reservation?.cancel();
      this.deps.store.update(row.id, { sessionId: target.sessionId });
      if (!(err instanceof TurnStartRefusedError)) throw err;
      const code = err.reason === 'invalid_agent_path' ? 'not_found' : 'unavailable';
      return { kind: 'refused', code, message: err.message };
    }
    if (reservation) this.reservations.set(row.id, reservation);
    // Its run is saved and will run: nothing after this may undo the send,
    // so a failure keeping the chat or reading why it waits only loses that.
    try {
      if (target.agent) this.deps.store.keepChat(row.extensionId, target.agent.id, sessionId);
      return { kind: 'sent', sessionId, reason: waitOf(door, sessionId, runId) };
    } catch (err) {
      logger.warn('[agent-send] a sent message’s chat could not be kept', {
        messageId: row.id,
        ...logError(err),
      });
      return { kind: 'sent', sessionId, reason: null };
    }
  }

  /**
   * A resend's answer: where the message is now, and, while it waits, why it
   * waits now (a chat that was busy at the first answer may be free).
   */
  private receiptNow(row: AgentSendRecord): AgentSendReceipt {
    const port = this.attach();
    const run = port && row.status === 'queued' ? runOfRow(port, row) : undefined;
    if (!port || run?.status !== 'queued') return receiptOf(row);
    return receiptOf({ ...row, receiptReason: waitOf(port, run.sessionId, run.id) });
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

  /** Translate a change of a message's run into this extension's delivery event. */
  private onRun(run: TurnRun): void {
    // Its words' source names it; a run adopted from an earlier version's
    // queue row is named by that row, which is the message's own id.
    const messageId = messageOfRun(run) ?? run.queueMessageId ?? undefined;
    const row = messageId === undefined ? undefined : this.deps.store.get(messageId);
    if (!row || row.status === 'done' || row.status === 'failed') return;
    const step = stepOf(run);
    const sessionId = row.sessionId ?? run.sessionId;
    if (step.kind === 'waiting') {
      // A pause cut its turn before the agent read it: it waits again and
      // starts afresh (DOR-4353).
      if (row.status === 'started') this.deps.store.update(row.id, { status: 'queued' });
      // Its words are a queue row now, the person's to see: this row lets them go.
      else if (run.queueMessageId !== null && row.content !== null)
        this.deps.store.update(row.id, { content: null });
      return;
    }
    // A watcher reads the run as it stands, so a turn that started and ended
    // between two reads still owes its ack, first.
    if (row.status === 'queued' && (step.kind === 'started' || run.startedAt !== null)) {
      // The runtime may have settled on another id for a chat this message opened.
      const reservation = this.reservations.get(row.id);
      if (reservation && run.sessionId !== row.sessionId) reservation.rekey(run.sessionId);
      if (row.agentId) this.deps.store.keepChat(row.extensionId, row.agentId, run.sessionId);
      this.deps.store.update(row.id, { status: 'started', content: null });
      this.deliver(row.extensionId, { kind: 'turn.started', messageId: row.id, sessionId });
    }
    if (step.kind === 'started' || step.kind === 'none') return;
    const reservation = this.reservations.get(row.id);
    this.reservations.delete(row.id);
    if (step.kind === 'failed') {
      // A chat that never started is forgotten, so it counts against no limit.
      if (run.startedAt === null) reservation?.cancel();
      else reservation?.settle();
      this.fail(row, step.reason);
      return;
    }
    reservation?.settle();
    this.deps.store.update(row.id, { status: 'done', content: null });
    this.deliver(row.extensionId, {
      kind: 'turn.done',
      messageId: row.id,
      sessionId,
      outcome: step.outcome,
    });
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

  /** Hand an event to the extension's listeners, or hold it while its message is mid-attempt. */
  private deliver(extensionId: string, event: AgentDeliveryEvent): void {
    const buffered = this.attempting.get(event.messageId);
    if (buffered) buffered.push(event);
    else this.hearers.deliver(extensionId, event);
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
