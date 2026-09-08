/** Process-owned supervision for one renewable Connections runtime-turn lease. */
import type {
  ConnectorRuntime,
  ConnectorRuntimePrincipalPort,
  ConnectorTurnRenewalPermit,
} from '../../connectors/runtime-principal-port.js';

const RENEWAL_MARGIN_MS = 3 * 60 * 60 * 1_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Timer handle used by the injectable one-shot scheduler. */
export interface ConnectorLeaseTimer {
  /** Keep the timer from holding an otherwise idle server process open. */
  unref?: () => void;
}

/** One-shot timer seams for deterministic lifecycle tests. */
export interface ConnectorLeaseScheduler {
  /** Schedule exactly one callback. */
  set(callback: () => void, delayMs: number): ConnectorLeaseTimer;
  /** Cancel a scheduled callback. */
  clear(timer: ConnectorLeaseTimer): void;
}

/** Safe terminal state emitted once when renewal authority is lost. */
export interface ConnectorLeaseLoss {
  /** Durable binding identifier; never the bearer or permit. */
  readonly bindingId: string;
  /** Runtime whose exact turn lost renewal authority. */
  readonly runtime: ConnectorRuntime;
  /** Secret-free terminal reason. */
  readonly reason: string;
  /** Last durable expiry observed before the supervisor closed. */
  readonly expiresAt: string;
  /** ISO timestamp at which the supervisor closed. */
  readonly at: string;
}

/** Construction inputs for one exact runtime-turn lease supervisor. */
export interface ConnectorTurnLeaseSupervisorOptions {
  /** Internal principal service. */
  readonly principals: ConnectorRuntimePrincipalPort;
  /** Durable binding identifier. */
  readonly bindingId: string;
  /** Exact process-local permit returned at open. */
  readonly permit: ConnectorTurnRenewalPermit;
  /** Runtime that owns the turn. */
  readonly runtime: ConnectorRuntime;
  /** Current committed expiry. */
  readonly expiresAt: string;
  /** Turn cancellation signal. */
  readonly signal: AbortSignal;
  /** Injectable clock. */
  readonly now?: () => Date;
  /** Injectable one-shot scheduler. */
  readonly scheduler?: ConnectorLeaseScheduler;
  /** Structured, secret-free terminal warning sink. */
  readonly onLost?: (loss: ConnectorLeaseLoss) => void;
}

/** Observable lifecycle state for one supervisor. */
export type ConnectorTurnLeaseState = 'active' | 'stopped' | 'lost';

/** Minimal runtime-owned handle returned by the supervisor factory seam. */
export interface ConnectorTurnLeaseSupervisorHandle {
  /** Current bounded state. */
  readonly state: ConnectorTurnLeaseState;
  /** Stop future renewals for this turn. */
  stop(): void;
  /** Refuse a Connections call after terminal lease loss. */
  assertUsable(): void;
}

/** Internal factory seam used by runtime lifecycle tests. */
export type ConnectorTurnLeaseSupervisorFactory = (
  options: ConnectorTurnLeaseSupervisorOptions
) => ConnectorTurnLeaseSupervisorHandle;

function defaultScheduler(): ConnectorLeaseScheduler {
  return {
    set(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    clear(timer) {
      clearTimeout(timer as NodeJS.Timeout);
    },
  };
}

/** Renews one unchanged runtime bearer only while its exact turn remains active. */
export class ConnectorTurnLeaseSupervisor implements ConnectorTurnLeaseSupervisorHandle {
  private readonly now: () => Date;
  private readonly scheduler: ConnectorLeaseScheduler;
  private timer?: ConnectorLeaseTimer;
  private retryIndex = 0;
  private expiryMs: number;
  private currentState: ConnectorTurnLeaseState = 'active';
  private loss?: ConnectorLeaseLoss;
  private readonly onAbort = () => this.stop();

  /** Construct and schedule the first hourly renewal callback. */
  constructor(private readonly options: ConnectorTurnLeaseSupervisorOptions) {
    this.now = options.now ?? (() => new Date());
    this.scheduler = options.scheduler ?? defaultScheduler();
    this.expiryMs = Date.parse(options.expiresAt);
    options.signal.addEventListener('abort', this.onAbort, { once: true });
    if (options.signal.aborted) this.stop();
    else this.scheduleNormal();
  }

  /** Current bounded supervisor state. */
  get state(): ConnectorTurnLeaseState {
    return this.currentState;
  }

  /** Secret-free terminal detail, available only after loss. */
  get terminalLoss(): ConnectorLeaseLoss | undefined {
    return this.loss;
  }

  /** Stop timers permanently without reviving or renewing the binding. */
  stop(): void {
    if (this.currentState !== 'active') return;
    this.currentState = 'stopped';
    this.options.signal.removeEventListener('abort', this.onAbort);
    if (this.timer) this.scheduler.clear(this.timer);
    this.timer = undefined;
  }

  /** Throw a safe instruction when the lease was lost during an active turn. */
  assertUsable(): void {
    if (this.currentState === 'lost') {
      throw new Error('Connections access ended. Start a new turn to continue.');
    }
  }

  private scheduleNormal(): void {
    this.schedule(Math.max(0, this.expiryMs - this.now().getTime() - RENEWAL_MARGIN_MS));
  }

  private scheduleRetry(): void {
    const index = Math.min(this.retryIndex, RETRY_DELAYS_MS.length - 1);
    this.retryIndex += 1;
    const delay = RETRY_DELAYS_MS[index];
    if (this.now().getTime() + delay >= this.expiryMs) {
      this.schedule(Math.max(0, this.expiryMs - this.now().getTime()));
      return;
    }
    this.schedule(delay);
  }

  private schedule(delayMs: number): void {
    if (this.currentState !== 'active') return;
    this.timer = this.scheduler.set(
      () => {
        this.timer = undefined;
        void this.tick();
      },
      Math.min(delayMs, MAX_TIMER_DELAY_MS)
    );
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.currentState !== 'active') return;
    if (this.now().getTime() >= this.expiryMs) {
      this.lose('expired');
      return;
    }
    try {
      const result = await this.options.principals.renew({
        bindingId: this.options.bindingId,
        permit: this.options.permit,
      });
      if (this.currentState !== 'active') return;
      if (result.status === 'refused') {
        this.lose(result.reason);
        return;
      }
      this.expiryMs = Date.parse(result.expiresAt);
      this.retryIndex = 0;
      this.scheduleNormal();
    } catch {
      if (this.currentState === 'active') this.scheduleRetry();
    }
  }

  private lose(reason: string): void {
    if (this.currentState !== 'active') return;
    this.currentState = 'lost';
    this.options.signal.removeEventListener('abort', this.onAbort);
    if (this.timer) this.scheduler.clear(this.timer);
    this.timer = undefined;
    this.loss = {
      bindingId: this.options.bindingId,
      runtime: this.options.runtime,
      reason,
      expiresAt: new Date(this.expiryMs).toISOString(),
      at: this.now().toISOString(),
    };
    this.options.onLost?.(this.loss);
  }
}
