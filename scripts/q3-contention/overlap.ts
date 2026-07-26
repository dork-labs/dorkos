/**
 * The two validity proofs for the Q3 contention harness (DOR-500). A run that
 * fails either is discarded, not interpreted.
 *
 *  1. **Concurrency** ({@link computeOverlap}, {@link assertOverlap}). Without
 *     it a clean result is indistinguishable from six agents politely taking
 *     turns. Every agent reports the wall-clock instant its turn started and
 *     ended; this answers: was there an instant at which ALL were mid-turn?
 *  2. **Work** ({@link assertTurnsDidWork}). Overlap alone is not enough — six
 *     agents can overlap and do nothing. This is not hypothetical: arm 3 drives
 *     a real model that can ignore its instructions, and six agents streaming
 *     prose while skipping the canary would PASS the overlap proof and report
 *     "no contention" from a run that measured nothing. That confident-wrong
 *     answer is the exact failure this harness exists to prevent.
 *
 * Pure by design — no clocks, no I/O — so both assertions are testable.
 *
 * Design of record: `research/20260725_q3-contention-preregistration.md`.
 *
 * @module scripts/q3-contention/overlap
 */

/** One agent's turn, as the interval [startMs, endMs) on a shared clock. */
export interface TurnInterval {
  /** Human-readable agent label, e.g. `cats`. */
  readonly label: string;
  /** Epoch ms at which the agent began producing. */
  readonly startMs: number;
  /** Epoch ms at which the agent stopped producing. */
  readonly endMs: number;
}

/** Two agents that were never simultaneously mid-turn. */
export interface DisjointPair {
  readonly a: string;
  readonly b: string;
  /** Milliseconds of dead air between them (>= 0). */
  readonly gapMs: number;
}

/** The verdict on a set of turn intervals. */
export interface OverlapReport {
  /** Latest start across all intervals. */
  readonly commonStartMs: number;
  /** Earliest end across all intervals. */
  readonly commonEndMs: number;
  /** Width of the window during which every agent was mid-turn; 0 when none. */
  readonly commonWidthMs: number;
  /** True when a single instant exists at which every agent was mid-turn. */
  readonly allOverlap: boolean;
  /** Pairs that never overlapped — empty when `allOverlap` is true. */
  readonly disjointPairs: readonly DisjointPair[];
  /** Smallest pairwise overlap observed, in ms. */
  readonly minPairwiseOverlapMs: number;
}

/**
 * Compute the common-intersection verdict for a set of turn intervals.
 *
 * Overlap is strict: intervals that merely touch (one ends exactly as the next
 * begins) do NOT overlap, because that is precisely the polite-turn-taking case
 * the proof exists to reject.
 *
 * @param intervals - One interval per agent; at least two are required.
 * @returns The common window, the verdict, and every disjoint pair.
 * @throws If fewer than two intervals are supplied, or any interval is inverted.
 */
export function computeOverlap(intervals: readonly TurnInterval[]): OverlapReport {
  if (intervals.length < 2) {
    throw new Error(
      `[q3] overlap needs at least 2 turn intervals, got ${intervals.length} — concurrency was never exercised`
    );
  }
  for (const interval of intervals) {
    if (!(interval.endMs > interval.startMs)) {
      throw new Error(
        `[q3] agent "${interval.label}" reported a non-positive turn interval (${interval.startMs} → ${interval.endMs})`
      );
    }
  }

  const commonStartMs = Math.max(...intervals.map((i) => i.startMs));
  const commonEndMs = Math.min(...intervals.map((i) => i.endMs));
  const commonWidthMs = Math.max(0, commonEndMs - commonStartMs);

  const disjointPairs: DisjointPair[] = [];
  let minPairwiseOverlapMs = Number.POSITIVE_INFINITY;
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i]!;
      const b = intervals[j]!;
      const overlapMs = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
      minPairwiseOverlapMs = Math.min(minPairwiseOverlapMs, overlapMs);
      if (overlapMs <= 0) {
        disjointPairs.push({ a: a.label, b: b.label, gapMs: -overlapMs });
      }
    }
  }

  return {
    commonStartMs,
    commonEndMs,
    commonWidthMs,
    allOverlap: commonEndMs > commonStartMs,
    disjointPairs,
    minPairwiseOverlapMs,
  };
}

/**
 * Fail the run loudly when the agents did not actually run concurrently.
 *
 * @param report - Verdict from {@link computeOverlap}.
 * @param minWidthMs - Minimum common window to accept, in ms.
 * @throws If no common window exists, or it is narrower than `minWidthMs`.
 */
export function assertOverlap(report: OverlapReport, minWidthMs: number): void {
  if (!report.allOverlap) {
    const detail = report.disjointPairs
      .map((p) => `${p.a} vs ${p.b} (gap ${p.gapMs}ms)`)
      .join(', ');
    throw new Error(
      `[q3] OVERLAP PROOF FAILED — the agents never ran concurrently. ` +
        `Latest start ${report.commonStartMs} is after earliest end ${report.commonEndMs}. ` +
        `Disjoint pairs: ${detail || 'none pairwise, but no single common instant'}. ` +
        `Any contention result from this run is meaningless.`
    );
  }
  if (report.commonWidthMs < minWidthMs) {
    throw new Error(
      `[q3] OVERLAP PROOF FAILED — every agent was mid-turn for only ${report.commonWidthMs}ms, ` +
        `below the ${minWidthMs}ms floor. Raise --duration or reduce startup skew.`
    );
  }
}

/** What {@link assertTurnsDidWork} needs from one agent's turn. */
export interface TurnWorkEvidence {
  /** Agent label, e.g. `cats`. */
  readonly label: string;
  /** Terminal reason from the durable stream; `ok` is the only clean value. */
  readonly terminalReason: string;
  /** Stream ticks the agent completed, or -1 when it reported none. */
  readonly ticks: number;
  /** Canary lines the agent reported writing, or -1 when it reported none. */
  readonly appends: number;
}

/**
 * Fail the run loudly when the turns overlapped but produced nothing to measure.
 *
 * Four independent ways a run can be hollow, each checked separately so the
 * failure message names the actual one:
 *
 *  - an agent that was planned never reported at all;
 *  - a turn that did not end cleanly (`terminalReason !== 'ok'`);
 *  - a turn that streamed no ticks;
 *  - a turn that wrote no canary lines, which is the arm 3 failure mode — a
 *    real model can stream a perfectly good essay and never touch the file.
 *
 * @param evidence - One entry per turn that reported back.
 * @param expectedLabels - Every agent the plan intended to run.
 * @throws If any agent is missing, failed, streamed nothing, or wrote nothing.
 */
export function assertTurnsDidWork(
  evidence: readonly TurnWorkEvidence[],
  expectedLabels: readonly string[]
): void {
  const seen = new Set(evidence.map((e) => e.label));
  const missing = expectedLabels.filter((label) => !seen.has(label));
  if (missing.length > 0) {
    throw new Error(
      `[q3] WORK PROOF FAILED — planned agents never reported: ${missing.join(', ')}. ` +
        `The run is incomplete and its contention numbers understate the load.`
    );
  }

  const failures: string[] = [];
  for (const turn of evidence) {
    if (turn.terminalReason !== 'ok') {
      failures.push(`${turn.label} ended as "${turn.terminalReason}"`);
    }
    if (turn.ticks <= 0) {
      failures.push(`${turn.label} streamed no work (ticks=${turn.ticks})`);
    }
    if (turn.appends <= 0) {
      failures.push(`${turn.label} wrote no canary lines (appends=${turn.appends})`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `[q3] WORK PROOF FAILED — the turns overlapped but did not do the work: ` +
        `${failures.join('; ')}. A "no contention" reading from this run would be ` +
        `measuring nothing, not measuring an absence.`
    );
  }
}
