/**
 * Blocking modal confirmation before a marketplace install. Shows the full
 * permission preview and requires an explicit "Install" click. Calls the
 * install mutation on confirm and closes on success via `mutateAsync` +
 * try/catch — toasts fire inside `useInstallWithToast`.
 *
 * @module features/marketplace/ui/InstallConfirmationDialog
 */
import { useState, useEffect } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
  const installContext = useDorkHubStore((s) => s.installContext);
  const close = useDorkHubStore((s) => s.closeInstallConfirm);

  const install = useInstallWithToast();

  // Context-aware scope default: agent-local when opened from agent hub, global otherwise.
  const [installScope, setInstallScope] = useState<'global' | 'agent-local'>(
    installContext ? 'agent-local' : 'global'
  );

  // Reset scope when dialog opens with new context.
  useEffect(() => {
    setInstallScope(installContext ? 'agent-local' : 'global');
  }, [installContext]);

  const { data: detail, isLoading: previewLoading } = usePermissionPreview(pkg?.name ?? null, {
    enabled: pkg !== null,
  });

  const preview = detail?.preview ?? null;

  // Block install if any conflict carries error severity.
  const hasBlockingConflicts =
    preview !== null && preview.conflicts.some((c) => c.level === 'error');

  const installDisabled =
    install.isPending || previewLoading || hasBlockingConflicts || pkg === null;

  async function handleInstall() {
    if (!pkg) return;
    try {
      const opts =
        installScope === 'agent-local' && installContext
          ? { projectPath: installContext.agentPath }
          : undefined;
      await install.mutateAsync({ name: pkg.name, options: opts });
      close();
    } catch {
      // Error — toast already fired. Leave the dialog open so the user can retry.
    }
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

            <div className="my-4 space-y-4">
              {/* Scope selector — only shows agent-local option when context is set */}
              <div className="space-y-1">
                <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
                  Install for
                </div>
                <Select
                  value={installScope}
                  onValueChange={(v) => setInstallScope(v as 'global' | 'agent-local')}
                >
                  <SelectTrigger className="h-8 text-sm" responsive={false}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global" responsive={false}>
                      All agents (global)
                    </SelectItem>
                    {installContext && (
                      <SelectItem value="agent-local" responsive={false}>
                        {installContext.agentName} (local)
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>

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
