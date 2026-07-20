/**
 * Reusable uninstall-with-toast hook for marketplace package uninstalls.
 *
 * Wraps `useUninstallPackage` from the marketplace entity and automatically
 * fires sonner toasts at each lifecycle stage:
 *
 * - **Pending**: a loading spinner toast while the HTTP request is in-flight.
 * - **Success**: replaces the loading toast with a success confirmation.
 * - **Error**: replaces the loading toast with an error message.
 *
 * Mirrors `useInstallWithToast`: the toast lifecycle is driven by **per-call
 * mutation callbacks** (not effects), and sonner's `{ id }` option replaces the
 * same toast in-place so the user sees a single loading → success/error
 * transition. Hook state (`isPending`, `variables`, etc.) passes through
 * unchanged, so consumers can still drive per-row spinners and disabled states.
 *
 * @module features/marketplace/model/use-uninstall-with-toast
 */
import { useCallback } from 'react';
import { toast } from 'sonner';

import { humanizePackageName } from '@/layers/shared/lib';
import { useUninstallPackage, type UninstallPackageArgs } from '@/layers/entities/marketplace';
import type { UninstallResult } from '@dorkos/shared/marketplace-schemas';

/**
 * {@link UninstallPackageArgs} plus an optional display-only scope label.
 * `where` names the location being uninstalled from (e.g. an agent's display
 * name) so the toasts read "Uninstalling flow from E2E Test Agent…". It is
 * ignored by the mutation itself — purely presentation, which is why it lives
 * on this feature-layer wrapper and not the entity args.
 */
export type UninstallWithToastArgs = UninstallPackageArgs & { where?: string };

/**
 * Format an uninstall error for a sonner toast message.
 */
function formatUninstallError(err: unknown): string {
  if (err instanceof Error) return `Uninstall failed: ${err.message}`;
  return 'Uninstall failed: unknown error';
}

/** Toast subject: the humanized package name, suffixed with the scope label when given. */
function toastSubject(args: UninstallWithToastArgs): string {
  const label = humanizePackageName(args.name);
  return args.where ? `${label} from ${args.where}` : label;
}

/**
 * Wraps `useUninstallPackage` with automatic sonner toast notifications.
 *
 * Returns the same mutation object as `useUninstallPackage` with `mutate` and
 * `mutateAsync` overridden to fire loading/success/error toasts. All other
 * mutation state (`isPending`, `isSuccess`, `variables`, `error`, etc.) is
 * passed through unchanged, so existing per-row pending logic keeps working.
 *
 * The per-call callbacks run **in addition to** the hook-level `onSuccess`
 * callback in `useUninstallPackage`, so TanStack Query cache invalidation still
 * fires correctly.
 */
export function useUninstallWithToast() {
  const uninstall = useUninstallPackage();
  const { mutate: baseMutate, mutateAsync: baseMutateAsync } = uninstall;

  const mutate = useCallback(
    ({ where, ...args }: UninstallWithToastArgs) => {
      const toastId = toast.loading(`Uninstalling ${toastSubject({ ...args, where })}…`);
      baseMutate(args, {
        onSuccess: () => {
          toast.success(`Uninstalled ${toastSubject({ ...args, where })}`, { id: toastId });
        },
        onError: (err) => {
          toast.error(formatUninstallError(err), { id: toastId });
        },
      });
    },
    [baseMutate]
  );

  const mutateAsync = useCallback(
    async ({ where, ...args }: UninstallWithToastArgs): Promise<UninstallResult> => {
      const toastId = toast.loading(`Uninstalling ${toastSubject({ ...args, where })}…`);
      try {
        const result = await baseMutateAsync(args);
        toast.success(`Uninstalled ${toastSubject({ ...args, where })}`, { id: toastId });
        return result;
      } catch (err) {
        toast.error(formatUninstallError(err), { id: toastId });
        throw err;
      }
    },
    [baseMutateAsync]
  );

  return { ...uninstall, mutate, mutateAsync };
}
