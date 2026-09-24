/**
 * Apply marketplace updates with one toast that reports what happened.
 *
 * Wraps `useApplyUpdates`: one loading toast per apply, replaced in place
 * (sonner's `{ id }`) by the outcome. One installation gets its own sentence
 * ("Updated Reviewer on Alpha to v1.3.0", "Couldn’t update Reviewer: <why>");
 * several get a count, and the rows carry each installation's detail, so the
 * toast never has to list them.
 *
 * @module features/marketplace/model/use-apply-updates-with-toast
 */
import { useCallback } from 'react';
import { toast } from 'sonner';

import { humanizePackageName } from '@/layers/shared/lib';
import { useApplyUpdates } from '@/layers/entities/marketplace';
import type {
  InstallationUpdateCheck,
  InstallationUpdatesResult,
} from '@dorkos/shared/marketplace-schemas';
import {
  formatCheckVersion,
  installationPlace,
  type StaleInstallation,
} from '../lib/installed-updates';

/** The toast a finished apply shows. */
interface ApplyOutcomeToast {
  kind: 'success' | 'warning' | 'error';
  message: string;
}

/** "Reviewer", or "Reviewer on Alpha" for an agent's installation, by its listed name. */
function installationLabel({ installation }: StaleInstallation): string {
  const name = humanizePackageName(installation.name);
  const place = installationPlace(installation);
  return place ? `${name} on ${place}` : name;
}

/** Describe one installation's outcome. */
function describeOne(label: string, check: InstallationUpdateCheck | undefined): ApplyOutcomeToast {
  if (check?.applied) {
    const version = formatCheckVersion(check.applied.version, check.latestVersionSource);
    return { kind: 'success', message: `Updated ${label} to ${version}` };
  }
  if (check?.applyError) {
    return { kind: 'error', message: `Couldn’t update ${label}: ${check.applyError}` };
  }
  if (check?.status === 'current') {
    return { kind: 'success', message: `${label} is already up to date` };
  }
  if (check?.status === 'unknown') {
    const why = check.note ? `: ${check.note}` : '';
    return { kind: 'warning', message: `Couldn’t check ${label} for updates${why}` };
  }
  return { kind: 'warning', message: `${label} wasn’t updated` };
}

/** Describe several installations' outcomes as counts; the rows hold the detail. */
function describeMany(checks: readonly InstallationUpdateCheck[]): ApplyOutcomeToast {
  const total = checks.length;
  const applied = checks.filter((c) => c.applied).length;
  const failed = checks.filter((c) => c.applyError).length;
  if (applied === total) return { kind: 'success', message: `Updated ${total} packages` };
  if (applied > 0) {
    return {
      kind: 'warning',
      message: `Updated ${applied} of ${total} packages. Each package shows what happened.`,
    };
  }
  if (failed > 0) {
    const count = failed === total ? `${total}` : `${failed} of ${total}`;
    return { kind: 'error', message: `Couldn’t update ${count} packages. Each package shows why.` };
  }
  if (checks.every((c) => c.status === 'current')) {
    return { kind: 'success', message: `These ${total} packages are already up to date` };
  }
  return { kind: 'warning', message: 'Nothing was updated. Each package shows where it stands.' };
}

/**
 * Describe a finished apply. The answer is matched to what was asked by
 * `installPath`, so a label always belongs to the installation it names.
 */
function describeOutcome(
  requested: readonly StaleInstallation[],
  result: InstallationUpdatesResult
): ApplyOutcomeToast {
  const byPath = new Map(result.checks.map((c) => [c.installPath, c]));
  if (requested.length === 1) {
    const only = requested[0]!;
    return describeOne(installationLabel(only), byPath.get(only.check.installPath));
  }
  return describeMany(requested.map(({ check }) => byPath.get(check.installPath) ?? check));
}

/** Show a finished apply's toast in place of the loading one. */
function showOutcome(outcome: ApplyOutcomeToast, toastId: string | number): void {
  toast[outcome.kind](outcome.message, { id: toastId });
}

/**
 * Apply updates to exactly the given installations, with toasts.
 *
 * `apply(stale)` sends those installations' `installPaths` and nothing else, so
 * "Update all" reinstalls what its confirm step showed and a row's Update
 * reinstalls that row. An empty list sends nothing.
 */
export function useApplyUpdatesWithToast() {
  const { mutate } = useApplyUpdates();

  const apply = useCallback(
    (stale: readonly StaleInstallation[]) => {
      const [first, ...rest] = stale.map(({ check }) => check.installPath);
      if (first === undefined) return;
      const toastId = toast.loading(
        stale.length === 1
          ? `Updating ${installationLabel(stale[0]!)}…`
          : `Updating ${stale.length} packages…`
      );
      mutate(
        { installPaths: [first, ...rest] },
        {
          onSuccess: (result) => showOutcome(describeOutcome(stale, result), toastId),
          onError: (err) => toast.error(`Update failed: ${err.message}`, { id: toastId }),
        }
      );
    },
    [mutate]
  );

  return { apply };
}
