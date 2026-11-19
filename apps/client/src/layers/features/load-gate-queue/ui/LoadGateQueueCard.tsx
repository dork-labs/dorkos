import { useId, useState } from 'react';
import { cn } from '@/layers/shared/lib';
import { useLoadGateWaitingLine } from '../model/use-load-gate-queue';
import { LoadGateJobRow } from './LoadGateJobRow';

/** Props for {@link LoadGateQueueCard}. */
interface LoadGateQueueCardProps {
  className?: string;
}

/**
 * The heavy jobs waiting for the computer to be less busy (DOR-4209), with
 * three actions on each: let it through now, mark it urgent, or move it to the
 * front. No card while the line is empty, or on a device the server refuses
 * (the line is shown only at the computer running DorkOS).
 *
 * The live region stays mounted when the card goes, so letting the last job
 * through is still announced.
 */
export function LoadGateQueueCard({ className }: LoadGateQueueCardProps) {
  const headingId = useId();
  const { data, dataUpdatedAt } = useLoadGateWaitingLine();
  const [announcement, setAnnouncement] = useState('');
  const jobs = data?.jobs ?? [];
  // The wait is counted to the last read, so it moves on with each refresh. Rows
  // render only once a read has landed, so this is never 0 when it is used.
  const now = dataUpdatedAt;

  return (
    <>
      {jobs.length > 0 && (
        <section
          data-slot="load-gate-queue"
          aria-labelledby={headingId}
          className={cn('bg-card border-border rounded-lg border px-4 py-3', className)}
        >
          <h2 id={headingId} className="text-foreground text-sm font-medium">
            Heavy jobs waiting
          </h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            They start when the computer is less busy.
          </p>
          <ol className="divide-border mt-2 divide-y">
            {jobs.map((job) => (
              <LoadGateJobRow key={job.id} job={job} now={now} onDone={setAnnouncement} />
            ))}
          </ol>
        </section>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  );
}
