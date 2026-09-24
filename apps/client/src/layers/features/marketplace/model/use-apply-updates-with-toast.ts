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
import { useCallback, useRef } from 'react';
import { toast } from 'sonner';

import { humanizePackageName } from '@/layers/shared/lib';
import { settleAppliedCheck, useApplyUpdates } from '@/layers/entities/marketplace';
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
    const settled = settleAppliedCheck(check);
    const version = formatCheckVersion(settled.installedVersion, settled.installedVersionSource);
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

/** The server's code for a batch that would need a person to approve each install. */
const BATCH_NEEDS_APPROVAL = 'batch_update_needs_approval';

/**
 * Why a refused or failed apply failed, in a person's words. The one refusal
 * with its own code gets a sentence of its own; the server's message names an
 * API route, which is not something a person can act on.
 */
function describeFailure(err: unknown, requested: readonly StaleInstallation[]): string {
  if ((err as { code?: unknown } | null)?.code === BATCH_NEEDS_APPROVAL) {
    // The next step names the command, with the package's own name when there
    // is one package (the name the update check and the CLI both use).
    const next =
      requested.length === 1
        ? `Update it from the terminal with \`dorkos marketplace update ${requested[0]!.check.packageName}\`.`
        : 'Update each one from the terminal with `dorkos marketplace update <name>`.';
    return `Each of these installs needs your approval first, and DorkOS can’t ask for it here. ${next}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Apply updates to exactly the given installations, with toasts.
 *
 * `apply(stale)` sends those installations and nothing else, so "Update all"
 * reinstalls what its confirm step showed and a row's Update reinstalls that
 * row. An empty list sends nothing, and an installation already being updated
 * from this hook is left out, so a double click never sends a second apply.
 *
 * Each apply owns its toast through its own `mutateAsync` promise, which
 * settles however many applies overlap and whether or not this component is
 * still mounted. (Per-call `mutate(…, { onSuccess })` callbacks run only for
 * the latest call on a mounted observer, which left earlier toasts spinning.)
 * The failure toast is reported here, once; the mutation opts out of the
 * shared one.
 */
export function useApplyUpdatesWithToast() {
  const { mutateAsync } = useApplyUpdates();
  // Held in a ref, not state: a second click lands before any re-render.
  const inFlight = useRef(new Set<string>());

  const apply = useCallback(
    (stale: readonly StaleInstallation[]) => {
      const fresh = stale.filter(({ check }) => !inFlight.current.has(check.installPath));
      const [first, ...rest] = fresh.map(({ check }) => ({ installPath: check.installPath }));
      if (first === undefined) return;
      const paths = fresh.map(({ check }) => check.installPath);
      for (const path of paths) inFlight.current.add(path);

      const label = fresh.length === 1 ? installationLabel(fresh[0]!) : `${fresh.length} packages`;
      const toastId = toast.loading(`Updating ${label}…`);
      mutateAsync({ targets: [first, ...rest] })
        .then((result) => showOutcome(describeOutcome(fresh, result), toastId))
        .catch((err: unknown) =>
          toast.error(`Couldn’t update ${label}`, {
            id: toastId,
            description: describeFailure(err, fresh),
          })
        )
        .finally(() => {
          for (const path of paths) inFlight.current.delete(path);
        });
    },
    [mutateAsync]
  );

  return { apply };
}
