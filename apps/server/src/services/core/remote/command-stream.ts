/**
 * The managed remote access command stream (DOR-2086): this computer's own
 * reader for the instance-authenticated `GET /v1/remote/commands`
 * server-sent events stream.
 *
 * Its own transport on purpose. The JSON `CloudApiClient` does not read event
 * streams, and the pinned-host SSE helper the relay uses answers a different
 * question. This one knows exactly one stream and keeps it honest:
 *
 * - **Strict.** Framing goes through `sse-parser.ts`; every event's data must
 *   parse as JSON and then against the published `RemoteCommandSchema`. An
 *   event that does not is ignored and logged by its kind alone — never its
 *   body, which carries a lease token.
 * - **Reconnects on its own terms.** A clean end, or the proactive reconnect
 *   before the {@link COMMAND_LEASE_MS} lease runs out, waits the server's
 *   `retry:` (or a keepalive's `reconnectAfterMs`), bounded to
 *   [{@link MIN_RETRY_MS}, {@link MAX_RETRY_MS}], with full jitter around it
 *   (a draw in twice that wait, floored at {@link MIN_BACKOFF_MS} and capped at
 *   {@link MAX_RETRY_MS}), so a fleet a deploy dropped does not reconnect in
 *   lockstep. A failure backs off
 *   exponentially, capped at {@link MAX_BACKOFF_MS}, with full jitter.
 * - **Watches for silence.** Cloud sends a keepalive every
 *   {@link KEEPALIVE_INTERVAL_MS}; two intervals without a byte means the
 *   connection is dead even if the socket has not said so, and it reconnects.
 * - **Stops when told, and when it no longer belongs.** {@link CommandStream.stop}
 *   cancels the connection and any wait at once; before every connection it
 *   asks `shouldRun()` (the link is still current, the enrolment still active),
 *   and stops for good when the answer is no or Cloud answers `404`.
 *
 * A dropped stream is not proof the managed listener closed, and nothing here
 * touches the listener: it only delivers commands.
 *
 * @module services/core/remote/command-stream
 */
import { RemoteCommandSchema, type RemoteCommand } from '@dork-labs/cloud-api';

import { logger } from '../../../lib/logger.js';
import { SseParser } from './sse-parser.js';
import { abortableSleep, errorName } from './managed-remote-support.js';

/** How long Cloud holds one command stream's lease. */
export const COMMAND_LEASE_MS = 900_000;
/** How long before the lease ends the stream is renewed, at least. */
export const LEASE_MARGIN_MS = 60_000;
/** Extra random lead on the proactive reconnect, so many computers do not renew together. */
export const LEASE_JITTER_MS = 30_000;
/** How often Cloud sends a keepalive. */
export const KEEPALIVE_INTERVAL_MS = 20_000;
/** Silence this long ends the connection: two missed keepalives. */
export const KEEPALIVE_WATCHDOG_MS = 2 * KEEPALIVE_INTERVAL_MS;
/** The wait before reconnecting when the server named none. */
export const DEFAULT_RETRY_MS = 5_000;
/** The shortest reconnect wait a server may ask for. */
export const MIN_RETRY_MS = 1_000;
/** The longest reconnect wait a server may ask for. */
export const MAX_RETRY_MS = 60_000;
/** The ceiling of the failure backoff. */
export const MAX_BACKOFF_MS = 5 * 60_000;
/** The floor under a jittered failure wait, so a zero draw never hammers. */
export const MIN_BACKOFF_MS = 500;

/** How one connection ended. */
type ConnectionEnd =
  /** Ended cleanly, or renewed before its lease: reconnect after the server's retry. */
  | 'ended'
  /** Refused, dropped, malformed or silent: back off. */
  | 'failed'
  /** Cloud does not serve the route here: stop for good. */
  | 'absent'
  /** {@link CommandStream.stop} was called. */
  | 'stopped';

/** Timers, injectable for tests. */
export interface StreamTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** What the stream needs. */
export interface CommandStreamDeps {
  /**
   * Open the stream: an instance-authenticated `GET /v1/remote/commands`
   * asking for `text/event-stream`, aborted by `signal`.
   */
  open: (signal: AbortSignal) => Promise<Response>;
  /** Called for each leased command, in order. Keepalives never reach it. */
  onCommand: (command: Exclude<RemoteCommand, { kind: 'keepalive' }>) => void;
  /** Asked before every connection; `false` stops the stream for good. */
  shouldRun: () => boolean;
  /** Called once when Cloud answers `404`: the route is not here. */
  onAbsent?: () => void;
  /** Called after each connection that Cloud accepted. */
  onConnected?: () => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  timers?: StreamTimers;
}

const DEFAULT_TIMERS: StreamTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function clampRetry(ms: number): number {
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, ms));
}

/** The kind of a parsed body, for a log line; never anything else from it. */
function kindOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return typeof value;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind.slice(0, 32) : 'unknown';
}

/** One command stream. Started once, stopped once; build a new one to start again. */
export class CommandStream {
  private readonly stopController = new AbortController();
  private connection: AbortController | null = null;
  private retryMs = DEFAULT_RETRY_MS;
  private failures = 0;
  private running: Promise<void> | null = null;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly timers: StreamTimers;

  /**
   * Build the stream. Nothing connects until {@link start}.
   *
   * @param deps - The opener, the command sink and the run condition.
   */
  constructor(private readonly deps: CommandStreamDeps) {
    this.sleep = deps.sleep ?? abortableSleep;
    this.random = deps.random ?? Math.random;
    this.timers = deps.timers ?? DEFAULT_TIMERS;
  }

  /** Whether {@link stop} has been called. */
  get stopped(): boolean {
    return this.stopController.signal.aborted;
  }

  /** The reconnect wait the server asked for, bounded. */
  get reconnectAfterMs(): number {
    return this.retryMs;
  }

  /**
   * Start reading. Resolves when the stream stops for good; never rejects.
   * Calling it again returns the same run.
   */
  start(): Promise<void> {
    this.running ??= this.run();
    return this.running;
  }

  /** Stop at once: cancel the connection and any wait. Safe to call twice. */
  stop(): void {
    if (this.stopped) return;
    this.stopController.abort();
    this.connection?.abort();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      if (!this.deps.shouldRun()) break;
      const end = await this.connectOnce();
      if (end === 'stopped' || this.stopped) break;
      if (end === 'absent') {
        this.deps.onAbsent?.();
        break;
      }
      if (end === 'failed') this.failures += 1;
      await this.sleep(this.delay(), this.stopController.signal);
    }
    this.stop();
  }

  /** The wait before the next connection. See the module doc. */
  private delay(): number {
    if (this.failures === 0) {
      // Full jitter around the server's wait (mean `retryMs`), so computers a
      // Cloud deploy disconnected together do not all come back together.
      const jittered = Math.floor(this.random() * 2 * this.retryMs);
      return Math.min(MAX_RETRY_MS, Math.max(MIN_BACKOFF_MS, jittered));
    }
    const ceiling = Math.min(MAX_BACKOFF_MS, this.retryMs * 2 ** (this.failures - 1));
    return Math.max(MIN_BACKOFF_MS, Math.floor(this.random() * ceiling));
  }

  private async connectOnce(): Promise<ConnectionEnd> {
    const controller = new AbortController();
    this.connection = controller;
    if (this.stopped) return 'stopped';
    let response: Response;
    try {
      response = await this.deps.open(controller.signal);
    } catch (error) {
      if (this.stopped) return 'stopped';
      logger.warn('[RemoteAccess] Command stream did not connect', { error: errorName(error) });
      return 'failed';
    }
    if (this.stopped) {
      await response.body?.cancel().catch(() => undefined);
      return 'stopped';
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return 'absent';
    }
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !response.body || !type.toLowerCase().startsWith('text/event-stream')) {
      await response.body?.cancel().catch(() => undefined);
      logger.warn('[RemoteAccess] Command stream refused', { status: response.status });
      return 'failed';
    }
    this.failures = 0;
    this.deps.onConnected?.();
    return this.read(response.body, controller);
  }

  /** Read one accepted connection until it ends, renews, goes silent or is stopped. */
  private async read(
    body: ReadableStream<Uint8Array>,
    controller: AbortController
  ): Promise<ConnectionEnd> {
    const reader = body.getReader();
    let why: 'silent' | 'renew' | null = null;
    const end = (reason: 'silent' | 'renew') => {
      why ??= reason;
      controller.abort();
      void reader.cancel().catch(() => undefined);
    };
    const renewAt =
      COMMAND_LEASE_MS - LEASE_MARGIN_MS - Math.floor(this.random() * LEASE_JITTER_MS);
    const renew = this.timers.setTimeout(() => end('renew'), renewAt);
    let watchdog = this.timers.setTimeout(() => end('silent'), KEEPALIVE_WATCHDOG_MS);
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const onStop = () => void reader.cancel().catch(() => undefined);
    this.stopController.signal.addEventListener('abort', onStop, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (this.stopped) return 'stopped';
        if (why !== null) break;
        if (done) return 'ended';
        this.timers.clearTimeout(watchdog);
        watchdog = this.timers.setTimeout(() => end('silent'), KEEPALIVE_WATCHDOG_MS);
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          this.deliver(event.data);
        }
        if (parser.retryMs !== undefined) this.retryMs = clampRetry(parser.retryMs);
      }
    } catch (error) {
      if (this.stopped) return 'stopped';
      if (why === null) {
        logger.warn('[RemoteAccess] Command stream dropped', { error: errorName(error) });
        return 'failed';
      }
    } finally {
      this.timers.clearTimeout(renew);
      this.timers.clearTimeout(watchdog);
      this.stopController.signal.removeEventListener('abort', onStop);
    }
    if (why === 'silent') {
      logger.warn('[RemoteAccess] Command stream went silent; reconnecting');
      return 'failed';
    }
    return 'ended';
  }

  /** Parse one event's data strictly and hand a leased command on. */
  private deliver(data: string): void {
    let body: unknown;
    try {
      body = JSON.parse(data);
    } catch {
      logger.warn('[RemoteAccess] Ignored a command event that is not JSON');
      return;
    }
    const parsed = RemoteCommandSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn('[RemoteAccess] Ignored a command this build cannot read', {
        kind: kindOf(body),
      });
      return;
    }
    const command = parsed.data;
    if (command.kind === 'keepalive') {
      if (command.reconnectAfterMs !== undefined) {
        this.retryMs = clampRetry(command.reconnectAfterMs);
      }
      return;
    }
    this.deps.onCommand(command);
  }
}
