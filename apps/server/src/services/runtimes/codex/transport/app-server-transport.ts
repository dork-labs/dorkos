/**
 * The app-server transport: Codex turns on a long-lived `codex app-server`
 * per Codex home (spec `codex-app-server-transport` §4–§9, ADR 261005-113107).
 *
 * One turn: acquire the home's process (pool), make sure the session's thread
 * is loaded with the right config (loader), attach the turn's connector
 * binding to the thread key, `turn/start`, map the turn's notifications until
 * ITS `turn/completed`, detach. Exactly one `done` on every path: completion,
 * failure, interrupt, a stop Codex never confirms, a refused start, or the
 * process going away.
 *
 * **The joining trap.** `turn/start` on a thread with an open turn silently
 * steers into it. DorkOS serialises turns per session, so this transport keeps
 * its own map of open turns and refuses a second one locally (error + done,
 * nothing sent); if a response nevertheless names a turn already open, that is
 * an invariant breach, logged, and the generator ends with an error.
 *
 * **Approvals (spec §10).** `on-request` for every mode but full access, so
 * Codex stops and asks; each server request becomes a card in the open turn
 * (`app-server/server-requests.ts`), answered only by a person.
 *
 * @module services/runtimes/codex/transport/app-server-transport
 */
import type { InterruptReceipt, StreamEvent } from '@dorkos/shared/types';
import type { SessionWarmth } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../../lib/logger.js';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import { runtimeEnvironment } from '../../shared/runtime-environment-config.js';
import type { CreditsRelay } from '../../../core/cloud/credits-relay.js';
import {
  CreditsUnavailableError,
  creditsRefusalEvent,
} from '../../../core/cloud/credits-protocols.js';
import { creditsCodexHome, resolveCodexHome } from '../codex-home.js';
import { codexCreditsAppServerEnv, ensureCreditsCodexHome } from '../credits-launch.js';
import { EFFORT_TO_REASONING } from '../turn-input.js';
import {
  CodexAppServerPool,
  CodexCrashLoopError,
  codexAppServerPool,
  type CodexAppServerProcess,
} from '../app-server/process-pool.js';
import {
  CodexThreadLoader,
  type LoadedThread,
  type ThreadLoadInput,
} from '../app-server/thread-loader.js';
import { ThreadChannel, turnIdOf, type TurnSink } from '../app-server/thread-channel.js';
import { AppServerTurnMapper } from '../app-server/notification-mapper.js';
import { mergeRateLimits, rateLimitsToRolloutShape } from '../app-server/rate-limits.js';
import { approvalPolicyFor, EventQueue, sandboxPolicyFor } from '../app-server/turn-parts.js';
import { CODEX_APP_SERVER_CAPABILITIES } from '../runtime-constants.js';
import { CodexProcessExitedError, isCodexRpcError } from '../app-server/protocol/errors.js';
import type {
  ServerNotification,
  ServerRequest,
  TurnStartParams,
} from '../app-server/protocol/methods.js';
import {
  CodexServerRequestBroker,
  logRefusedServerRequest,
  mapServerRequest,
  type PendingCodexInteraction,
  type ServerRequestTurnView,
} from '../app-server/server-requests.js';
import type { CodexTransport, CodexTurnRequest } from './codex-transport.js';

/** The shared bound on a stop's acknowledgement (claude-code's `STOP_ACK_TIMEOUT_MS`). */
export const APP_SERVER_STOP_ACK_MS = 3_000;

/** Dependencies of {@link AppServerCodexTransport}. */
export interface AppServerTransportOptions {
  /** The connector listener's tools and thread keys, once boot installed them. */
  readonly connectorTools: () => ConnectorRuntimeTools | undefined;
  /** The credits relay, when boot started one. */
  readonly creditsRelay?: () => CreditsRelay | undefined;
  /** The pool; defaults to the process-wide one. */
  readonly pool?: CodexAppServerPool;
  /** Process environments; default to the projected Codex turn environment. */
  readonly environment?: {
    readonly person: () => Record<string, string>;
    readonly credits: () => Record<string, string>;
  };
  /** Bound on a stop's acknowledgement. */
  readonly stopAckMs?: number;
  /** Realpath seam for the loader. */
  readonly realpath?: (path: string) => string;
  /** The countdown an approval, question or elicitation card shows. */
  readonly interactionCountdownMs?: number;
  /** When an unanswered request is declined (default: the park ceiling). */
  readonly interactionExpireMs?: number;
}

interface OpenTurn {
  readonly sessionId: string;
  readonly process: CodexAppServerProcess;
  readonly threadId: string;
  turnId: string | undefined;
  /** Resolves with the turn's terminal status once `turn/completed` arrives. */
  readonly completed: Promise<string>;
  readonly markCompleted: (status: string) => void;
  /** Ends the generator early (a stop Codex never confirmed). */
  readonly abandon: () => void;
  /** Set when DorkOS gave up waiting on a stop: Codex may still be running it. */
  abandoned: boolean;
  /** Set when this turn's own terminal (or the process's end) was seen. */
  sawTerminal: boolean;
  interrupting: Promise<InterruptReceipt> | undefined;
  /** Push events into the turn (a server request's card). */
  deliver: (events: StreamEvent[]) => void;
  /** What the turn has seen, for a card about one of its tools. */
  view: ServerRequestTurnView;
}

/** A turn DorkOS stopped waiting on that Codex has not reported finished. */
interface LingeringTurn {
  readonly turnId: string;
  readonly process: CodexAppServerProcess;
  /** How many turns were refused because of it so far. */
  refusals: number;
  /** Stops listening for the process's exit. */
  readonly stopWatching: () => void;
}

/**
 * Refusals of a new turn (`turn_stopping`) before DorkOS gives up on a turn
 * Codex will not stop and reloads just that thread as a fork instead.
 */
const LINGERING_REFUSAL_LIMIT = 3;

/** Codex turns on `codex app-server`. */
export class AppServerCodexTransport implements CodexTransport {
  readonly kind = 'app-server' as const;
  /** What this transport adds over exec (spec §14): warmth, approvals, questions. */
  readonly capabilities = CODEX_APP_SERVER_CAPABILITIES;

  private readonly pool: CodexAppServerPool;
  private readonly loader: CodexThreadLoader;
  private readonly stopAckMs: number;
  /** One routed subscription per loaded (process, thread). */
  private readonly channels = new Map<string, ThreadChannel>();
  /** Open turns, by thread id: the joining-trap guard. */
  private readonly openByThread = new Map<string, OpenTurn>();
  /** Open turns, by session. */
  private readonly openBySession = new Map<string, OpenTurn>();
  /**
   * Turns DorkOS stopped waiting on (an unconfirmed stop) that Codex has not
   * yet reported finished, by thread. A new `turn/start` on such a thread
   * would silently join it, so the next turn re-sends the stop and waits.
   */
  private readonly lingering = new Map<string, LingeringTurn>();
  /** Last full rate-limit reading per person-home process. */
  private readonly rateLimits = new Map<string, unknown>();
  /** Relay keys per credits process, revoked when it stops. */
  private readonly relayKeys = new Map<string, { baseUrl: string; key: string }>();
  /** Config warnings to say once, per process, in its next turn. */
  private readonly pendingWarnings = new Map<string, string[]>();
  private readonly watched = new WeakSet<CodexAppServerProcess>();
  /** Approvals, questions and elicitations waiting on a person (spec §10). */
  private readonly requests: CodexServerRequestBroker;

  /**
   * Construct the transport.
   *
   * @param options - Collaborators and seams.
   */
  constructor(private readonly options: AppServerTransportOptions) {
    this.pool = options.pool ?? codexAppServerPool;
    this.stopAckMs = options.stopAckMs ?? APP_SERVER_STOP_ACK_MS;
    this.requests = new CodexServerRequestBroker({
      ...(options.interactionCountdownMs !== undefined
        ? { countdownMs: options.interactionCountdownMs }
        : {}),
      ...(options.interactionExpireMs !== undefined
        ? { expireMs: options.interactionExpireMs }
        : {}),
    });
    this.loader = new CodexThreadLoader({
      threadKeys: () => options.connectorTools()?.threadKeys,
      ...(options.realpath ? { realpath: options.realpath } : {}),
    });
  }

  /**
   * Run one turn on the session's thread.
   *
   * @param request - The resolved turn.
   */
  async *runTurn(request: CodexTurnRequest): AsyncGenerator<StreamEvent> {
    const sessionId = request.sessionId;
    const onCredits = request.launch.home === 'credits';
    let process: CodexAppServerProcess;
    let release: (() => void) | undefined;
    let loaded: LoadedThread;
    let relay: { baseUrl: string; key: string } | undefined;
    let loadInput: ThreadLoadInput;
    // Whether the thread this turn runs on has no turn of DorkOS's still
    // winding down in Codex.
    let clear: boolean;
    try {
      process = await this.acquire(request.binary, onCredits);
      release = process.hold();
      relay = onCredits ? this.relayFor(process) : undefined;
      loadInput = {
        process,
        home: onCredits ? 'credits' : 'person',
        sessionId,
        boundThreadId: request.boundThreadId,
        cwd: request.cwd,
        settings: request.settings,
        tools: request.tools,
        ...(relay ? { creditsRelay: relay } : {}),
      };
      // Stop a turn DorkOS gave up on BEFORE loading: the load may fork this
      // thread away (refreshed credentials), and a turn left running on the
      // old one would keep going, and keep billing on credits, unseen.
      const current = this.loader.loadedThreadFor(loadInput);
      clear = current === undefined || (await this.settleLingering(process, current));
      loaded = await this.loader.ensureLoaded(loadInput);
      if (loaded.threadId !== current) clear = await this.settleLingering(process, loaded.threadId);
    } catch (err) {
      release?.();
      yield* this.failedSetup(sessionId, err);
      return;
    }
    if (loaded.retired !== undefined) this.retire(process, loaded.retired);

    if (!clear) {
      const lingering = this.lingering.get(loaded.threadId);
      if (lingering && ++lingering.refusals >= LINGERING_REFUSAL_LIMIT) {
        // Codex will not stop that turn. Reload just this thread (a fork,
        // with the conversation) rather than block the session indefinitely.
        try {
          loaded = await this.loader.reload(loadInput, loaded.threadId);
          if (loaded.retired !== undefined) this.retire(process, loaded.retired);
        } catch (err) {
          logger.warn('[CodexAppServer] could not reload a thread stuck stopping', {
            sessionId,
            err: String(err),
          });
        }
      }
    }
    if (this.lingering.has(loaded.threadId)) {
      release();
      yield {
        type: 'error',
        data: {
          message: 'Codex is still stopping the last reply. Try again in a moment.',
          code: 'turn_stopping',
        },
      };
      yield { type: 'done', data: { sessionId } };
      return;
    }
    const turn = this.openTurn(sessionId, process, loaded.threadId);
    if (!turn) {
      release();
      // DorkOS serialises turns, so this is a bug, not a person's action: say
      // so, and never send a `turn/start` that would silently join the open one.
      logger.error('[CodexAppServer] refused a second turn on a thread with an open turn', {
        sessionId,
      });
      yield {
        type: 'error',
        data: {
          message: 'Codex is still working on the last message. Try again when it finishes.',
          code: 'turn_open',
        },
      };
      yield { type: 'done', data: { sessionId } };
      return;
    }

    const keys = this.options.connectorTools()?.threadKeys;
    const attached =
      loaded.keyId !== undefined && request.tools.connectorBindingId !== undefined
        ? { keyId: loaded.keyId, bindingId: request.tools.connectorBindingId }
        : undefined;
    const queue = new EventQueue();
    const mapper = new AppServerTurnMapper(request.events, {
      rateLimits: () => (onCredits ? [] : this.rolloutRateLimits(process)),
    });
    const channel = this.channelFor(process, loaded.threadId);
    let bound = !loaded.needsBinding;
    // A server request's card can arrive before `turn/start` answered (the
    // channel is still buffering the items it is about): hold it until then,
    // so it never lands ahead of its tool's start.
    const early: StreamEvent[] = [];
    const sink: TurnSink = {
      turnId: undefined,
      notify: (notification) => {
        if (notification.method === 'turn/started' && !bound) {
          bound = true;
          request.onThreadBound(loaded.threadId, loaded.replaces);
          this.loader.markBound(process, loaded.threadId);
        }
        if (notification.method === 'turn/completed') {
          turn.sawTerminal = true;
          turn.markCompleted(
            String((notification.params as { turn?: { status?: unknown } }).turn?.status)
          );
          // Codex clears what it still asked about when a turn ends; so do the cards.
          this.requests.cancelSession(sessionId);
        }
        queue.push(mapper.map(notification));
        if (mapper.isFinished) queue.end();
      },
      closed: (close) => {
        turn.sawTerminal = true;
        turn.markCompleted('crashed');
        this.requests.cancelSession(sessionId);
        queue.push(mapper.closeOnCrash(close.detail));
        queue.end();
      },
    };
    turn.deliver = (events) => {
      if (sink.turnId === undefined) early.push(...events);
      else queue.push(events);
    };
    turn.view = {
      inputOf: (itemId) => mapper.inputOf(itemId),
      runningMcpCall: (server) => mapper.runningMcpCall(server),
    };
    (turn as { abandon: () => void }).abandon = () => {
      turn.abandoned = true;
      this.requests.cancelSession(sessionId);
      queue.push(mapper.closeQuietly());
      queue.end();
    };
    // Every early exit ends the same way: whatever the mapper already queued
    // (a crash it heard first, say) and then its closing events, so the turn
    // always ends with exactly one `done`.
    const finish = (closing: StreamEvent[]): AsyncGenerator<StreamEvent> => {
      queue.push(closing);
      queue.end();
      return queue.drain();
    };
    const onAbort = (): void => void this.interrupt(sessionId);
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      if (loaded.notice) yield loaded.notice;
      for (const message of this.takeWarnings(process)) {
        yield { type: 'system_status', data: { message } };
      }
      if (attached) {
        try {
          keys?.attach(attached.keyId, {
            bindingId: attached.bindingId,
            canonicalSessionId: sessionId,
          });
        } catch (err) {
          // The turn runs; its DorkOS tools are refused (nothing is attached).
          logger.warn('[CodexAppServer] could not attach the turn to its thread key', {
            sessionId,
            keyId: attached.keyId,
            err: String(err),
          });
        }
      }
      channel.open(sink);
      if (request.signal.aborted) {
        yield* finish(mapper.closeQuietly());
        return;
      }
      let turnId: string;
      try {
        const result = await process.client.request(
          'turn/start',
          this.turnParams(request, loaded.threadId)
        );
        turnId = result.turn.id;
      } catch (err) {
        yield* finish(this.failedStart(mapper, err));
        return;
      }
      if (this.isKnownOpenTurn(turnId, turn)) {
        logger.error('[CodexAppServer] turn/start joined a turn already open (invariant breach)', {
          sessionId,
        });
        yield* finish(
          mapper.closeQuietly({
            message: 'Codex joined this message to a reply already running. Send it again.',
            code: 'turn_joined',
          })
        );
        return;
      }
      turn.turnId = turnId;
      sink.turnId = turnId;
      if (turn.abandoned) {
        // The stop gave up before Codex named the turn: stop it now that it has.
        void process.client
          .request('turn/interrupt', { threadId: loaded.threadId, turnId })
          .catch(() => undefined);
      }
      channel.flush();
      queue.push(early.splice(0));
      yield* queue.drain();
    } finally {
      // Every request still held gets its one reply; the turn is over.
      this.requests.dropSession(sessionId);
      request.signal.removeEventListener('abort', onAbort);
      channel.release(sink);
      if (attached) keys?.detach(attached.keyId, attached.bindingId);
      this.closeTurn(turn);
      release();
    }
  }

  /**
   * Stop the session's open turn: `turn/interrupt`, then wait (bounded) for
   * Codex to wind it down. `acked` when it did, `unconfirmed` when it did not
   * (there is no session-scoped escalation: killing the process would end
   * every other Codex chat in that home), `not-running` when nothing is open.
   *
   * @param sessionId - The session.
   */
  interrupt(sessionId: string): Promise<InterruptReceipt> {
    const turn = this.openBySession.get(sessionId);
    if (!turn)
      return Promise.resolve({ outcome: 'not-running', reason: 'no-open-turn', runtime: 'codex' });
    // Cancel what the turn is waiting on first, then stop it (spec §10).
    const cancelled = this.requests.cancelSession(sessionId);
    turn.interrupting ??= this.sendInterrupt(turn, cancelled > 0);
    return turn.interrupting;
  }

  private async sendInterrupt(turn: OpenTurn, afterReplies: boolean): Promise<InterruptReceipt> {
    const deadline = Date.now() + this.stopAckMs;
    // The cancel replies are written once their promises settle (microtasks);
    // let them go out before the interrupt does.
    if (afterReplies) await new Promise<void>((resolve) => setImmediate(resolve));
    // The turn id arrives with the `turn/start` answer; a stop before that waits for it.
    while (turn.turnId === undefined && Date.now() < deadline) {
      await Promise.race([turn.completed, sleep(10)]);
      if (this.openBySession.get(turn.sessionId) !== turn) break;
    }
    if (turn.turnId === undefined) {
      turn.abandon();
      return { outcome: 'unconfirmed', reason: 'ack-timeout', runtime: 'codex' };
    }
    try {
      await turn.process.client.request(
        'turn/interrupt',
        { threadId: turn.threadId, turnId: turn.turnId },
        { timeoutMs: Math.max(1, deadline - Date.now()) }
      );
    } catch (err) {
      if (isCodexRpcError(err, 'no-active-turn')) {
        return { outcome: 'not-running', reason: 'no-open-turn', runtime: 'codex' };
      }
      // Fall through to the bounded wait: the turn may still wind down.
    }
    const status = await Promise.race([
      turn.completed,
      sleep(Math.max(0, deadline - Date.now())).then(() => null),
    ]);
    if (status !== null) return { outcome: 'acked', runtime: 'codex' };
    turn.abandon();
    return { outcome: 'unconfirmed', reason: 'ack-timeout', runtime: 'codex' };
  }

  /**
   * `warm` while the session's thread is loaded in a live process with no turn
   * open, `running` while one is, `cold` otherwise.
   *
   * @param sessionId - The session.
   */
  getSessionWarmth(sessionId: string): SessionWarmth {
    if (this.openBySession.has(sessionId)) return 'running';
    return this.loader.holdsSession(sessionId) ? 'warm' : 'cold';
  }

  /**
   * A person approved or denied a card Codex is waiting on. `false` when
   * nothing approvable is pending under that id.
   *
   * @param sessionId - The session.
   * @param interactionId - The card's `toolCallId`.
   * @param approved - The decision.
   * @param alwaysAllow - Approve for the rest of the session, where offered.
   */
  answerApproval(
    sessionId: string,
    interactionId: string,
    approved: boolean,
    alwaysAllow?: boolean
  ): boolean {
    return this.requests.answerApproval(sessionId, interactionId, approved, alwaysAllow);
  }

  /**
   * A person answered a question card.
   *
   * @param sessionId - The session.
   * @param interactionId - The card's `toolCallId`.
   * @param answers - Canonical answers, keyed by question index.
   */
  answerQuestion(
    sessionId: string,
    interactionId: string,
    answers: Record<string, string>
  ): boolean {
    return this.requests.answerQuestion(sessionId, interactionId, answers);
  }

  /**
   * A person answered an elicitation card.
   *
   * @param sessionId - The session.
   * @param interactionId - The card's `interactionId`.
   * @param action - Accept, decline or cancel.
   * @param content - The form's content, on accept.
   */
  answerElicitation(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ): boolean {
    return this.requests.answerElicitation(sessionId, interactionId, action, content);
  }

  /**
   * The requests the session's turn is waiting on a person for.
   *
   * @param sessionId - The session.
   */
  pendingInteractions(sessionId: string): PendingCodexInteraction[] {
    return this.requests.pendingFor(sessionId);
  }

  /**
   * Give the session's thread back: forget it here (its key is revoked) and
   * mark its process stale so the pool recycles it once nothing in it is
   * live. The next turn resumes the thread cold. Never called with an
   * interaction open.
   *
   * @param sessionId - The session.
   */
  async reapSession(sessionId: string): Promise<void> {
    if (this.openBySession.has(sessionId)) return;
    for (const { processKey, threadId } of this.loader.threadsOf(sessionId)) {
      const process = this.pool.list().find((candidate) => candidate.key === processKey);
      if (!process) continue;
      process.stale = true;
      this.loader.dropThread(process, threadId);
      this.disposeChannel(process, threadId);
    }
    await this.pool.reapOnce();
  }

  /** Stop every app-server process (server shutdown). */
  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }

  /** Stop the credits-home process (an unlink), revoking its relay key. */
  async closeCreditsProcess(): Promise<void> {
    const home = creditsCodexHome();
    await this.pool.closeWhere((process) => process.spec.codexHome === home);
  }

  private async acquire(binary: string, onCredits: boolean): Promise<CodexAppServerProcess> {
    if (onCredits) {
      if (!this.options.creditsRelay?.()) throw new CreditsUnavailableError('unreachable', 'Codex');
      ensureCreditsCodexHome();
      const env =
        this.options.environment?.credits() ??
        codexCreditsAppServerEnv(runtimeEnvironment('codex', 'turn'));
      return this.watch(await this.pool.acquire({ binary, codexHome: creditsCodexHome(), env }));
    }
    const env = this.options.environment?.person() ?? runtimeEnvironment('codex', 'turn');
    const process = this.watch(
      await this.pool.acquire({ binary, codexHome: resolveCodexHome(env), env })
    );
    if (!this.rateLimits.has(process.key)) this.readRateLimits(process);
    return process;
  }

  /** Per-process bookkeeping, once: relay key and rate-limit cleanup, warnings. */
  private watch(process: CodexAppServerProcess): CodexAppServerProcess {
    if (this.watched.has(process)) return process;
    this.watched.add(process);
    // Work Codex runs past a turn (a background terminal) keeps the process
    // alive: the reaper asks before closing it (spec §5). Full tracking and
    // the chat wake are spec phase P3.
    process.addLivenessProbe(async () => {
      for (const threadId of this.loader.threadsInProcess(process.key)) {
        try {
          const result = await process.client.request(
            'thread/backgroundTerminals/list',
            { threadId },
            { timeoutMs: 5_000 }
          );
          if (result.data.length > 0) return true;
        } catch (err) {
          // Codex no longer has the thread loaded: nothing of it is live, and
          // the record is stale.
          if (!isCodexRpcError(err, 'thread-not-found')) throw err;
          this.loader.dropThread(process, threadId);
          this.disposeChannel(process, threadId);
        }
      }
      return false;
    });
    const unsubscribe = process.client.subscribeProcess((notification) =>
      this.onProcessNotification(process, notification)
    );
    process.client.setServerRequestHandler((request) => this.onServerRequest(process, request));
    process.onExit(() => {
      unsubscribe();
      const relay = this.relayKeys.get(process.key);
      if (relay) this.options.creditsRelay?.()?.revoke(relay.key);
      this.relayKeys.delete(process.key);
      this.rateLimits.delete(process.key);
      this.pendingWarnings.delete(process.key);
      for (const [key, channel] of this.channels) {
        if (channel.process === process) {
          channel.dispose();
          this.channels.delete(key);
        }
      }
    });
    return process;
  }

  /**
   * One server → client request: a card in the open turn it belongs to, or
   * a refusal. `undefined` declines it with the method's own "no".
   */
  private onServerRequest(
    process: CodexAppServerProcess,
    request: ServerRequest
  ): Promise<unknown> | unknown {
    const params = (request.params ?? {}) as { threadId?: unknown; turnId?: unknown };
    const turn =
      typeof params.threadId === 'string' ? this.openByThread.get(params.threadId) : undefined;
    const wrongTurn =
      turn !== undefined &&
      typeof params.turnId === 'string' &&
      turn.turnId !== undefined &&
      params.turnId !== turn.turnId;
    if (!turn || turn.process !== process || wrongTurn) {
      // Nobody is in a turn to ask: never answered yes on their behalf.
      logRefusedServerRequest(request.method, 'no DorkOS turn is open on that thread');
      return undefined;
    }
    const mapped = mapServerRequest(request, turn.view);
    if ('refuse' in mapped) {
      logRefusedServerRequest(request.method, mapped.why);
      return mapped.refuse;
    }
    return this.requests.open({
      sessionId: turn.sessionId,
      processKey: process.key,
      jsonRpcId: request.id,
      mapped,
      emit: (events) => turn.deliver(events),
    });
  }

  private relayFor(process: CodexAppServerProcess): { baseUrl: string; key: string } {
    let relay = this.relayKeys.get(process.key);
    if (!relay) {
      const issuer = this.options.creditsRelay?.();
      if (!issuer) throw new CreditsUnavailableError('unreachable', 'Codex');
      relay = issuer.issue('openai-responses', 'Codex');
      this.relayKeys.set(process.key, relay);
    }
    return relay;
  }

  private readRateLimits(process: CodexAppServerProcess): void {
    this.rateLimits.set(process.key, null);
    void process.client
      .request('account/rateLimits/read', null)
      .then((result) => {
        const snapshot = (result as { rateLimits?: unknown } | null)?.rateLimits;
        this.rateLimits.set(
          process.key,
          mergeRateLimits(this.rateLimits.get(process.key), snapshot)
        );
      })
      .catch((err: unknown) =>
        logger.debug('[CodexAppServer] rate limits unavailable', { err: String(err) })
      );
  }

  private rolloutRateLimits(process: CodexAppServerProcess): unknown[] {
    const shaped = rateLimitsToRolloutShape(this.rateLimits.get(process.key));
    return shaped ? [shaped] : [];
  }

  private onProcessNotification(
    process: CodexAppServerProcess,
    notification: ServerNotification
  ): void {
    const params = notification.params as Record<string, unknown> | undefined;
    switch (notification.method) {
      case 'account/rateLimits/updated':
        if (this.rateLimits.has(process.key)) {
          this.rateLimits.set(
            process.key,
            mergeRateLimits(this.rateLimits.get(process.key), params?.rateLimits)
          );
        }
        return;
      case 'configWarning': {
        const summary = String(params?.summary ?? '');
        logger.warn('[CodexAppServer] Codex config warning', { summary, details: params?.details });
        if (summary)
          this.pendingWarnings.set(process.key, [
            ...(this.pendingWarnings.get(process.key) ?? []),
            summary,
          ]);
        return;
      }
      case 'warning':
      case 'deprecationNotice':
        logger.info(`[CodexAppServer] ${notification.method}`, { params });
        return;
      default:
        return;
    }
  }

  private takeWarnings(process: CodexAppServerProcess): string[] {
    const warnings = this.pendingWarnings.get(process.key) ?? [];
    this.pendingWarnings.set(process.key, []);
    return warnings;
  }

  private channelFor(process: CodexAppServerProcess, threadId: string): ThreadChannel {
    const key = `${process.key}:${threadId}`;
    let channel = this.channels.get(key);
    if (!channel) {
      channel = new ThreadChannel(
        process,
        threadId,
        (notification) => {
          if (notification.method === 'serverRequest/resolved') {
            const params = notification.params as { requestId?: unknown } | undefined;
            this.requests.resolvedByServer(process.key, params?.requestId);
            return;
          }
          if (notification.method === 'thread/closed') {
            // Codex unloaded it after its idle window: forget it, revoke its key.
            this.loader.dropThread(process, threadId);
            this.disposeChannel(process, threadId);
            this.clearLingering(threadId);
          }
        },
        (notification) => {
          // An abandoned turn finally ending clears the way for the next one.
          const lingering = this.lingering.get(threadId);
          if (
            notification.method === 'turn/completed' &&
            lingering !== undefined &&
            turnIdOf(notification) === lingering.turnId
          ) {
            this.clearLingering(threadId);
          }
        }
      );
      this.channels.set(key, channel);
    }
    return channel;
  }

  private disposeChannel(process: CodexAppServerProcess, threadId: string): void {
    const key = `${process.key}:${threadId}`;
    this.channels.get(key)?.dispose();
    this.channels.delete(key);
  }

  private openTurn(
    sessionId: string,
    process: CodexAppServerProcess,
    threadId: string
  ): OpenTurn | undefined {
    if (this.openByThread.has(threadId) || this.openBySession.has(sessionId)) return undefined;
    let markCompleted!: (status: string) => void;
    const completed = new Promise<string>((resolve) => (markCompleted = resolve));
    const turn: OpenTurn = {
      sessionId,
      process,
      threadId,
      turnId: undefined,
      completed,
      markCompleted,
      abandon: () => {},
      abandoned: false,
      sawTerminal: false,
      interrupting: undefined,
      deliver: () => {},
      view: { inputOf: () => undefined, runningMcpCall: () => undefined },
    };
    this.openByThread.set(threadId, turn);
    this.openBySession.set(sessionId, turn);
    return turn;
  }

  private isKnownOpenTurn(turnId: string, mine: OpenTurn): boolean {
    for (const turn of this.openByThread.values()) {
      if (turn !== mine && turn.turnId === turnId) return true;
    }
    for (const lingering of this.lingering.values()) {
      if (lingering.turnId === turnId) return true;
    }
    return false;
  }

  private closeTurn(turn: OpenTurn): void {
    if (this.openByThread.get(turn.threadId) === turn) this.openByThread.delete(turn.threadId);
    if (this.openBySession.get(turn.sessionId) === turn) this.openBySession.delete(turn.sessionId);
    if (turn.abandoned && !turn.sawTerminal && turn.turnId !== undefined && turn.process.isOpen) {
      const stopWatching = turn.process.onExit(() => {
        if (this.lingering.get(turn.threadId)?.process === turn.process) {
          this.clearLingering(turn.threadId);
        }
      });
      this.lingering.set(turn.threadId, {
        turnId: turn.turnId,
        process: turn.process,
        refusals: 0,
        stopWatching,
      });
    }
    turn.markCompleted('closed');
  }

  /** Forget a lingering turn and stop watching its process. */
  private clearLingering(threadId: string): void {
    const lingering = this.lingering.get(threadId);
    if (!lingering) return;
    lingering.stopWatching();
    this.lingering.delete(threadId);
  }

  /**
   * Stop routing a thread the loader reloaded as a fork. A turn DorkOS gave
   * up on there is asked to stop once more on the way out: nothing will watch
   * that thread again, and Codex otherwise runs the turn to its end (on a
   * credits thread, billed until it does).
   */
  private retire(process: CodexAppServerProcess, threadId: string): void {
    const lingering = this.lingering.get(threadId);
    if (lingering && lingering.process === process && process.isOpen) {
      void process.client
        .request('turn/interrupt', { threadId, turnId: lingering.turnId })
        .catch(() => undefined);
    }
    this.disposeChannel(process, threadId);
    this.clearLingering(threadId);
  }

  /**
   * Before a new turn on a thread whose last turn DorkOS stopped waiting on:
   * stop it again and wait (bounded) for Codex to finish it. `true` when the
   * thread is clear to start a turn.
   */
  private async settleLingering(
    process: CodexAppServerProcess,
    threadId: string
  ): Promise<boolean> {
    const lingering = this.lingering.get(threadId);
    if (!lingering) return true;
    if (lingering.process !== process || !process.isOpen) {
      this.clearLingering(threadId);
      return true;
    }
    try {
      await process.client.request(
        'turn/interrupt',
        { threadId, turnId: lingering.turnId },
        { timeoutMs: this.stopAckMs }
      );
    } catch (err) {
      // Verified on 0.154: a turn id that is no longer running (finished, or
      // never existed) answers "no active turn to interrupt". A different
      // active turn would answer a mismatch; either way that turn is gone.
      if (isCodexRpcError(err, 'no-active-turn', 'turn-mismatch')) {
        this.clearLingering(threadId);
        return true;
      }
    }
    const deadline = Date.now() + this.stopAckMs;
    while (this.lingering.has(threadId) && Date.now() < deadline) await sleep(20);
    return !this.lingering.has(threadId);
  }

  private turnParams(request: CodexTurnRequest, threadId: string): TurnStartParams {
    const effort =
      request.settings.effort !== undefined
        ? EFFORT_TO_REASONING[request.settings.effort]
        : undefined;
    return {
      threadId,
      input: [{ type: 'text', text: request.prompt, text_elements: [] }],
      ...(request.messageId !== undefined ? { clientUserMessageId: request.messageId } : {}),
      // Sent every turn (they are sticky): a mode or model change between turns lands.
      cwd: request.cwd,
      approvalPolicy: approvalPolicyFor(request.settings),
      sandboxPolicy: sandboxPolicyFor(request),
      ...(request.settings.model !== undefined ? { model: request.settings.model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      summary: 'auto',
    };
  }

  private *failedSetup(sessionId: string, err: unknown): Generator<StreamEvent> {
    const refusal = creditsRefusalEvent(err);
    if (refusal) {
      yield refusal;
    } else if (err instanceof CodexCrashLoopError) {
      yield { type: 'error', data: { message: err.message, code: 'codex_crash_loop' } };
    } else {
      logger.warn('[CodexAppServer] could not open the turn', { sessionId, err: String(err) });
      yield {
        type: 'error',
        data: {
          message: 'Codex could not start this reply. Send your message again to retry.',
          code: 'codex_unavailable',
          details: err instanceof Error ? err.message : String(err),
        },
      };
    }
    yield { type: 'done', data: { sessionId } };
  }

  private failedStart(mapper: AppServerTurnMapper, err: unknown): StreamEvent[] {
    if (err instanceof CodexProcessExitedError) return mapper.closeOnCrash(err.detail);
    logger.warn('[CodexAppServer] turn/start failed', { err: String(err) });
    return mapper.closeQuietly({
      message: 'Codex could not start this reply. Send your message again to retry.',
      code: 'codex_unavailable',
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Build the app-server transport for `CodexRuntime`.
 *
 * @param options - Collaborators.
 */
export function createAppServerTransport(
  options: AppServerTransportOptions
): AppServerCodexTransport {
  return new AppServerCodexTransport(options);
}
