/**
 * `SignInRefresher` — keeps every kept account's sign-in status current.
 *
 * A sign-in can end at the service (a password change, access removed in the
 * person's Google account, a token that could not be renewed) without DorkOS
 * taking part. Nothing about that reaches DorkOS unless it asks, so this asks:
 * every {@link SIGN_IN_REFRESH_INTERVAL_MS}, and when someone opens the
 * Connections page or an account's panel (at most once per
 * {@link SIGN_IN_REFRESH_MIN_GAP_MS}), it lists each way's accounts through
 * {@link ConnectorRegistry.refreshSignIns} and records what the service says.
 *
 * A listing is one cheap read per way, never an app list or an action list,
 * so nothing kept for a way is read or dropped here. A listing that fails
 * leaves its accounts as they were (an outage is not a sign-in that ended) and
 * hands the way to {@link ConnectorProviderBootstrapper.recheckWay}, which
 * checks it again and takes it down only if it still does not answer.
 *
 * Only the sign-in status and when it was checked change. Closing or removing
 * an account the service no longer lists is not this module's job.
 *
 * @module services/connectors/resources/sign-in-refresh
 */
import { logger } from '../../../lib/logger.js';
import type { ConnectorProviderBootstrapper } from '../bootstrap.js';
import type { ConnectorRegistry } from '../registry.js';

/** How often every way's accounts are listed while nobody is looking. */
export const SIGN_IN_REFRESH_INTERVAL_MS = 15 * 60_000;

/** The least time between two refreshes someone opening a page asks for. */
export const SIGN_IN_REFRESH_MIN_GAP_MS = 60_000;

/**
 * The longest a page read waits for the refresh it asked for before answering
 * with what is recorded; the refresh still finishes and the next read shows it.
 */
export const SIGN_IN_REFRESH_WAIT_MS = 1_500;

/** Construction options for {@link SignInRefresher}. */
export interface SignInRefresherOptions {
  /** Lists every way's accounts and records their sign-in status. */
  registry: Pick<ConnectorRegistry, 'refreshSignIns'>;
  /** Checks again a way whose listing failed. */
  ways: Pick<ConnectorProviderBootstrapper, 'recheckWay'>;
  /** Override {@link SIGN_IN_REFRESH_INTERVAL_MS}. */
  intervalMs?: number;
  /** Override {@link SIGN_IN_REFRESH_MIN_GAP_MS}. */
  minGapMs?: number;
  /** Clock in milliseconds; tests pin it. */
  now?: () => number;
}

/** Periodic and on-demand sign-in refresh; see the module docs. */
export class SignInRefresher {
  private readonly _registry: SignInRefresherOptions['registry'];
  private readonly _ways: SignInRefresherOptions['ways'];
  private readonly _intervalMs: number;
  private readonly _minGapMs: number;
  private readonly _now: () => number;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _inFlight: Promise<void> | undefined;
  private _lastStartedAt = Number.NEGATIVE_INFINITY;

  /**
   * Construct the refresher; nothing runs until {@link start} or a refresh.
   *
   * @param opts - The registry, the way re-check, and optional timing overrides.
   */
  constructor(opts: SignInRefresherOptions) {
    this._registry = opts.registry;
    this._ways = opts.ways;
    this._intervalMs = opts.intervalMs ?? SIGN_IN_REFRESH_INTERVAL_MS;
    this._minGapMs = opts.minGapMs ?? SIGN_IN_REFRESH_MIN_GAP_MS;
    this._now = opts.now ?? Date.now;
  }

  /** Refresh every {@link SIGN_IN_REFRESH_INTERVAL_MS} until {@link stop}. Idempotent. */
  start(): void {
    if (this._timer) return;
    this._timer = setInterval(() => void this.refresh(), this._intervalMs);
    this._timer.unref();
  }

  /** Stop the periodic refresh. A refresh already running finishes. */
  stop(): void {
    if (this._timer) clearInterval(this._timer);
    this._timer = undefined;
  }

  /** Refresh now, or join the refresh already running. Never rejects. */
  refresh(): Promise<void> {
    if (this._inFlight) return this._inFlight;
    this._lastStartedAt = this._now();
    const run = this._run().finally(() => {
      this._inFlight = undefined;
    });
    this._inFlight = run;
    return run;
  }

  /**
   * Refresh because someone opened a page that shows sign-ins: join a refresh
   * already running, or start one unless the last began within
   * {@link SIGN_IN_REFRESH_MIN_GAP_MS}, and wait for it at most `maxWaitMs`.
   *
   * @param maxWaitMs - The longest to wait before answering with what is recorded.
   */
  async refreshOnDemand(maxWaitMs = SIGN_IN_REFRESH_WAIT_MS): Promise<void> {
    const pending =
      this._inFlight ??
      (this._now() - this._lastStartedAt >= this._minGapMs ? this.refresh() : undefined);
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxWaitMs);
      timer.unref();
    });
    await Promise.race([pending, waited]);
    clearTimeout(timer);
  }

  private async _run(): Promise<void> {
    try {
      const { changes, failures } = await this._registry.refreshSignIns();
      for (const change of changes) {
        logger.info('[Connectors] Sign-in status changed at the service', {
          connectionId: change.connectionId,
          from: change.from,
          to: change.to,
        });
      }
      await Promise.all(
        failures.map((failure) => {
          logger.warn('[Connectors] Could not list accounts to refresh sign-ins', {
            provider: failure.provider,
            message: failure.message,
          });
          return this._ways.recheckWay(failure.providerInstanceId);
        })
      );
    } catch (err) {
      // The connection store may be unavailable after a failed migration; the
      // next refresh tries again.
      logger.warn('[Connectors] Sign-in refresh failed', { err: String(err) });
    }
  }
}
