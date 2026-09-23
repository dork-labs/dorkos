/**
 * Reusable update-with-toast hook for marketplace package updates.
 *
 * Wraps `useUpdatePackage` from the marketplace entity and automatically fires
 * sonner toasts at each lifecycle stage:
 *
 * - **Pending**: a loading spinner toast while the HTTP request is in-flight.
 * - **Success**: replaces the loading toast with a message that distinguishes
 *   "updated to vX" from "already up to date" using the `UpdateResult` payload.
 *   When the check could not run (status `unknown`: offline, or a new version
 *   that can't be installed), it is a warning that says so and why — never
 *   "already up to date", since nothing was confirmed.
 * - **Error**: replaces the loading toast with an error message.
 *
 * Mirrors `useInstallWithToast`: the toast lifecycle is driven by **per-call
 * mutation callbacks** (not effects), and sonner's `{ id }` option replaces the
 * same toast in-place. Hook state (`isPending`, `variables`, etc.) passes
 * through unchanged, so consumers can still drive per-row spinners.
 *
 * @module features/marketplace/model/use-update-with-toast
 */
import { useCallback } from 'react';
import { toast } from 'sonner';

import { humanizePackageName } from '@/layers/shared/lib';
import { useUpdatePackage, type UpdatePackageArgs } from '@/layers/entities/marketplace';
import type { UpdateResult } from '@dorkos/shared/marketplace-schemas';

/** The toast a finished update request shows: a confirmation, or a warning. */
interface UpdateOutcomeToast {
  kind: 'success' | 'warning';
  message: string;
}

/**
 * Describe a finished update request.
 *
 * When a reinstall was applied, report the new version (e.g. "Updated X to
 * v1.2.0"). When the check for this package could not run, say so and pass on
 * the server's reason as a warning. Otherwise the package was already current,
 * said explicitly so the person knows the click did something even though
 * nothing changed on disk.
 *
 * @param name - The raw package name, to find this package's check.
 * @param label - The humanized package name for display.
 * @param result - The server's update result.
 */
function describeUpdateOutcome(
  name: string,
  label: string,
  result: UpdateResult
): UpdateOutcomeToast {
  const applied = result.applied[0];
  if (applied) {
    return { kind: 'success', message: `Updated ${label} to v${applied.version}` };
  }
  const check = result.checks.find((c) => c.packageName === name) ?? result.checks[0];
  if (check?.status === 'unknown') {
    const why = check.note ? `: ${check.note}` : '';
    return { kind: 'warning', message: `Couldn't check ${label} for updates${why}` };
  }
  return { kind: 'success', message: `${label} is already up to date` };
}

/** Show a finished update's toast in place of the loading one. */
function showUpdateOutcome(outcome: UpdateOutcomeToast, toastId: string | number): void {
  if (outcome.kind === 'warning') {
    toast.warning(outcome.message, { id: toastId });
  } else {
    toast.success(outcome.message, { id: toastId });
  }
}

/**
 * Format an update error for a sonner toast message.
 */
function formatUpdateError(err: unknown): string {
  if (err instanceof Error) return `Update failed: ${err.message}`;
  return 'Update failed: unknown error';
}

/**
 * Wraps `useUpdatePackage` with automatic sonner toast notifications.
 *
 * Returns the same mutation object as `useUpdatePackage` with `mutate` and
 * `mutateAsync` overridden to fire loading/success/error toasts. All other
 * mutation state (`isPending`, `isSuccess`, `variables`, `error`, etc.) is
 * passed through unchanged, so existing per-row pending logic keeps working.
 *
 * The per-call callbacks run **in addition to** the hook-level `onSuccess`
 * callback in `useUpdatePackage`, so TanStack Query cache invalidation still
 * fires correctly.
 */
export function useUpdateWithToast() {
  const update = useUpdatePackage();
  const { mutate: baseMutate, mutateAsync: baseMutateAsync } = update;

  const mutate = useCallback(
    (args: UpdatePackageArgs) => {
      const label = humanizePackageName(args.name);
      const toastId = toast.loading(`Updating ${label}…`);
      baseMutate(args, {
        onSuccess: (result) => {
          showUpdateOutcome(describeUpdateOutcome(args.name, label, result), toastId);
        },
        onError: (err) => {
          toast.error(formatUpdateError(err), { id: toastId });
        },
      });
    },
    [baseMutate]
  );

  const mutateAsync = useCallback(
    async (args: UpdatePackageArgs): Promise<UpdateResult> => {
      const label = humanizePackageName(args.name);
      const toastId = toast.loading(`Updating ${label}…`);
      try {
        const result = await baseMutateAsync(args);
        showUpdateOutcome(describeUpdateOutcome(args.name, label, result), toastId);
        return result;
      } catch (err) {
        toast.error(formatUpdateError(err), { id: toastId });
        throw err;
      }
    },
    [baseMutateAsync]
  );

  return { ...update, mutate, mutateAsync };
}
