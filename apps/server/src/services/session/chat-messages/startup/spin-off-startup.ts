/**
 * First-turn deadlines for session_start. Reporting stays with ChatReportBack.
 * Entries follow canonical IDs and disappear on agent output or chat removal.
 * Like report-back retries, pending deadlines and failed-start status live in this process.
 */
import { NO_MARKS, type TurnMarks } from '../../../core/turn-power/turn-marks.js';
import { logger, logError } from '../../../../lib/logger.js';

/** A spin-off must open its first turn within five minutes. */
export const SPIN_OFF_START_TIMEOUT_MS = 5 * 60_000;

/** What the existing report-back path supplies. */
export interface SpinOffStartupDeps {
  failureReason(sessionId: string, fallback?: string): string;
  report(sessionId: string, reason: string, marks: TurnMarks): Promise<void>;
}

interface Startup {
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
  marks: TurnMarks;
  agentPath?: string;
  reason?: string;
  failure?: string;
}

/** Tracks starts, not later pauses or idle periods in an established chat. */
export class SpinOffStartup {
  private readonly starts = new Map<string, Startup>();

  /** Use the existing report sender and its startup diagnostics. */
  constructor(private readonly deps: SpinOffStartupDeps) {}

  /** Arm before awaiting launch, so a launch promise that hangs is covered too. */
  watch(sessionId: string, agentPath?: string, marks: TurnMarks = NO_MARKS): void {
    if (this.starts.has(sessionId)) return;
    const entry: Startup = {
      sessionId,
      marks: structuredClone(marks),
      agentPath,
      timer: setTimeout(() => this.expire(entry), SPIN_OFF_START_TIMEOUT_MS),
    };
    entry.timer.unref?.();
    this.starts.set(sessionId, entry);
  }

  /** Agent output proves a start; a synthetic projector turn alone does not. */
  started(sessionId: string): void {
    this.forget(sessionId);
  }

  /** A refused launch is already reported to its caller and leaves no spin-off. */
  forget(sessionId: string): void {
    const entry = this.starts.get(sessionId);
    if (entry) clearTimeout(entry.timer);
    this.starts.delete(sessionId);
  }

  /** Keep a launch-time diagnostic until the deadline, without restarting its clock. */
  noteFailure(sessionId: string, reason: string): void {
    const entry = this.starts.get(sessionId);
    if (entry) entry.reason = reason;
  }

  /** Follow a canonical rename without giving the start another five minutes. */
  rekey(from: string, to: string): void {
    if (from === to) return;
    const entry = this.starts.get(from);
    if (!entry) return;
    this.starts.delete(from);
    entry.sessionId = to;
    this.starts.set(to, entry);
  }

  /** Whether this spin-off still has no evidence that its first turn ran. */
  isWatching(sessionId: string): boolean {
    return this.starts.has(sessionId);
  }

  /** The reason a timed-out startup reads never-started, or null. */
  failureOf(sessionId: string): string | null {
    return this.starts.get(sessionId)?.failure ?? null;
  }

  /** The known sender home, even when launch stopped before the runtime bound it. */
  agentPathOf(sessionId: string): string | null {
    return this.starts.get(sessionId)?.agentPath ?? null;
  }

  /** Drop timers when the owning server service shuts down. */
  stop(): void {
    for (const entry of this.starts.values()) clearTimeout(entry.timer);
    this.starts.clear();
  }

  /** Record the failure once, then use report-back's existing delivery retries. */
  private expire(entry: Startup): void {
    const { sessionId } = entry;
    if (this.starts.get(sessionId) !== entry || entry.failure) return;
    let reason = entry.reason ?? 'The runtime did not start its first turn within five minutes.';
    try {
      reason = this.deps.failureReason(sessionId, entry.reason);
    } catch (err) {
      logger.warn('[chat report-back] could not read the startup diagnostic', {
        sessionId,
        ...logError(err),
      });
    }
    entry.failure = reason;
    void Promise.resolve()
      .then(() => this.deps.report(sessionId, reason, entry.marks))
      .catch((err: unknown) => {
        logger.warn('[chat report-back] a startup failure could not be reported', {
          sessionId,
          ...logError(err),
        });
      });
  }
}

let current: SpinOffStartup | undefined;

/** Wire the deadline service with report-back, or clear it at shutdown. */
export function setSpinOffStartup(startup: SpinOffStartup | undefined): void {
  current = startup;
}

/** The startup service, absent before chat messaging boots. */
export function getSpinOffStartup(): SpinOffStartup | undefined {
  return current;
}
