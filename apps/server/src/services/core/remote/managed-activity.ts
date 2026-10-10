/**
 * What crosses managed remote access while it is open, and closing it when
 * nobody uses it (DOR-2086).
 *
 * ## One window per open
 *
 * A Cloud `open` that this computer applied starts a window
 * ({@link ManagedActivity.opened}): when it opened, the wake it answered, and
 * the idle and drain windows Cloud gave with it. An `open` repeated while the
 * session is still up keeps the same span and takes the newer windows and the
 * newer wake. The
 * window ends when the managed session does, for any reason (`managed_closed`
 * from `TunnelManager`), and its close report is written to the durable outbox
 * then: the span from `openedAt` to `at`, the reason, the wake, and the
 * requests that crossed it. Bytes are not measured here, so none are reported.
 * While a window is open, a running count goes out on a jittered beat when it
 * has moved.
 *
 * ## What counts
 *
 * A request counts once the managed ingress admitted it (the edge proof and
 * host checks passed) AND, for the API and MCP, the local session gate let it
 * through; a page or asset, which the gate never sees, counts at the ingress
 * (`ingress-mark.ts` → {@link ManagedActivity.admitted}). A WebSocket counts
 * once the upgrade router accepted it, after its origin and credential checks
 * ({@link ManagedActivity.upgraded}). A refused attempt never counts.
 *
 * ## Idle close
 *
 * Only with a window Cloud supplied (`idleWindowSeconds`; absent or zero means
 * no idle close). Every counted request is activity, at its start and at its
 * end, except a long-lived event stream (`Accept: text/event-stream`), which an
 * open tab holds on its own. An accepted WebSocket is activity when it opens
 * and each time its client sends something (a keystroke in the terminal), but
 * not merely for staying open. Once the window passes with
 * no activity, managed access closes gently, under the drain deadline Cloud
 * gave with the open (or the bounded local default), reason `idle`. The timer
 * belongs to the window: it is cancelled when the session ends for any reason
 * (a mode change, withdrawal, a Cloud close, shutdown).
 *
 * @module services/core/remote/managed-activity
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { logger } from '../../../lib/logger.js';
import { scheduleJittered, type JitteredSchedule } from '../../../lib/jittered-schedule.js';
import type { RemoteEventBatch } from './activity-outbox.js';
import type { AdmittedSocket } from './ingress-mark.js';
import { MAX_DRAIN_DEADLINE_MS } from './command-dispatcher.js';
import type {
  ManagedClosedEvent,
  ManagedCloseOptions,
  ManagedPhase,
} from './managed-forwarding.js';
import { errorName } from './managed-remote-support.js';

/** How often, on average, a running count goes out while a window is open. */
export const ACTIVITY_REPORT_INTERVAL_MS = 5 * 60_000;

/** What an applied Cloud `open` tells the activity window. */
export interface OpenedWindow {
  /** The Cloud instance id of the link the open arrived on. */
  instanceId: string;
  /** The wake the open answered. */
  wakeId: string | null;
  /** How long it may sit idle before it closes itself, from Cloud. */
  idleWindowSeconds?: number;
  /** How long a close lets admitted requests finish, from Cloud. */
  drainDeadlineSeconds?: number;
}

/** The tunnel, as far as the activity window uses it. */
export interface ActivityTunnel {
  getManagedPhase(): ManagedPhase | null;
  closeManaged(options: ManagedCloseOptions): Promise<void>;
  on(event: 'managed_closed', listener: (event: ManagedClosedEvent) => void): unknown;
}

/** What the activity window touches, injectable for tests. */
export interface ManagedActivityDeps {
  tunnel: ActivityTunnel;
  /** Persist a batch to the outbox and hand it to the sender. */
  report: (batch: RemoteEventBatch) => void;
  now?: () => number;
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  /** The jitter source for the running count's beat. */
  random?: () => number;
}

interface Window {
  instanceId: string;
  wakeId: string | null;
  openedAt: number;
  idleMs: number | null;
  drainDeadlineMs: number | undefined;
  requests: number;
  reported: number;
  lastActivity: number;
  idleTimer: unknown;
  beat: JitteredSchedule;
}

/**
 * Whether a request asks for a long-lived event stream, which an open tab
 * holds on its own. Counted as usage, but never as activity that keeps managed
 * access open.
 *
 * @param req - The admitted request.
 */
export function isLongLivedStream(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  const values = Array.isArray(accept) ? accept : [accept ?? ''];
  return values.some((value) => value.toLowerCase().includes('text/event-stream'));
}

/** The activity window and idle close. One per process: `managedActivity`. */
export class ManagedActivity {
  private window: Window | null = null;
  private listening = false;
  private readonly now: () => number;
  private readonly timers: NonNullable<ManagedActivityDeps['timers']>;

  /**
   * Build it. It listens for the end of managed sessions from the first open.
   *
   * @param deps - The tunnel, where batches go, and the clock seams.
   */
  constructor(private readonly deps: ManagedActivityDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? {
      setTimeout: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      },
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  /** The drain deadline the open window's Cloud `open` named, in ms; `undefined` when none. */
  get drainDeadlineMs(): number | undefined {
    return this.window?.drainDeadlineMs;
  }

  /** Requests counted in the open window, or `null` when none is open. */
  get requests(): number | null {
    return this.window?.requests ?? null;
  }

  /**
   * A Cloud `open` was applied: start a window, or refresh the open one.
   *
   * @param info - The open's link, wake and windows.
   */
  opened(info: OpenedWindow): void {
    if (!this.listening) {
      this.listening = true;
      this.deps.tunnel.on('managed_closed', (event) => this.closed(event));
    }
    const idleMs = info.idleWindowSeconds ? info.idleWindowSeconds * 1000 : null;
    const drainDeadlineMs =
      info.drainDeadlineSeconds === undefined
        ? undefined
        : Math.min(MAX_DRAIN_DEADLINE_MS, info.drainDeadlineSeconds * 1000);
    const current = this.window;
    if (current && current.instanceId === info.instanceId) {
      current.wakeId = info.wakeId;
      current.idleMs = idleMs;
      current.drainDeadlineMs = drainDeadlineMs;
      current.lastActivity = this.now();
      this.armIdle(current);
      return;
    }
    // Another link's window: its span still gets a report.
    if (current) this.closed({ generation: -1, reason: 'replaced', at: this.isoNow() });
    const window: Window = {
      instanceId: info.instanceId,
      wakeId: info.wakeId,
      openedAt: this.now(),
      idleMs,
      drainDeadlineMs,
      requests: 0,
      reported: 0,
      lastActivity: this.now(),
      idleTimer: null,
      beat: scheduleJittered(() => this.reportRunning(window), ACTIVITY_REPORT_INTERVAL_MS, {
        random: this.deps.random,
        timers: this.deps.timers,
      }),
    };
    this.window = window;
    this.armIdle(window);
  }

  /**
   * A managed request that was admitted. Counted; and unless it is a
   * long-lived event stream, activity, at its start and again when it ends.
   *
   * @param req - The request.
   * @param res - Its response.
   */
  admitted(req: IncomingMessage, res: ServerResponse): void {
    const window = this.window;
    if (!window) return;
    window.requests += 1;
    if (isLongLivedStream(req)) return;
    window.lastActivity = this.now();
    res.once('close', () => {
      if (this.window === window) window.lastActivity = this.now();
    });
  }

  /**
   * A managed WebSocket the upgrade router accepted. Counted, activity now, and
   * activity again each time its client sends something.
   *
   * @param _req - The upgrade request.
   * @param socket - The accepted socket.
   */
  upgraded(_req: IncomingMessage, socket: AdmittedSocket): void {
    const window = this.window;
    if (!window) return;
    window.requests += 1;
    window.lastActivity = this.now();
    socket.on('message', () => {
      if (this.window === window) window.lastActivity = this.now();
    });
  }

  /** Stop the timers without reporting; for shutdown after the session closed. */
  stop(): void {
    const window = this.window;
    this.window = null;
    if (window) this.cancel(window);
  }

  private armIdle(window: Window): void {
    if (window.idleTimer !== null) this.timers.clearTimeout(window.idleTimer);
    window.idleTimer = null;
    if (window.idleMs === null) return;
    const wait = Math.max(1_000, window.lastActivity + window.idleMs - this.now());
    window.idleTimer = this.timers.setTimeout(() => {
      window.idleTimer = null;
      this.idleCheck(window);
    }, wait);
  }

  private idleCheck(window: Window): void {
    if (this.window !== window || window.idleMs === null) return;
    // Not open right now (still opening, or a close is under way): look again
    // later; a close that finishes ends the window and cancels this.
    if (this.deps.tunnel.getManagedPhase() !== 'open') return this.armIdle(window);
    if (this.now() - window.lastActivity < window.idleMs) return this.armIdle(window);
    logger.info('[RemoteAccess] Closing managed access after the idle window', {
      idleWindowMs: window.idleMs,
      drainDeadline: window.drainDeadlineMs === undefined ? 'local default' : 'from DorkOS Cloud',
    });
    void this.deps.tunnel
      .closeManaged({ immediate: false, drainDeadlineMs: window.drainDeadlineMs, reason: 'idle' })
      .catch((error: unknown) => {
        logger.warn('[RemoteAccess] Idle close failed', { error: errorName(error) });
      });
  }

  private reportRunning(window: Window): void {
    if (this.window !== window || window.requests === window.reported) return;
    window.reported = window.requests;
    this.send({
      instanceId: window.instanceId,
      activity: [{ at: this.isoNow(), requests: window.requests }],
      closeReports: [],
    });
  }

  private closed(event: ManagedClosedEvent): void {
    const window = this.window;
    if (!window) return;
    this.window = null;
    this.cancel(window);
    this.send({
      instanceId: window.instanceId,
      activity: [{ at: event.at, requests: window.requests }],
      closeReports: [
        {
          at: event.at,
          reason: event.reason,
          wakeId: window.wakeId,
          openedAt: new Date(window.openedAt).toISOString(),
          requests: window.requests,
        },
      ],
    });
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private cancel(window: Window): void {
    window.beat.stop();
    if (window.idleTimer !== null) this.timers.clearTimeout(window.idleTimer);
    window.idleTimer = null;
  }

  private send(batch: RemoteEventBatch): void {
    try {
      this.deps.report(batch);
    } catch (error) {
      logger.warn('[RemoteAccess] Could not record activity', { error: errorName(error) });
    }
  }
}
