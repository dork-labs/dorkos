import { AlertTriangle, CalendarClock } from 'lucide-react';
import type { PreviewSchedule } from '@dorkos/shared/marketplace-schemas';
import { describePreviewSchedule } from '@/layers/entities/marketplace';

/** Props for {@link OfferScheduleRows}. */
export interface OfferScheduleRowsProps {
  /**
   * Every scheduled job the offered package ships, each already carrying the
   * permission mode it will really get.
   */
  schedules: PreviewSchedule[];
  /** True when DorkOS could not find out, which is its own thing to say. */
  checkFailed: boolean;
  /**
   * Distinguishes the two ledgers these rows appear in, so both can be found
   * and asserted separately. Test ids are `<prefix>-package-schedules` and
   * `<prefix>-offer-check-failed`.
   */
  testIdPrefix: string;
}

/**
 * The ledger rows saying what an offered package will run on a timer.
 *
 * Rendered on BOTH steps that end in a Create button, which is the whole point
 * of it being a component rather than JSX in one of them. The arrival confirm
 * (M1) shows it, and "Customize first" leads to the naming step (M3), which
 * creates the same agent from the same package — a disclosure that lived only
 * on the first card would be one click away from never being read (DOR-644).
 *
 * Emits bare `<div>` rows for a caller's `<dl>`, so each surface keeps its own
 * ledger styling and this owns only what is said.
 *
 * @param props - The jobs to disclose, whether the check failed, and the id prefix.
 */
export function OfferScheduleRows({
  schedules,
  checkFailed,
  testIdPrefix,
}: OfferScheduleRowsProps) {
  return (
    <>
      {/* What the package itself schedules, in the same words the install
          dialog uses for every other package type — including the permission
          mode, which is the fact that decides how much an unattended job may
          do. The modes here are already clamped server-side, so this says what
          the job GETS rather than what its author asked for. */}
      {schedules.length > 0 && (
        <div className="flex items-start gap-2" data-testid={`${testIdPrefix}-package-schedules`}>
          <CalendarClock className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <dt className="text-muted-foreground shrink-0">Brings a schedule</dt>
          <dd className="min-w-0 space-y-1">
            {schedules.map((job, index) => (
              <p key={`${job.name}-${index}`}>
                <span className="font-medium">{job.name}</span> — {describePreviewSchedule(job)}
              </p>
            ))}
          </dd>
        </div>
      )}
      {checkFailed && (
        <div className="flex items-start gap-2" data-testid={`${testIdPrefix}-offer-check-failed`}>
          <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" />
          <dt className="text-muted-foreground shrink-0">Not checked</dt>
          <dd className="min-w-0">
            DorkOS could not find out whether this agent brings work on a timer. Anything it does
            bring still has to be approved before it runs.
          </dd>
        </div>
      )}
    </>
  );
}
