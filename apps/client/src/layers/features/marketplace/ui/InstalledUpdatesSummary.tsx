/**
 * The one line above the Installed list that says where updates stand: being
 * checked, how many are available, that everything is up to date, or that the
 * check itself failed. It holds the list's two update actions, "Update all…"
 * and "Check again".
 *
 * @module features/marketplace/ui/InstalledUpdatesSummary
 */
import { CircleCheck, RefreshCw } from 'lucide-react';
import { Button, Spinner } from '@/layers/shared/ui';
import type { UpdatesSummary } from '../lib/installed-updates';

interface InstalledUpdatesSummaryProps {
  summary: UpdatesSummary;
  /** A check request is in flight. */
  isChecking: boolean;
  /** The check request itself failed. */
  error: Error | null;
  /** An update is being applied; checking again or starting another batch waits for it. */
  isApplying: boolean;
  /** Open the confirm step for every stale installation. */
  onUpdateAll: () => void;
  /** Run the check again. */
  onRecheck: () => void;
}

/** "1 package is" / "3 packages are". */
function packagesAre(count: number): string {
  return count === 1 ? '1 package is' : `${count} packages are`;
}

/** "1 package" / "3 packages". */
function packages(count: number): string {
  return `${count} ${count === 1 ? 'package' : 'packages'}`;
}

/**
 * The sentences after the headline: how many are current, how many unknown.
 * Whole sentences, so they read the same whether they sit beside the headline
 * or wrap under it on a phone.
 */
function detailSentences(summary: UpdatesSummary): string[] {
  const sentences: string[] = [];
  if (summary.current > 0) sentences.push(`${packagesAre(summary.current)} up to date.`);
  if (summary.unknown > 0) sentences.push(`${packages(summary.unknown)} couldn’t be checked.`);
  return sentences;
}

/** The headline, and whether everything is current (which earns the check icon). */
function describeSummary(summary: UpdatesSummary): { headline: string; allCurrent: boolean } {
  const available = summary.available.length;
  if (available > 0) {
    return {
      headline: `${available} ${available === 1 ? 'update' : 'updates'} available.`,
      allCurrent: false,
    };
  }
  if (summary.current > 0 && summary.unknown === 0) {
    return { headline: 'All packages are up to date.', allCurrent: true };
  }
  if (summary.current === 0 && summary.unknown === 0) {
    return { headline: 'These packages haven’t been checked for updates yet.', allCurrent: false };
  }
  return { headline: 'No updates found.', allCurrent: false };
}

/**
 * Where updates stand across the Installed list. The message is a polite live
 * region, so the answer is announced once when a check settles; the buttons sit
 * outside it so their labels are not read with every change.
 */
export function InstalledUpdatesSummary({
  summary,
  isChecking,
  error,
  isApplying,
  onUpdateAll,
  onRecheck,
}: InstalledUpdatesSummaryProps) {
  const { headline, allCurrent } = describeSummary(summary);
  const details = allCurrent ? [] : detailSentences(summary);
  const canUpdateAll = !isChecking && !isApplying && !error && summary.available.length > 0;

  return (
    <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl px-4 py-3">
      <p role="status" aria-live="polite" className="min-w-0 text-sm">
        {isChecking ? (
          <span className="text-muted-foreground flex items-center gap-2">
            <Spinner size="xs" />
            Checking your packages for updates…
          </span>
        ) : error ? (
          <span>Couldn’t check for updates: {error.message}</span>
        ) : (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {allCurrent && (
              <CircleCheck className="text-status-success-fg size-4 shrink-0" aria-hidden />
            )}
            <span className={summary.available.length > 0 ? 'font-medium' : undefined}>
              {headline}
            </span>
            {details.map((sentence) => (
              <span key={sentence} className="text-muted-foreground">
                {sentence}
              </span>
            ))}
          </span>
        )}
      </p>

      {!isChecking && (
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onRecheck} disabled={isApplying}>
            <RefreshCw className="mr-1 size-3" aria-hidden />
            {error ? 'Try again' : 'Check again'}
          </Button>
          {canUpdateAll && (
            <Button size="sm" onClick={onUpdateAll}>
              Update all…
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
