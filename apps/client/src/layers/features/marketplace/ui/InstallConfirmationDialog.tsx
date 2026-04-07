/**
 * Blocking modal confirmation before a marketplace install. Shows the full
 * permission preview and requires an explicit "Install" click. Calls the
 * install mutation on confirm, fires a toast on success or failure, then
 * resets the mutation state to prevent duplicate toasts on re-render.
 *
 * @module features/marketplace/ui/InstallConfirmationDialog
 */
import { useEffect } from 'react';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  Button,
} from '@/layers/shared/ui';
import { usePermissionPreview } from '@/layers/entities/marketplace';

import { useDorkHubStore } from '../model/dork-hub-store';
import { useInstallWithToast } from '../model/use-install-with-toast';
import { PermissionPreviewSection } from './PermissionPreviewSection';

/**
 * Marketplace install confirmation dialog.
 *
 * Opens when `useDorkHubStore.installConfirmPackage` is non-null. Fetches
 * the permission preview for the pending package, surfaces all effects in
 * a `PermissionPreviewSection`, and enables the Install button only when:
 *
 * - The preview has finished loading, **and**
 * - There are no error-level conflicts, **and**
 * - The install mutation is not already in-flight.
 *
 * Fires a sonner toast on success or failure via `useInstallWithToast` and
 * resets mutation state immediately after to prevent duplicate notifications.
 */
export function InstallConfirmationDialog() {
  const pkg = useDorkHubStore((s) => s.installConfirmPackage);
  const close = useDorkHubStore((s) => s.closeInstallConfirm);

  const install = useInstallWithToast();

  const { data: detail, isLoading: previewLoading } = usePermissionPreview(pkg?.name ?? null, {
    enabled: pkg !== null,
  });

  const preview = detail?.preview ?? null;

  // Block install if any conflict carries error severity.
  const hasBlockingConflicts =
    preview !== null && preview.conflicts.some((c) => c.level === 'error');

  const installDisabled =
    install.isPending || previewLoading || hasBlockingConflicts || pkg === null;

  // Close dialog on successful install (the toast fires inside useInstallWithToast).
  useEffect(() => {
    if (install.isSuccess) close();
  }, [install.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleInstall() {
    if (!pkg) return;
    install.mutate({ name: pkg.name });
  }

  function handleOpenChange(open: boolean) {
    if (!open) close();
  }

  return (
    <AlertDialog open={pkg !== null} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {pkg && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Install {pkg.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Review what this package will do before installing. This action cannot be undone
                without running an uninstall.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="my-4">
              {previewLoading && <p className="text-muted-foreground text-sm">Loading preview…</p>}
              {preview && <PermissionPreviewSection preview={preview} />}
            </div>

            <AlertDialogFooter>
              <Button variant="ghost" onClick={close} disabled={install.isPending}>
                Cancel
              </Button>
              <Button onClick={handleInstall} disabled={installDisabled}>
                {install.isPending
                  ? 'Installing…'
                  : hasBlockingConflicts
                    ? 'Cannot install — conflicts detected'
                    : 'Install'}
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
