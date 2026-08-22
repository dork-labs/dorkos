/**
 * What the test run did, on the card that asked for it.
 *
 * @module features/schedule-approval/ui/TestRunStrip
 */
import { Loader2, Check, X, CircleSlash } from 'lucide-react';
import { cn, formatCompactAge } from '@/layers/shared/lib';
import type { ScheduleTestRunState } from '../model/use-schedule-test-run';

/**
 * When the run finished, in words.
 *
 * A test run is watched, so it settles seconds after it is asked for — and
 * `formatCompactAge` floors, so the ordinary case read "finished 0m ago". "Just
 * now" is what a person would say, and it is the only reading this line has for
 * its first minute of life.
 *
 * @param finishedAt - When the run ended, or null when the history has no time
 *   for it — in which case the line simply says it finished and stops.
 */
function finishedWhen(finishedAt: string | null): string {
  if (finishedAt === null) return '';
  const age = formatCompactAge(finishedAt);
  return age === '0m' ? ' just now' : ` ${age} ago`;
}

/** What {@link TestRunStrip} draws. */
export interface TestRunStripProps {
  /** The test run's state, straight from `useScheduleTestRun`. */
  testRun: ScheduleTestRunState;
  /**
   * Open what the run did. Absent when the run left no session behind, in which
   * case the strip says what happened and offers nothing to click.
   */
  onOpenRun?: () => void;
  className?: string;
}

/**
 * One line reporting the supervised run.
 *
 * **It never says a run succeeded when it failed, and never hides the reason.**
 * A test run exists to produce evidence, and a strip that reported "finished"
 * over a failure would produce the opposite — an operator approving a schedule
 * on the strength of a run that did not work. Failures say so and quote the
 * server's own words; a cancelled run says it was stopped, which is neither a
 * success nor a fault.
 *
 * `role="status"` because it changes under a reader who has just pressed a
 * button and is waiting to hear what happened.
 *
 * @param props - The {@link TestRunStripProps.testRun} and where to open it.
 */
export function TestRunStrip({ testRun, onOpenRun, className }: TestRunStripProps) {
  const { phase, run, error } = testRun;
  if (phase === 'idle') return null;

  const finishedAt = run?.finishedAt ?? run?.createdAt ?? null;

  return (
    <p
      data-slot="schedule-test-run"
      data-phase={phase}
      role="status"
      className={cn('text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs', className)}
    >
      {phase === 'running' && (
        <>
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
          Test run in progress…
        </>
      )}

      {phase === 'finished' && (
        <>
          <Check className="text-status-success size-3.5 shrink-0" aria-hidden />
          <span>Test run finished{finishedWhen(finishedAt)}</span>
          {onOpenRun && (
            // A real button rather than an anchor: the cockpit routes in-process
            // and the Obsidian embed has no router at all, so the caller decides
            // what "go there" means (and closes the panel it was drawn in).
            <button
              type="button"
              data-slot="schedule-test-run-open"
              onClick={onOpenRun}
              className="text-primary focus-visible:ring-ring/50 rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
            >
              view what it did →
            </button>
          )}
        </>
      )}

      {phase === 'stopped' && (
        <>
          <CircleSlash className="size-3.5 shrink-0" aria-hidden />
          Test run was stopped before it finished.
        </>
      )}

      {phase === 'failed' && (
        <>
          <X className="text-status-error size-3.5 shrink-0" aria-hidden />
          {/* The reason, whenever the server gave one. A bare "it failed" is
              the least useful thing this line could say to somebody deciding
              whether to let the same prompt run unattended every night. */}
          <span className="min-w-0 break-words">Test run failed{error ? ` — ${error}` : '.'}</span>
        </>
      )}
    </p>
  );
}
