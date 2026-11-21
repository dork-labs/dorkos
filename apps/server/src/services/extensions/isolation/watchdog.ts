/**
 * The isolated child's watchdog (DOR-4785): a ping on an interval, and a kill
 * when the child stays silent past the pong timeout.
 *
 * ## Only the child's silence counts, never DorkOS's own
 *
 * The watchdog runs on DorkOS's own event loop. When that loop stalls (a long
 * synchronous job, a busy machine), no ping goes out and no pong is read, and
 * the first tick after the stall used to see a stale pong time and kill a
 * healthy child as unresponsive. People and Flow were killed that way about 90
 * times in a day, then left off.
 *
 * So two rules:
 *
 * - **A late tick is DorkOS being busy, not the child.** Every tick measures
 *   how late it ran; that time is credited back, so the clock only counts time
 *   the host was awake to hear an answer.
 * - **Read before judging.** Node runs timers before it reads pending I/O, so
 *   the verdict waits for an immediate: a pong already in the pipe is read
 *   first.
 *
 * A child that is really stuck still goes silent while the host is awake, and
 * is killed after the same timeout as before.
 *
 * @module services/extensions/isolation/watchdog
 */

/** What {@link startWatchdog} needs. */
export interface WatchdogOptions {
  /** How often to ping. */
  pingIntervalMs: number;
  /** Silence, while DorkOS was awake, that counts as a hung child. */
  pongTimeoutMs: number;
  /** Send one ping. */
  ping: () => void;
  /** The child stayed silent past the timeout. Called once; the watchdog stops. */
  onSilent: () => void;
  /** DorkOS's own loop ran late by `ms` (more than one interval); not held against the child. */
  onHostStall?: (ms: number) => void;
  /** The clock (tests). */
  now?: () => number;
}

/** A running watchdog. */
export interface Watchdog {
  /** The child answered. */
  pong(): void;
  /** Stop pinging; a verdict still waiting is dropped. */
  stop(): void;
}

/**
 * Start pinging a child.
 *
 * @param options - See {@link WatchdogOptions}.
 * @returns The handle the host feeds pongs to and stops.
 */
export function startWatchdog(options: WatchdogOptions): Watchdog {
  const now = options.now ?? Date.now;
  let lastPongAt = now();
  let lastTickAt = lastPongAt;
  let creditedUntil = lastPongAt;
  let stopped = false;

  const creditHostLag = (since: number, t: number): void => {
    const late = t - Math.max(since, creditedUntil);
    if (late <= 0) return;
    lastPongAt = Math.min(t, lastPongAt + late);
    creditedUntil = t;
    if (late > options.pingIntervalMs) options.onHostStall?.(late);
  };

  const judge = (queuedAt: number): void => {
    if (stopped) return;
    // The host can stall after its timer fired, too. Credit that delay once,
    // even if another overdue timer already accounted for some of it.
    creditHostLag(queuedAt, now());
    if (now() - lastPongAt > options.pongTimeoutMs) {
      stop();
      options.onSilent();
      return;
    }
    options.ping();
  };

  const timer = setInterval(() => {
    const t = now();
    creditHostLag(lastTickAt + options.pingIntervalMs, t);
    lastTickAt = t;
    setImmediate(() => judge(t));
  }, options.pingIntervalMs);
  timer.unref();

  function stop(): void {
    stopped = true;
    clearInterval(timer);
  }

  return {
    pong: () => {
      lastPongAt = now();
    },
    stop,
  };
}

/** Start the host watchdog with its existing extension diagnostics. */
export function startLoggedWatchdog(
  extensionId: string,
  logger: { info(message: string): void; warn(message: string): void },
  options: Omit<WatchdogOptions, 'onHostStall'>
): Watchdog {
  return startWatchdog({
    ...options,
    onSilent: () => {
      logger.warn(`[Extensions] ${extensionId}: stopped responding, stopping it`);
      options.onSilent();
    },
    onHostStall: (ms) =>
      logger.info(`[Extensions] ${extensionId}: DorkOS was busy ${ms} ms; not held against it`),
  });
}

/**
 * A startup deadline measured while the host can read the child's reply.
 * Reuse the watchdog's stall credit and deferred verdict, without sending pings.
 * The deadline is checked at most 100 ms after its awake-time budget expires.
 */
export function startStartupDeadline(timeoutMs: number, onTimeout: () => void): Watchdog {
  return startWatchdog({
    pingIntervalMs: Math.min(100, timeoutMs / 4),
    pongTimeoutMs: timeoutMs,
    ping: () => undefined,
    onSilent: onTimeout,
  });
}
