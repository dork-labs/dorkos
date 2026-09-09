/**
 * What a sync just did — including, in full, what it removed.
 *
 * @module entities/harness/ui/HarnessSyncSummary
 */
import type { HarnessSyncResponse } from '@dorkos/shared/harness-schemas';
import { Banner } from '@/layers/shared/ui';
import { countedFiles, countedPackagesWaiting } from '../lib/harness-status';

/** What a {@link HarnessSyncSummary} draws. */
export interface HarnessSyncSummaryProps {
  /** What the sync answered. */
  result: HarnessSyncResponse;
  /** Put it away. It does not come back until the next sync. */
  onDismiss: () => void;
}

/**
 * The "what changed" block, in the banner's place after a sync.
 *
 * **The removed paths live here rather than in the toast**, and that is the
 * whole reason this component exists. A toast fires beside it for the "it
 * worked" moment, which is what a toast is for; a list of files that are gone
 * is not a thing that should fade after four seconds. Each path carries the
 * engine's own sentence saying why it went — six sweeps take files for five
 * different reasons, and one of the paths is not a deletion at all.
 *
 * `neutral`, not `info` or `warning`: this is a receipt for something the person
 * asked for and got, and colouring good news is how a page stops being able to
 * point at anything.
 *
 * It is dismissible and it does not survive a navigation. There is nothing to
 * come back to — the status the sync returned is already what the page draws.
 */
export function HarnessSyncSummary({ result, onDismiss }: HarnessSyncSummaryProps) {
  const { applied, removals, askedAbout } = result;

  return (
    <Banner
      variant="neutral"
      onDismiss={onDismiss}
      dismissLabel="Dismiss what changed"
      data-slot="harness-sync-summary"
    >
      <div className="flex flex-col gap-1">
        <p>
          <span className="font-medium">Agent files updated.</span> {countedFiles(applied)} written.
        </p>
        {removals.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <p className="font-medium">Removed {countedFiles(removals.length)} DorkOS put here:</p>
            <ul className="flex flex-col gap-0.5">
              {removals.map(({ path, reason }) => (
                <li key={path} className="text-3xs flex flex-col">
                  <code className="font-mono">{path}</code>
                  <span className="opacity-80">{reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {askedAbout.length > 0 && <p>{countedPackagesWaiting(askedAbout.length)}</p>}
      </div>
    </Banner>
  );
}
