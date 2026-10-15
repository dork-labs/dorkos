/**
 * Reports one space connection's agents as there, on the space's own beat (DOR-2878).
 *
 * @module services/communities/remote/availability/agent-availability-reporter
 */
import {
  COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS,
  type CommunityWireAgentAvailabilityReport,
  type CommunityWireAgentAvailabilityReportResponse,
  type CommunityWireAgentRunsOn,
} from '@dorkos/shared/community-wire';
import { PinnedHttpError } from '../pinned-origin.js';
import { buildAgentAvailabilityReport, type ReportableAgent } from './agent-availability-report.js';

/** The two calls a reporter makes to its space: the adapter answers both. */
export interface AvailabilitySpace {
  /** Whether the space records availability reports. Never throws. */
  supportsAgentAvailability(): Promise<boolean>;
  /** Send one report; throws on any refusal or failure. */
  reportAgentAvailability(
    report: CommunityWireAgentAvailabilityReport,
    signal?: AbortSignal
  ): Promise<CommunityWireAgentAvailabilityReportResponse>;
}

/** What one reporter reads and calls. */
export interface AgentAvailabilityReporterDeps {
  /** The space this connection reaches. */
  space: AvailabilitySpace;
  /** The agents this installation enrolled in this space, read fresh before every report. */
  agents: () => readonly ReportableAgent[];
  /** What kind of computer runs one agent, by its local id. */
  runsOn: (localAgentId: string) => CommunityWireAgentRunsOn;
  /** Whether this space may be reached now (spaces on, or the official space). */
  reachable: () => boolean;
  /** Told once when reports start failing, never again until one succeeds. */
  onFailing?: (error: unknown) => void;
  /** A number in [0, 1); spreads every wait so many apps do not report in step. */
  random?: () => number;
  /** The clock, in milliseconds. */
  now?: () => number;
}

/** The first report goes out between these two waits after start, in milliseconds. */
export const FIRST_REPORT_MS = { min: 2_000, max: 10_000 } as const;
/** A space's asked-for interval is held within these bounds, in seconds. */
export const REPORT_SECONDS_BOUNDS = { min: 30, max: 3_600 } as const;
/** The first wait after a failed report, doubled per failure up to {@link MAX_BACKOFF_MS}. */
export const BASE_BACKOFF_MS = 30_000;
/** The longest wait between failed reports. */
export const MAX_BACKOFF_MS = 15 * 60_000;
/** How long a refused agent is left out before it is named again. */
export const REFUSED_FOR_MS = 30 * 60_000;
/** Each wait is spread by up to this share either way. */
export const JITTER = 0.1;

/**
 * Sends the availability report for one connection while it runs. It reports only when the space
 * says it records reports, and only agents this installation enrolled there; an agent the space
 * refused is left out for {@link REFUSED_FOR_MS}. The space's `reportEverySeconds` sets the next
 * wait; a failure backs off instead. {@link dispose} clears its timer and aborts a report in
 * flight, and nothing it does afterwards schedules again.
 */
export class AgentAvailabilityReporter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: AbortController | undefined;
  private disposed = false;
  private busy = false;
  private started = false;
  private everySeconds = COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS;
  private failures = 0;
  private readonly refused = new Map<string, number>();
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly deps: AgentAvailabilityReporterDeps) {
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
  }

  /** Schedule the first report, soon. Idempotent. */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    this.schedule(
      FIRST_REPORT_MS.min + this.random() * (FIRST_REPORT_MS.max - FIRST_REPORT_MS.min)
    );
  }

  /** Stop for good: clear the timer and abort a report in flight. Idempotent. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  /** Whether a timer is waiting; for tests and the runtime. */
  get scheduled(): boolean {
    return this.timer !== undefined;
  }

  /** Report now, then schedule the next one. Does nothing while a report is in flight. */
  async reportNow(): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let wait = this.everySeconds * 1_000;
    try {
      wait = await this.report();
      this.failures = 0;
    } catch (error) {
      // A space that answers 404 no longer records reports (the adapter forgets its features and
      // asks again later). That is an old space, not a failure.
      if (!this.disposed && !(error instanceof PinnedHttpError && error.status === 404)) {
        if (this.failures === 0) this.deps.onFailing?.(error);
        this.failures += 1;
        wait = this.backoff(error);
      }
    } finally {
      this.busy = false;
    }
    this.schedule(this.spread(wait));
  }

  /** One report, if any is due; resolves to the wait before the next. */
  private async report(): Promise<number> {
    const every = this.everySeconds * 1_000;
    if (!this.deps.reachable()) return every;
    if (!(await this.deps.space.supportsAgentAvailability())) return every;
    if (this.disposed) return every;
    const now = this.now();
    for (const [agentId, until] of this.refused) if (until <= now) this.refused.delete(agentId);
    const report = buildAgentAvailabilityReport(
      this.deps.agents(),
      this.deps.runsOn,
      new Set(this.refused.keys())
    );
    if (!report) return every;
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      const answer = await this.deps.space.reportAgentAvailability(report, controller.signal);
      for (const agentId of answer.refused) this.refused.set(agentId, now + REFUSED_FOR_MS);
      this.everySeconds = Math.min(
        REPORT_SECONDS_BOUNDS.max,
        Math.max(REPORT_SECONDS_BOUNDS.min, answer.reportEverySeconds)
      );
      return this.everySeconds * 1_000;
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined;
    }
  }

  private backoff(error: unknown): number {
    const doubled = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (this.failures - 1));
    const asked =
      error instanceof PinnedHttpError && error.retryAfterSeconds
        ? Math.min(MAX_BACKOFF_MS, error.retryAfterSeconds * 1_000)
        : 0;
    return Math.max(doubled, asked);
  }

  private spread(ms: number): number {
    return ms * (1 - JITTER + this.random() * 2 * JITTER);
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reportNow();
    }, ms);
    this.timer.unref?.();
  }
}
