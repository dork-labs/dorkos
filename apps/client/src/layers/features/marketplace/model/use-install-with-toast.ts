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

import { humanizePackageName } from '@/layers/shared/lib';
import { useAppStore, useOpenConnections } from '@/layers/shared/model';
import { useInstallPackage, type InstallPackageArgs } from '@/layers/entities/marketplace';
import type { InstallResult } from '@dorkos/shared/marketplace-schemas';
import { adapterBridge } from '../lib/adapter-bridge';

/**
 * Format an install error for a sonner toast message.
 */
function formatInstallError(err: unknown): string {
  if (err instanceof Error) return `Install failed: ${err.message}`;
  return 'Install failed: unknown error';
}

/**
 * The success-toast options for one install. Two package types carry a
 * follow-through action; the rest install to a plain confirmation:
 *
 * - A **Shape** is staged, not activated, so its toast carries an "Apply…"
 *   action that opens the Shape switcher landed on the just-installed Shape
 *   (highlighted, never auto-applied).
 * - An **adapter** just became a Connection, so its toast deep-links to the
 *   matching Connections region — Messaging for a messaging adapter, Accounts
 *   for a connector-refinement one — the seam between the marketplace word
 *   ("adapter") and the user word ("connection"), said out loud (ADR
 *   260804-021140).
 *
 * @param result - The install outcome (its `type` and `adapterType` decide the action).
 * @param toastId - The loading toast id to replace in place.
 * @param goToRegion - Navigates to one of the Connections regions.
 */
function successToastOptions(
  result: InstallResult,
  toastId: string | number,
  goToRegion: (region: 'messaging' | 'accounts') => void
) {
  // An install can land and still leave something undone — most often its npm
  // libraries, which warn rather than fail so the package's own files are not
  // rolled back over a missing npm (DOR-1341). The note has to reach the
  // person, or "Installed" quietly overstates what happened.
  const description = result.warnings.length > 0 ? result.warnings.join(' ') : undefined;
  if (result.type === 'shape') {
    return {
      id: toastId,
      description,
      action: {
        label: 'Apply…',
        onClick: () => useAppStore.getState().openShapeSwitcherToShape(result.packageName),
      },
    };
  }
  const bridge = adapterBridge(result.type, result.manifest?.adapterType);
  if (bridge) {
    return {
      id: toastId,
      description,
      action: {
        label: bridge.region === 'messaging' ? 'Open Messaging' : 'Open Accounts',
        onClick: () => goToRegion(bridge.region),
      },
    };
  }
  return { id: toastId, description };
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
  // Typed `(region) => void` that centralizes the /connections deep-link and
  // no-ops in the router-less Obsidian embed. A region typo fails to compile.
  const goToRegion = useOpenConnections();
  const { mutate: baseMutate, mutateAsync: baseMutateAsync } = install;

  const mutate = useCallback(
    (args: InstallPackageArgs) => {
      const label = humanizePackageName(args.name);
      const toastId = toast.loading(`Installing ${label}…`);
      baseMutate(args, {
        onSuccess: (result) => {
          toast.success(`Installed ${label}`, successToastOptions(result, toastId, goToRegion));
        },
        onError: (err) => {
          toast.error(formatInstallError(err), { id: toastId });
        },
      });
    },
    [baseMutate, goToRegion]
  );

  const mutateAsync = useCallback(
    async (args: InstallPackageArgs): Promise<InstallResult> => {
      const label = humanizePackageName(args.name);
      const toastId = toast.loading(`Installing ${label}…`);
      try {
        const result = await baseMutateAsync(args);
        toast.success(`Installed ${label}`, successToastOptions(result, toastId, goToRegion));
        return result;
      } catch (err) {
        toast.error(formatInstallError(err), { id: toastId });
        throw err;
      }
    },
    [baseMutateAsync, goToRegion]
  );

  return { ...install, mutate, mutateAsync };
}
