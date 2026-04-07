/**
 * Reusable install-with-toast hook for marketplace package installs.
 *
 * Wraps `useInstallPackage` from the marketplace entity and automatically
 * fires sonner toasts at each lifecycle stage:
 *
 * - **Pending**: a loading spinner toast while the HTTP request is in-flight.
 * - **Success**: replaces the loading toast with a success confirmation.
 * - **Error**: replaces the loading toast with an error message.
 *
 * The toast lifecycle is driven by **per-call mutation callbacks** (not
 * effects). Sonner's `{ id }` option is used to replace the same toast
 * in-place rather than dismiss-then-show, so the user sees a single toast
 * transition from loading → success/error.
 *
 * This avoids the effect-replay and `reset()`-race pitfalls of the previous
 * effect-driven implementation. The hook state (`isPending`, `isSuccess`,
 * etc.) is NOT read or reset inside any effect — consumers that need to
 * react to success (e.g. closing a dialog) should use `mutateAsync` with
 * try/catch in their click handler instead of watching `install.isSuccess`.
 *
 * NOTE: A "Configure secrets" action on the success toast is planned but
 * deferred until the `/settings/secrets` route is registered in `router.tsx`.
 *
 * @module features/marketplace/model/use-install-with-toast
 */
import { useCallback } from 'react';
import { toast } from 'sonner';

import { useInstallPackage, type InstallPackageArgs } from '@/layers/entities/marketplace';
import type { InstallResult } from '@dorkos/shared/marketplace-schemas';

/**
 * Format an install error for a sonner toast message.
 */
function formatInstallError(err: unknown): string {
  if (err instanceof Error) return `Install failed: ${err.message}`;
  return 'Install failed: unknown error';
}

/**
 * Wraps `useInstallPackage` with automatic sonner toast notifications.
 *
 * Returns the same mutation object as `useInstallPackage` with `mutate` and
 * `mutateAsync` overridden to fire loading/success/error toasts. All other
 * mutation state (`isPending`, `isSuccess`, `data`, `error`, etc.) is
 * passed through unchanged.
 *
 * The per-call callbacks run **in addition to** the hook-level `onSuccess`
 * callback in `useInstallPackage`, so TanStack Query cache invalidation
 * still fires correctly.
 *
 * Consumers that need to close a dialog or navigate on success should use
 * `mutateAsync` with try/catch rather than watching `install.isSuccess` in
 * an effect — this keeps control flow explicit and avoids hook-state races.
 *
 * @example
 * ```tsx
 * function InstallButton({ name }: { name: string }) {
 *   const install = useInstallWithToast();
 *
 *   async function handleClick() {
 *     try {
 *       await install.mutateAsync({ name });
 *       // Success path — toast already fired.
 *     } catch {
 *       // Error path — toast already fired.
 *     }
 *   }
 *
 *   return (
 *     <button disabled={install.isPending} onClick={handleClick}>
 *       Install
 *     </button>
 *   );
 * }
 * ```
 */
export function useInstallWithToast() {
  const install = useInstallPackage();
  const { mutate: baseMutate, mutateAsync: baseMutateAsync } = install;

  const mutate = useCallback(
    (args: InstallPackageArgs) => {
      const toastId = toast.loading(`Installing ${args.name}…`);
      baseMutate(args, {
        onSuccess: () => {
          toast.success(`Installed ${args.name}`, { id: toastId });
        },
        onError: (err) => {
          toast.error(formatInstallError(err), { id: toastId });
        },
      });
    },
    [baseMutate]
  );

  const mutateAsync = useCallback(
    async (args: InstallPackageArgs): Promise<InstallResult> => {
      const toastId = toast.loading(`Installing ${args.name}…`);
      try {
        const result = await baseMutateAsync(args);
        toast.success(`Installed ${args.name}`, { id: toastId });
        return result;
      } catch (err) {
        toast.error(formatInstallError(err), { id: toastId });
        throw err;
      }
    },
    [baseMutateAsync]
  );

  return { ...install, mutate, mutateAsync };
}
