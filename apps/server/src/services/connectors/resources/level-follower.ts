/**
 * `LevelFollower` — keeps every access level current with its app without
 * anyone opening "Who can use it?" (ADR 260929-071355).
 *
 * A level ("Read", "Read and write") follows the app's catalog, and DorkOS
 * only learns the catalog by reading it. This reads it on its own, so that
 * while the server runs no level goes longer than
 * {@link LEVEL_FOLLOW_INTERVAL_MS} without being followed. It looks at boot and
 * then every {@link LEVEL_FOLLOW_TICK_MS}, and each pass reads only the
 * connections not followed within the last interval less one tick; so a
 * restart never pushes a connection's next read past the interval. Each connection with a
 * level on it goes through {@link ConnectorReconciliationService.followCatalog},
 * the same path a preview takes, so a DorkOS account's grants still change
 * close-first and never widen before hosted authority applies them.
 *
 * A follow under an earlier DorkOS version never counts as recent, so the
 * first pass after an update reads every app: a new version can classify
 * actions differently.
 *
 * A pass is bounded: at most {@link LEVEL_FOLLOW_MAX_CONNECTIONS} connections,
 * one at a time, each with its own {@link LEVEL_FOLLOW_TIMEOUT_MS}. One app
 * that fails is logged and the pass goes on to the next.
 *
 * @module services/connectors/resources/level-follower
 */
import { logger } from '../../../lib/logger.js';
import type { ConnectorReconciliationService } from '../reconciliation-service.js';

/** The longest any level goes without being checked against its app while the server runs. */
export const LEVEL_FOLLOW_INTERVAL_MS = 12 * 60 * 60_000;

/** How often the follower looks for connections that are due. */
export const LEVEL_FOLLOW_TICK_MS = 60 * 60_000;

/** The longest one app's catalog read may take before the pass moves on. */
export const LEVEL_FOLLOW_TIMEOUT_MS = 60_000;

/** The most connections one pass reads; the rest wait for the next pass. */
export const LEVEL_FOLLOW_MAX_CONNECTIONS = 200;

/** Construction options for {@link LevelFollower}. */
export interface LevelFollowerOptions {
  /** Lists the connections with a level and follows one connection's catalog. */
  reconciliation: Pick<
    ConnectorReconciliationService,
    'levelConnectionIds' | 'followCatalog' | 'followedSince'
  >;
  /** The running DorkOS version, stamped on every follow. */
  appVersion: string;
  /** Clock in milliseconds; tests pin it. */
  now?: () => number;
  /** Override {@link LEVEL_FOLLOW_INTERVAL_MS}. */
  intervalMs?: number;
  /** Override {@link LEVEL_FOLLOW_TICK_MS}. */
  tickMs?: number;
  /** Override {@link LEVEL_FOLLOW_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Override {@link LEVEL_FOLLOW_MAX_CONNECTIONS}. */
  maxConnections?: number;
}

/** Boot-time and periodic level following; see the module docs. */
export class LevelFollower {
  private readonly _reconciliation: LevelFollowerOptions['reconciliation'];
  private readonly _intervalMs: number;
  private readonly _tickMs: number;
  private readonly _timeoutMs: number;
  private readonly _maxConnections: number;
  private readonly _appVersion: string;
  private readonly _now: () => number;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _inFlight: Promise<void> | undefined;

  /**
   * Construct the follower; nothing runs until {@link start} or {@link follow}.
   *
   * @param opts - The reconciliation service and optional bounds.
   */
  constructor(opts: LevelFollowerOptions) {
    this._reconciliation = opts.reconciliation;
    this._intervalMs = opts.intervalMs ?? LEVEL_FOLLOW_INTERVAL_MS;
    this._tickMs = opts.tickMs ?? LEVEL_FOLLOW_TICK_MS;
    this._timeoutMs = opts.timeoutMs ?? LEVEL_FOLLOW_TIMEOUT_MS;
    this._maxConnections = opts.maxConnections ?? LEVEL_FOLLOW_MAX_CONNECTIONS;
    this._appVersion = opts.appVersion;
    this._now = opts.now ?? Date.now;
  }

  /** Look for due connections now (the boot pass), then every tick until {@link stop}. Idempotent. */
  start(): void {
    if (this._timer) return;
    void this.follow();
    this._timer = setInterval(() => void this.follow(), this._tickMs);
    this._timer.unref();
  }

  /** Stop the periodic pass. A pass already running finishes. */
  stop(): void {
    if (this._timer) clearInterval(this._timer);
    this._timer = undefined;
  }

  /** Run one pass over the due connections now, or join the pass already running. Never rejects. */
  follow(): Promise<void> {
    if (this._inFlight) return this._inFlight;
    const run = this._run().finally(() => {
      this._inFlight = undefined;
    });
    this._inFlight = run;
    return run;
  }

  private async _run(): Promise<void> {
    // Due: not followed since one tick short of the interval, under this
    // version. Hourly passes then reach every connection within the interval.
    const since = new Date(this._now() - (this._intervalMs - this._tickMs)).toISOString();
    let connectionIds: string[];
    try {
      connectionIds = this._reconciliation
        .levelConnectionIds()
        .filter(
          (connectionId) =>
            !this._reconciliation.followedSince(connectionId, since, this._appVersion)
        );
    } catch (err) {
      logger.warn('[Connectors] Could not list the apps whose access levels follow them', {
        err: String(err),
      });
      return;
    }
    if (connectionIds.length > this._maxConnections) {
      // The rest are still due at the next tick.
      logger.warn('[Connectors] Following access levels for some apps only this time', {
        count: connectionIds.length,
        max: this._maxConnections,
      });
    }
    for (const connectionId of connectionIds.slice(0, this._maxConnections)) {
      try {
        await this._reconciliation.followCatalog(
          connectionId,
          AbortSignal.timeout(this._timeoutMs),
          this._appVersion
        );
      } catch (err) {
        logger.warn('[Connectors] Could not check an app for its access levels', {
          connectionId,
          err: String(err),
        });
      }
    }
  }
}
