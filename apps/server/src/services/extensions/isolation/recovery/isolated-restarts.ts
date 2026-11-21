/** Backoff, stop diagnostics and cancellation for isolated extensions. */
import type { ExtensionRecord } from '@dorkos/extension-api';
import { extensionServerErrorCopy } from '@dorkos/shared/extension-server-status';
import { logger } from '../../../../lib/logger.js';
import {
  RestartPolicy,
  type RestartDecision,
  type RestartPolicyOptions,
} from '../restart-policy.js';
import { tellExtensionStopped } from '../notices/tell-extension-stopped.js';
import type { ExtensionStopReason } from '../notices/extension-stopped-notice.js';

/** The latest stopped reason, retained across discovery scans and pending retries. */
export interface SupervisedServerStatus {
  serverError?: NonNullable<ExtensionRecord['serverError']>;
  restartingAt?: string;
}

/** An automatic restart belongs to exactly one source and cancellation generation. */
export interface RestartAttempt {
  id: string;
  sourceKey: string;
  reason: ExtensionStopReason;
  generation: number;
}

/** Keeps retry state apart from the lifecycle's serialized start/stop operations. */
export class IsolatedRestarts {
  private readonly policies = new Map<string, RestartPolicy>();
  private readonly sources = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly gaveUp = new Map<string, string>();
  private readonly statuses = new Map<string, SupervisedServerStatus>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly options: RestartPolicyOptions | undefined,
    private readonly restart: (attempt: RestartAttempt) => Promise<void>,
    private readonly changed: (id: string) => void
  ) {}

  /** New source gets a fresh budget; a page load of identical source does not. */
  source(id: string, key: string): void {
    if (this.sources.get(id) === key) return;
    this.reset(id);
    this.sources.set(id, key);
  }

  /** Refuse page-load starts that would undo a backoff or exhausted budget. */
  refusal(id: string, sourceKey: string, name: string): string | undefined {
    if (this.timers.has(id)) return `Restarting ${name}…`;
    if (this.gaveUp.get(id) === sourceKey) return this.status(id).serverError?.message ?? 'Stopped';
    return undefined;
  }

  /** Check inside the lifecycle queue, so a queued stop cancels an already-fired timer too. */
  current(attempt: RestartAttempt): boolean {
    return (
      this.sameSource(attempt) && (this.generations.get(attempt.id) ?? 0) === attempt.generation
    );
  }

  /** A source replaced while starting cannot inherit the old source's retry. */
  sameSource(attempt: RestartAttempt): boolean {
    return this.sources.get(attempt.id) === attempt.sourceKey;
  }

  /** Record a failed start without automatically retrying a manual or initial start. */
  failed(id: string, error: NonNullable<ExtensionRecord['serverError']>): void {
    this.statuses.set(id, { serverError: { ...error, occurredAt: new Date().toISOString() } });
  }

  /** Successful serving clears diagnostics and consecutive refusals, retaining crash history. */
  started(id: string): void {
    this.policies.get(id)?.onStarted();
    this.statuses.delete(id);
    this.gaveUp.delete(id);
  }

  /** Decide what follows a running child's unexpected exit. */
  exited(id: string, name: string, sourceKey: string, reason: ExtensionStopReason): void {
    const decision = this.policy(id).onUnexpectedExit();
    this.failed(id, { code: reason, message: extensionServerErrorCopy(reason, name)! });
    void tellExtensionStopped(id, name, reason, decision, this.options);
    this.plan({ id, sourceKey, reason, generation: this.generations.get(id) ?? 0 }, decision);
  }

  /** Only automatic isolation refusals retry; every other failed restart ends visibly. */
  refused(
    attempt: RestartAttempt,
    name: string,
    error: NonNullable<ExtensionRecord['serverError']>
  ): void {
    this.failed(attempt.id, error);
    const decision: RestartDecision =
      error.code === 'isolation_unavailable'
        ? this.policy(attempt.id).onStartFailure()
        : { giveUp: true };
    if ('giveUp' in decision) {
      void tellExtensionStopped(attempt.id, name, attempt.reason, decision, this.options, true);
    }
    this.plan({ ...attempt, generation: this.generations.get(attempt.id) ?? 0 }, decision);
  }

  /** Cancel a timer and any restart already queued behind another operation. */
  cancel(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const timer = this.timers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(id);
    if (this.status(id).restartingAt) this.statuses.delete(id);
  }

  /** Explicit reload, enable, approval or removal resets the episode. */
  reset(id: string): void {
    this.policies.get(id)?.reset();
    this.cancel(id);
    this.gaveUp.delete(id);
    this.statuses.delete(id);
  }

  /** Diagnostic status, including a stopped reason while a retry is pending. */
  status(id: string): SupervisedServerStatus {
    return this.statuses.get(id) ?? {};
  }

  private policy(id: string): RestartPolicy {
    const policy = this.policies.get(id) ?? new RestartPolicy(this.options);
    this.policies.set(id, policy);
    return policy;
  }

  private plan(attempt: RestartAttempt, decision: RestartDecision): void {
    const { id, sourceKey } = attempt;
    const previous = this.timers.get(id);
    if (previous) clearTimeout(previous);
    this.timers.delete(id);
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    if ('giveUp' in decision) {
      this.statuses.set(id, { serverError: this.status(id).serverError });
      this.gaveUp.set(id, sourceKey);
      logger.warn(`[Extensions] ${id} stopped too often; left off until it is reloaded`);
    } else {
      this.statuses.set(id, {
        ...this.status(id),
        restartingAt: new Date(Date.now() + decision.restartIn).toISOString(),
      });
      const timer = setTimeout(() => {
        this.timers.delete(id);
        void this.restart({ ...attempt, generation });
      }, decision.restartIn);
      timer.unref();
      this.timers.set(id, timer);
    }
    this.changed(id);
  }
}
