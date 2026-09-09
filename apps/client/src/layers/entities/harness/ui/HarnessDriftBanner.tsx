/**
 * At most one line about this project's agent files, and — when a click would
 * delete something — the manifest of what it deletes, before the click.
 *
 * @module entities/harness/ui/HarnessDriftBanner
 */
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { HarnessStatusResponse } from '@dorkos/shared/harness-schemas';
import { cn } from '@/layers/shared/lib/utils';
import { Banner, Button } from '@/layers/shared/ui';
import { countedFiles } from '../lib/harness-status';
import { useHarnessStatus } from '../model/use-harness-status';
import { useHarnessSync, useHarnessSyncApprovalRefresh } from '../model/use-harness-sync';
import { HarnessSyncSummary } from './HarnessSyncSummary';

/** What a {@link HarnessDriftBanner} is about. */
export interface HarnessDriftBannerProps {
  /** The agent's project directory, absolute. */
  projectPath: string;
}

/** What one line of the banner says, and whether a click can do anything about it. */
interface BannerLine {
  /** The sentence. */
  message: string;
  /** How loud it is. */
  variant: 'info' | 'warning';
  /** Whether "Sync now" is offered. */
  actionable: boolean;
}

/**
 * The one thing worth saying about this tree, first match wins.
 *
 * **The action's predicate is exactly what a sync would act on.** `applyPlan`
 * writes what has drifted and removes what is orphaned, so the button appears
 * for either. An earlier, drift-only predicate left both failures on the page at
 * once: a click that removed files with no banner over it, and — on a tree whose
 * only fault was orphans — a banner that clicking could not clear.
 *
 * A conflict and an adoptable skill get a line and no button, because a sync
 * fixes neither. Running one over a conflict reports the same conflict again,
 * and a skill in the wrong folder is a move nobody has asked for (D3).
 *
 * @param status - The status this project is in.
 * @returns The line to draw, or `null` when the tree has nothing to say.
 */
export function harnessBannerLine(status: HarnessStatusResponse): BannerLine | null {
  const { counts, sweepPreview } = status;
  if (counts.drifted > 0 || sweepPreview.length > 0) {
    return {
      message: 'Some agent files are out of date.',
      // A click that deletes something is a warning even when the reason for the
      // click is only that a file is stale.
      variant: sweepPreview.length > 0 ? 'warning' : 'info',
      actionable: true,
    };
  }
  if (counts.conflicts > 0) {
    return {
      message: 'DorkOS can’t update some files. Something else is in the way.',
      variant: 'warning',
      actionable: false,
    };
  }
  if (counts.adoptable > 0) {
    return {
      message: 'Some skills live where only a few of your agents look.',
      variant: 'info',
      actionable: false,
    };
  }
  return null;
}

/**
 * Subscribe to `approval_resolved` for as long as there is something to refresh.
 *
 * Its own component, mounted only once the project reads `ready`, because the
 * subscription needs the app-level `EventStreamProvider` and this slice is drawn
 * in trees that have none — the in-process (Obsidian) transport answers
 * `unavailable` for every project, and a hook called before that early return
 * would throw there over a stream the surface was never going to use.
 */
function HarnessApprovalRefresh({ projectPath }: HarnessDriftBannerProps) {
  useHarnessSyncApprovalRefresh(projectPath);
  return null;
}

/**
 * The banner, and — after a sync — the "what changed" summary in its place.
 *
 * **Inline at the top of the page, not `AppBannerSlot`.** That slot ranks one
 * banner for the whole app; this is a fact about one project on one page, and a
 * project-scoped fact in a global slot follows the person to every route.
 *
 * **No red, and no count in the nav.** Drift is a file that has not been written
 * yet, not an error. `info` for drift and adoptable, `warning` for a conflict
 * and for the removal disclosure, `critical` never.
 *
 * **It clears by being recomputed.** There is no `onDismiss`: the sync's own
 * response replaces the cached status and this re-renders from it, so a banner
 * can never outlive the condition it is about. The summary beside it IS
 * dismissible, because it is a receipt rather than a condition.
 *
 * **The removal disclosure is not optional.** Whenever a sync would delete
 * something, the paths are named before the click, each with the reason it goes
 * — which is what `dorkos harness sync --check` has always printed in the
 * terminal. A banner with a destructive action and no manifest of it is the
 * failure this whole slice exists to prevent.
 *
 * It reads the status from the same query key the list and the profile row use,
 * so mounting it costs no extra request.
 */
export function HarnessDriftBanner({ projectPath }: HarnessDriftBannerProps) {
  const { data: status } = useHarnessStatus(projectPath);
  const sync = useHarnessSync(projectPath);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [summaryDismissed, setSummaryDismissed] = useState(false);

  if (status === undefined || status.state !== 'ready') return null;

  // Mounted even when nothing is drawn: a package waiting on a card shows no
  // banner, and the whole point of the subscription is to notice when somebody
  // answers it and the second projection pass lands.
  const refresh = <HarnessApprovalRefresh projectPath={projectPath} />;

  if (sync.data !== undefined && !summaryDismissed) {
    return (
      <>
        {refresh}
        <HarnessSyncSummary result={sync.data} onDismiss={() => setSummaryDismissed(true)} />
      </>
    );
  }

  const line = harnessBannerLine(status);
  if (line === null) return refresh;

  const { removals, sweepPreview } = status;
  const removalCount = sweepPreview.length;

  return (
    <>
      {refresh}
      <Banner
        variant={line.variant}
        data-slot="harness-drift-banner"
        detailsOpen={detailsOpen}
        details={
          removalCount === 0 ? undefined : (
            <ul className="flex flex-col gap-0.5">
              {removals.map(({ path, reason }) => (
                <li key={path} className="text-3xs flex flex-col">
                  <code className="font-mono">{path}</code>
                  <span className="opacity-80">{reason}</span>
                </li>
              ))}
            </ul>
          )
        }
        actions={
          line.actionable ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-xs"
              disabled={sync.isPending}
              onClick={() => {
                setSummaryDismissed(false);
                sync.mutate();
              }}
            >
              {sync.isPending ? 'Syncing…' : 'Sync now'}
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-0.5">
          <p>{line.message}</p>
          {removalCount > 0 && (
            <button
              type="button"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((open) => !open)}
              className="text-3xs flex w-fit items-center gap-1 underline underline-offset-2 opacity-90 hover:opacity-100"
            >
              Syncing also removes {countedFiles(removalCount)} DorkOS put here
              <ChevronDown
                aria-hidden
                className={cn('size-3 transition-transform', detailsOpen && 'rotate-180')}
              />
            </button>
          )}
        </div>
      </Banner>
    </>
  );
}
