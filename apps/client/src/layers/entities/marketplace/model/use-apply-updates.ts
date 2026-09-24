import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTransport } from '@/layers/shared/model';
import type {
  ApplyUpdatesOptions,
  InstallationUpdateCheck,
  InstallationUpdatesResult,
} from '@dorkos/shared/marketplace-schemas';
import { marketplaceKeys } from '../api/query-keys';

/**
 * What a cached check should become once an apply has answered for it.
 *
 * An applied installation now holds the version the check called latest,
 * which is by definition what an install resolves (ADR 260923-122615), so it
 * is current at that version and the check's caveat no longer applies. Any
 * other answer is the server's fresh word on that installation (now current,
 * now unknown, or `applyError`) and is stored as given.
 */
function settledCheck(returned: InstallationUpdateCheck): InstallationUpdateCheck {
  if (!returned.applied) return returned;
  const { applied: _applied, applyError: _applyError, note: _note, ...rest } = returned;
  return {
    ...rest,
    status: 'current',
    hasUpdate: false,
    installedVersion: returned.latestVersion,
    installedVersionSource: returned.latestVersionSource,
  };
}

/**
 * Reinstall exactly the named installations at their newest version
 * (`POST /api/marketplace/updates`), each in the scope it is installed in.
 *
 * On success the cached update check is patched from the answer — each
 * returned installation replaces its cached check — so rows move to their new
 * state without a second sweep of every package's source. The installed list
 * (versions changed), each applied package's detail caches, and, when anything
 * was reinstalled, the command registry (UX-12) are refreshed.
 */
export function useApplyUpdates() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<InstallationUpdatesResult, Error, ApplyUpdatesOptions>({
    mutationKey: marketplaceKeys.applyUpdates(),
    mutationFn: (opts) => transport.applyMarketplaceUpdates(opts),
    onSuccess: (result) => {
      const byPath = new Map(result.checks.map((c) => [c.installPath, settledCheck(c)]));
      queryClient.setQueriesData<InstallationUpdatesResult>(
        { queryKey: marketplaceKeys.updates() },
        (cached) =>
          cached && {
            checks: cached.checks.map((check) => byPath.get(check.installPath) ?? check),
          }
      );

      const applied = result.checks.filter((c) => c.applied);
      if (applied.length === 0) return;
      void queryClient.invalidateQueries({ queryKey: marketplaceKeys.installed() });
      for (const name of new Set(applied.map((c) => c.packageName))) {
        void queryClient.invalidateQueries({ queryKey: marketplaceKeys.installedDetail(name) });
        void queryClient.invalidateQueries({ queryKey: marketplaceKeys.packageDetail(name) });
      }
      // A reinstall can change the package's slash commands (UX-12).
      void queryClient.invalidateQueries({ queryKey: ['commands'] });
    },
  });
}

/**
 * Every installation an apply is updating right now, across every caller of
 * {@link useApplyUpdates}, so each row keeps its progress however many were
 * started.
 */
export function useApplyingInstallPaths(): ReadonlySet<string> {
  const inFlight = useMutationState({
    filters: { mutationKey: marketplaceKeys.applyUpdates(), status: 'pending' },
    select: (mutation) =>
      (mutation.state.variables as ApplyUpdatesOptions | undefined)?.installPaths,
  });
  return useMemo(() => new Set(inFlight.flatMap((paths) => paths ?? [])), [inFlight]);
}
