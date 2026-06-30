/**
 * Reusable update-with-toast hook for marketplace package updates.
 *
 * Wraps `useUpdatePackage` from the marketplace entity and automatically fires
 * sonner toasts at each lifecycle stage:
 *
 * - **Pending**: a loading spinner toast while the HTTP request is in-flight.
 * - **Success**: replaces the loading toast with a message that distinguishes
 *   "updated to vX" from "already up to date" using the `UpdateResult` payload.
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

import { useUpdatePackage, type UpdatePackageArgs } from '@/layers/entities/marketplace';
import type { UpdateResult } from '@dorkos/shared/marketplace-schemas';

/**
 * Build a success message from an `UpdateResult`.
 *
 * When a reinstall was applied, report the new version (e.g. "Updated X to
 * v1.2.0"). When the package was already current, say so explicitly so the
 * user knows the click did something even though nothing changed on disk.
 */
function formatUpdateSuccess(name: string, result: UpdateResult): string {
  const applied = result.applied[0];
  if (applied) {
    return `Updated ${name} to v${applied.version}`;
  }
  return `${name} is already up to date`;
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
      const toastId = toast.loading(`Updating ${args.name}…`);
      baseMutate(args, {
        onSuccess: (result) => {
          toast.success(formatUpdateSuccess(args.name, result), { id: toastId });
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
      const toastId = toast.loading(`Updating ${args.name}…`);
      try {
        const result = await baseMutateAsync(args);
        toast.success(formatUpdateSuccess(args.name, result), { id: toastId });
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
