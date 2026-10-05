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
 * **P1 posture.** `approvalPolicy: 'never'` with exec's sandbox mapping, so a
 * chat behaves as it does on exec; every server request is refused by the
 * client (nothing is ever accepted); `supportsPersistentSession` is the only
 * capability it adds.
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
import { CodexThreadLoader, type LoadedThread } from '../app-server/thread-loader.js';
import { ThreadChannel, type TurnSink } from '../app-server/thread-channel.js';
import { AppServerTurnMapper } from '../app-server/notification-mapper.js';
import { mergeRateLimits, rateLimitsToRolloutShape } from '../app-server/rate-limits.js';
import { EventQueue, sandboxPolicyFor } from '../app-server/turn-parts.js';
import { CodexProcessExitedError, isCodexRpcError } from '../app-server/protocol/errors.js';
import type { ServerNotification, TurnStartParams } from '../app-server/protocol/methods.js';
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
  interrupting: Promise<InterruptReceipt> | undefined;
}

/** Codex turns on `codex app-server`. */
export class AppServerCodexTransport implements CodexTransport {
  readonly kind = 'app-server' as const;
  /** A thread stays loaded between turns, so a session can be warm. */
  readonly capabilities = { supportsPersistentSession: true } as const;

  private readonly pool: CodexAppServerPool;
  private readonly loader: CodexThreadLoader;
  private readonly stopAckMs: number;
  /** One routed subscription per loaded (process, thread). */
  private readonly channels = new Map<string, ThreadChannel>();
  /** Open turns, by thread id: the joining-trap guard. */
  private readonly openByThread = new Map<string, OpenTurn>();
  /** Open turns, by session. */
  private readonly openBySession = new Map<string, OpenTurn>();
  /** Last full rate-limit reading per person-home process. */
  private readonly rateLimits = new Map<string, unknown>();
  /** Relay keys per credits process, revoked when it stops. */
  private readonly relayKeys = new Map<string, { baseUrl: string; key: string }>();
  /** Config warnings to say once, per process, in its next turn. */
  private readonly pendingWarnings = new Map<string, string[]>();
  private readonly watched = new WeakSet<CodexAppServerProcess>();

  /**
   * Construct the transport.
   *
   * @param options - Collaborators and seams.
   */
  constructor(private readonly options: AppServerTransportOptions) {
    this.pool = options.pool ?? codexAppServerPool;
    this.stopAckMs = options.stopAckMs ?? APP_SERVER_STOP_ACK_MS;
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
    try {
      process = await this.acquire(request.binary, onCredits);
      release = process.hold();
      relay = onCredits ? this.relayFor(process) : undefined;
      loaded = await this.loader.ensureLoaded({
        process,
        home: onCredits ? 'credits' : 'person',
        sessionId,
        boundThreadId: request.boundThreadId,
        cwd: request.cwd,
        settings: request.settings,
        tools: request.tools,
        ...(relay ? { creditsRelay: relay } : {}),
      });
    } catch (err) {
      release?.();
      yield* this.failedSetup(sessionId, err);
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
    const sink: TurnSink = {
      turnId: undefined,
      notify: (notification) => {
        if (notification.method === 'turn/started' && !bound) {
          bound = true;
          request.onThreadBound(loaded.threadId, loaded.replaces);
          this.loader.markBound(process, loaded.threadId);
        }
        if (notification.method === 'turn/completed') {
          turn.markCompleted(
            String((notification.params as { turn?: { status?: unknown } }).turn?.status)
          );
        }
        queue.push(mapper.map(notification));
        if (mapper.isFinished) queue.end();
      },
      closed: (close) => {
        turn.markCompleted('crashed');
        queue.push(mapper.closeOnCrash(close.detail));
        queue.end();
      },
    };
    (turn as { abandon: () => void }).abandon = () => {
      queue.push(mapper.closeQuietly());
      queue.end();
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
        yield* mapper.closeQuietly();
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
        yield* this.failedStart(mapper, err);
        return;
      }
      if (this.isKnownOpenTurn(turnId, turn)) {
        logger.error('[CodexAppServer] turn/start joined a turn already open (invariant breach)', {
          sessionId,
        });
        yield* mapper.closeQuietly({
          message: 'Codex joined this message to a reply already running. Send it again.',
          code: 'turn_joined',
        });
        return;
      }
      turn.turnId = turnId;
      sink.turnId = turnId;
      channel.flush();
      yield* queue.drain();
    } finally {
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
    turn.interrupting ??= this.sendInterrupt(turn);
    return turn.interrupting;
  }

  private async sendInterrupt(turn: OpenTurn): Promise<InterruptReceipt> {
    const deadline = Date.now() + this.stopAckMs;
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
    const unsubscribe = process.client.subscribeProcess((notification) =>
      this.onProcessNotification(process, notification)
    );
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
      channel = new ThreadChannel(process, threadId, (notification) => {
        if (notification.method === 'thread/closed') {
          // Codex unloaded it after its idle window: forget it, revoke its key.
          this.loader.dropThread(process, threadId);
          this.disposeChannel(process, threadId);
        }
      });
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
      interrupting: undefined,
    };
    this.openByThread.set(threadId, turn);
    this.openBySession.set(sessionId, turn);
    return turn;
  }

  private isKnownOpenTurn(turnId: string, mine: OpenTurn): boolean {
    for (const turn of this.openByThread.values()) {
      if (turn !== mine && turn.turnId === turnId) return true;
    }
    return false;
  }

  private closeTurn(turn: OpenTurn): void {
    if (this.openByThread.get(turn.threadId) === turn) this.openByThread.delete(turn.threadId);
    if (this.openBySession.get(turn.sessionId) === turn) this.openBySession.delete(turn.sessionId);
    turn.markCompleted('closed');
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
      approvalPolicy: 'never',
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

  private *failedStart(mapper: AppServerTurnMapper, err: unknown): Generator<StreamEvent> {
    if (err instanceof CodexProcessExitedError) {
      yield* mapper.closeOnCrash(err.detail);
      return;
    }
    yield* mapper.closeQuietly({
      message: 'Codex could not start this reply. Send your message again to retry.',
      code: 'codex_unavailable',
    });
    logger.warn('[CodexAppServer] turn/start failed', { err: String(err) });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export { sandboxPolicyFor };

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
