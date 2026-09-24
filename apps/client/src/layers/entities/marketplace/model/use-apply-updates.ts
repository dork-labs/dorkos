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
 * What a check becomes once an apply has answered for it.
 *
 * An applied installation now holds `applied.version`, so that is its
 * installed version, and it is current: a reinstall installs what an install
 * resolves, which is the latest by definition (ADR 260923-122615). The version
 * keeps the latest side's source when it is the version the check named, and
 * is the package's own declared version otherwise (a commit-identified latest
 * whose manifest states a version). The check's caveat no longer applies. Any
 * other answer is the server's fresh word on that installation (now current,
 * now unknown, or `applyError`) and is returned as given.
 *
 * @param returned - One installation's check from an apply's answer.
 */
export function settleAppliedCheck(returned: InstallationUpdateCheck): InstallationUpdateCheck {
  if (!returned.applied) return returned;
  const { applied, applyError: _applyError, note: _note, ...rest } = returned;
  return {
    ...rest,
    status: 'current',
    hasUpdate: false,
    installedVersion: applied.version,
    installedVersionSource:
      applied.version === returned.latestVersion ? returned.latestVersionSource : 'package',
  };
}

/**
 * Reinstall exactly the named installations at their newest version
 * (`POST /api/marketplace/updates`), each in the scope it is installed in, and
 * each held to the version and the disclosure the person was shown: a target
 * whose new version moved is refused (`disclosure_changed`), and the check is
 * refreshed so the next confirm shows what it runs now.
 *
 * Failures are not toasted here (`meta.suppressErrorToast`): the caller that
 * started the apply reports it. On success the cached update check is patched from the answer — each
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
    // The caller owns the failure report: it already shows a loading toast for
    // this apply and replaces it in place, through the `mutateAsync` promise,
    // which settles whether or not the calling component is still mounted.
    // The shared `MutationCache` toast would report the same failure twice.
    meta: { suppressErrorToast: true },
    onError: (err) => {
      // A new version changed what it runs after the check the person read:
      // nothing ran, and the check is stale. Ask again so the next confirm
      // shows what it runs now (DOR-2306).
      if ((err as { code?: unknown }).code === 'disclosure_changed') {
        void queryClient.invalidateQueries({ queryKey: marketplaceKeys.updates() });
      }
    },
    onSuccess: async (result) => {
      const byPath = new Map(result.checks.map((c) => [c.installPath, settleAppliedCheck(c)]));
      queryClient.setQueriesData<InstallationUpdatesResult>(
        { queryKey: marketplaceKeys.updates() },
        (cached) =>
          cached && {
            checks: cached.checks.map((check) => byPath.get(check.installPath) ?? check),
          }
      );

      const applied = result.checks.filter((c) => c.applied);
      if (applied.length === 0) return;
      for (const name of new Set(applied.map((c) => c.packageName))) {
        void queryClient.invalidateQueries({ queryKey: marketplaceKeys.installedDetail(name) });
        void queryClient.invalidateQueries({ queryKey: marketplaceKeys.packageDetail(name) });
      }
      // A reinstall can change the package's slash commands (UX-12).
      void queryClient.invalidateQueries({ queryKey: ['commands'] });
      // Awaited: the apply stays pending until the installed list shows the new
      // versions, so a row goes straight from "Updating…" to "Up to date" and
      // never sits between a patched check and a list that has not caught up.
      await queryClient.invalidateQueries({ queryKey: marketplaceKeys.installed() });
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
      (mutation.state.variables as ApplyUpdatesOptions | undefined)?.targets.map(
        (target) => target.installPath
      ),
  });
  return useMemo(() => new Set(inFlight.flatMap((paths) => paths ?? [])), [inFlight]);
}
