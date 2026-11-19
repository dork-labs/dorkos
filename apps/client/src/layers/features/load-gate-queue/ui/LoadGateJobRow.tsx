import type { LoadGateJobAction, LoadGateWaitingJob } from '@dorkos/shared/load-gate-queue';
import { Button } from '@/layers/shared/ui';
import {
  actionError,
  actionLabels,
  disabledReason,
  doneAnnouncement,
  jobOwner,
  standingLine,
  waitedLine,
} from '../lib/job-lines';
import { useLoadGateJobAction } from '../model/use-load-gate-queue';

/** Props for {@link LoadGateJobRow}. */
interface LoadGateJobRowProps {
  /** The waiting job. */
  job: LoadGateWaitingJob;
  /** The time its wait is counted to, in epoch milliseconds. */
  now: number;
  /** Hears what a screen reader should announce once an action took. */
  onDone: (announcement: string) => void;
}

/** The three buttons, in the order they show. Let through is the main one. */
const ACTIONS: readonly { action: LoadGateJobAction; text: string; busy: string }[] = [
  { action: 'let-through', text: 'Let through', busy: 'Starting…' },
  { action: 'urgent', text: 'Urgent', busy: 'Marking…' },
  { action: 'front', text: 'Move to front', busy: 'Moving…' },
];

/**
 * One waiting job: its place, who it is for, what it runs, how long it has
 * waited, and its three actions. In a narrow card (a phone, a side panel) the
 * buttons go below the job and the detail line wraps instead of being cut.
 */
export function LoadGateJobRow({ job, now, onDone }: LoadGateJobRowProps) {
  const act = useLoadGateJobAction();
  const labels = actionLabels(job);
  const owner = jobOwner(job);
  const detail = [job.chatTitle, waitedLine(job, now), standingLine(job)].filter(Boolean);

  const run = (action: LoadGateJobAction) =>
    act.mutate(
      { id: job.id, action },
      {
        onSuccess: (line) =>
          onDone(
            doneAnnouncement(
              job,
              action,
              line.jobs.find((next) => next.id === job.id)
            )
          ),
      }
    );

  return (
    <li className="flex flex-col gap-2 py-2.5 @min-[36rem]/queue:flex-row @min-[36rem]/queue:items-center @min-[36rem]/queue:gap-4">
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <span className="text-muted-foreground w-5 shrink-0 text-right text-xs tabular-nums">
          {job.position}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-baseline gap-2 text-sm">
            <span className="text-foreground truncate font-medium" title={owner}>
              {owner}
            </span>
            <code className="text-muted-foreground shrink-0 font-mono text-xs">{job.label}</code>
          </p>
          <p
            className="text-muted-foreground text-xs break-words @min-[36rem]/queue:truncate"
            title={detail.join(' · ')}
          >
            {detail.join(' · ')}
          </p>
          {act.isError && (
            <p className="text-destructive mt-0.5 text-xs">{actionError(act.error)}</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-8 @min-[36rem]/queue:shrink-0 @min-[36rem]/queue:pl-0">
        {ACTIONS.map(({ action, text, busy }) => (
          <Button
            key={action}
            size="sm"
            variant={action === 'let-through' ? 'primary' : 'secondary'}
            aria-label={labels[action]}
            disabledReason={disabledReason(job, action)}
            loading={act.isPending && act.variables?.action === action}
            loadingLabel={busy}
            onClick={() => run(action)}
          >
            {text}
          </Button>
        ))}
      </div>
    </li>
  );
}
