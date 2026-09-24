/**
 * The Installed view's update picture: the installed rows joined to the one
 * update check, shared by the Installed tab's count and the view itself.
 *
 * @module features/marketplace/model/use-installed-updates-view
 */
import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  marketplaceKeys,
  useInstalledPackages,
  useInstalledUpdates,
} from '@/layers/entities/marketplace';
import type { InstallationUpdateCheck } from '@dorkos/shared/marketplace-schemas';
import { indexChecks, summarizeUpdates, type UpdatesSummary } from '../lib/installed-updates';

/** What {@link useInstalledUpdatesView} returns. */
export interface InstalledUpdatesView {
  /** The check's answer by `installPath`; empty before there is one, or when the last check failed. */
  checks: ReadonlyMap<string, InstallationUpdateCheck>;
  /** Where the listed installations stand. */
  summary: UpdatesSummary;
  /** A check request is in flight (the first one, or "Check again"). */
  isChecking: boolean;
  /** The check request itself failed; per-installation failures are `unknown` checks. */
  error: Error | null;
  /** Ask again, now. */
  recheck: () => void;
}

/**
 * Read the update check for every installation the Installed view lists (every
 * scope, so no `projectPath`), once, and join it to the rows by `installPath`.
 *
 * The check runs only when something is installed. Every caller shares the one
 * request, so the tab count and the view never ask twice.
 *
 * When the installed list changes (an install, an uninstall, an update from
 * anywhere), the check is marked stale without re-running, so the next view to
 * mount asks again. When a check fails, an earlier answer is not shown as if
 * it were current: rows read as unchecked and the count disappears until a
 * check succeeds.
 */
export function useInstalledUpdatesView(): InstalledUpdatesView {
  const queryClient = useQueryClient();
  const { data: installed } = useInstalledPackages();
  const hasInstalled = (installed?.length ?? 0) > 0;
  const updates = useInstalledUpdates(undefined, { enabled: hasInstalled });
  const { data, isFetching, error, refetch } = updates;

  // Structural sharing keeps `installed` the same object while the list is
  // unchanged, so this fires only when it really changed (never on first load).
  const previousInstalled = useRef(installed);
  useEffect(() => {
    const previous = previousInstalled.current;
    previousInstalled.current = installed;
    if (previous === undefined || previous === installed) return;
    void queryClient.invalidateQueries({
      queryKey: marketplaceKeys.updates(),
      refetchType: 'none',
    });
  }, [installed, queryClient]);

  const checks = useMemo(() => indexChecks(error ? undefined : data?.checks), [data, error]);
  const summary = useMemo(() => summarizeUpdates(installed ?? [], checks), [installed, checks]);

  return {
    checks,
    summary,
    isChecking: isFetching,
    error,
    recheck: () => void refetch(),
  };
}
