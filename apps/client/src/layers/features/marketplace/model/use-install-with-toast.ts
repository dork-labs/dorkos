/**
 * Reusable install-with-toast hook for marketplace package installs.
 *
 * Wraps `useInstallPackage` from the marketplace entity and automatically
 * fires sonner toasts at each lifecycle stage:
 *
 * - **Pending**: a loading spinner toast while the HTTP request is in-flight.
 * - **Success**: a success toast with a "Configure secrets" action that deep-
 *   links the user to the secrets settings panel for the installed package.
 * - **Error**: an error toast showing the failure message.
 *
 * Mutation state is reset immediately after the success/error toast fires to
 * prevent the same notification from appearing again on re-render.
 *
 * @module features/marketplace/model/use-install-with-toast
 */
import { useEffect } from 'react';
import { toast } from 'sonner';

import { useInstallPackage } from '@/layers/entities/marketplace';

/**
 * Wraps `useInstallPackage` with automatic sonner toast notifications.
 *
 * Returns the same mutation object as `useInstallPackage` so call sites can
 * drop-in replace the bare hook without changing how they call `mutate`.
 *
 * @example
 * ```tsx
 * function InstallButton({ name }: { name: string }) {
 *   const install = useInstallWithToast();
 *   return (
 *     <button
 *       disabled={install.isPending}
 *       onClick={() => install.mutate({ name })}
 *     >
 *       Install
 *     </button>
 *   );
 * }
 * ```
 */
export function useInstallWithToast() {
  const install = useInstallPackage();

  // Show a loading toast while the mutation is in-flight and dismiss it when
  // it settles. The cleanup function dismisses the toast if the component
  // unmounts mid-install.
  useEffect(() => {
    if (!install.isPending || !install.variables) return;

    const name = install.variables.name;
    const toastId = toast.loading(`Installing ${name}...`);

    return () => {
      toast.dismiss(toastId);
    };
  }, [install.isPending, install.variables]);

  // Fire success/error toast once per settlement, then reset so re-renders
  // don't replay the notification.
  useEffect(() => {
    if (install.isSuccess && install.variables) {
      const name = install.variables.name;

      toast.success(`Installed ${name}`, {
        action: {
          label: 'Configure secrets',
          onClick: () => {
            // TODO: replace with typed navigate({ to: '/settings/secrets', ... }) once
            // the /settings/secrets route is registered in router.tsx.
            window.location.hash = `#/settings/secrets?package=${encodeURIComponent(name)}`;
          },
        },
      });

      install.reset();
    }
  }, [install.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (install.isError) {
      toast.error(
        install.error instanceof Error
          ? `Install failed: ${install.error.message}`
          : 'Install failed: unknown error'
      );

      install.reset();
    }
  }, [install.isError]); // eslint-disable-line react-hooks/exhaustive-deps

  return install;
}
