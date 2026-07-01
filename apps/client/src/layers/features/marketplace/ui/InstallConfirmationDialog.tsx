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
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogBody,
  Button,
  Label,
  RadioGroup,
  RadioGroupItem,
} from '@/layers/shared/ui';
import { usePermissionPreview } from '@/layers/entities/marketplace';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { AgentPicker } from '@/layers/features/tasks';

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
 * Renders as a centered dialog on desktop and a bottom drawer on mobile.
 *
 * Fires a sonner toast on success or failure via `useInstallWithToast` and
 * resets mutation state immediately after to prevent duplicate notifications.
 */
export function InstallConfirmationDialog() {
  const pkg = useDorkHubStore((s) => s.installConfirmPackage);
  const installContext = useDorkHubStore((s) => s.installContext);
  const close = useDorkHubStore((s) => s.closeInstallConfirm);

  const install = useInstallWithToast();
  const { data: agentsData } = useMeshAgentPaths();
  const agents = agentsData?.agents ?? [];

  // Context-aware scope default: agent-local when opened from agent hub, global otherwise.
  const [installScope, setInstallScope] = useState<'global' | 'agent-local'>(
    installContext ? 'agent-local' : 'global'
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined);

  // Reset scope and pre-select agent when dialog opens with new context.
  useEffect(() => {
    if (installContext) {
      setInstallScope('agent-local');
      const match = agents.find((a) => a.projectPath === installContext.agentPath);
      setSelectedAgentId(match?.id);
    } else {
      setInstallScope('global');
      setSelectedAgentId(undefined);
    }
  }, [installContext, agents]);

  const { data: detail, isLoading: previewLoading } = usePermissionPreview(pkg?.name ?? null, {
    enabled: pkg !== null,
  });

  const preview = detail?.preview ?? null;

  // Block install if any conflict carries error severity.
  const hasBlockingConflicts =
    preview !== null && preview.conflicts.some((c) => c.level === 'error');

  // A same-name package already occupies the target slot — the detector surfaces
  // this as a non-blocking `package-name` warning (ADR-0304). Reframe the action
  // as a reinstall rather than a first-time install.
  const isReinstall = preview !== null && preview.conflicts.some((c) => c.type === 'package-name');

  const needsAgent = installScope === 'agent-local' && !selectedAgentId;

  const installDisabled =
    install.isPending || previewLoading || hasBlockingConflicts || pkg === null || needsAgent;

  async function handleInstall() {
    if (!pkg) return;
    try {
      const selectedAgent = agents.find((a) => a.id === selectedAgentId);
      const opts =
        installScope === 'agent-local' && selectedAgent
          ? { projectPath: selectedAgent.projectPath }
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
    <ResponsiveDialog open={pkg !== null} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent className="max-h-[85vh] !min-h-0 sm:max-w-2xl">
        {pkg && (
          <>
            <ResponsiveDialogHeader className="shrink-0">
              <ResponsiveDialogTitle>
                {isReinstall ? 'Reinstall' : 'Install'} {pkg.name}?
              </ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                {isReinstall
                  ? 'Reinstalling replaces the existing installation at this scope. Review what this package will do below.'
                  : 'Review what this package will do before installing. This action cannot be undone without running an uninstall.'}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>

            {/* Scope selector — outside scroll area so AgentPicker dropdown isn't clipped */}
            <div className="shrink-0 space-y-2 px-4 sm:px-6">
              <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
                Install for
              </div>
              <RadioGroup
                value={installScope}
                onValueChange={(v) => {
                  setInstallScope(v as 'global' | 'agent-local');
                  if (v === 'global') setSelectedAgentId(undefined);
                }}
                className="gap-2"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="global" id="scope-global" />
                  <Label htmlFor="scope-global" className="text-sm font-normal">
                    All agents (global)
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="agent-local" id="scope-agent" />
                  <Label htmlFor="scope-agent" className="text-sm font-normal">
                    Specific agent
                  </Label>
                </div>
              </RadioGroup>

              {installScope === 'agent-local' && (
                <div className="pl-6">
                  <AgentPicker
                    agents={agents}
                    value={selectedAgentId}
                    onValueChange={setSelectedAgentId}
                  />
                </div>
              )}
            </div>

            {/* Permission preview — scrolls independently */}
            <ResponsiveDialogBody className="mt-4">
              {previewLoading && <p className="text-muted-foreground text-sm">Loading preview…</p>}
              {preview && <PermissionPreviewSection preview={preview} />}
            </ResponsiveDialogBody>

            <ResponsiveDialogFooter className="shrink-0">
              <Button variant="ghost" onClick={close} disabled={install.isPending}>
                Cancel
              </Button>
              <Button onClick={handleInstall} disabled={installDisabled}>
                {install.isPending
                  ? isReinstall
                    ? 'Reinstalling…'
                    : 'Installing…'
                  : hasBlockingConflicts
                    ? 'Cannot install — conflicts detected'
                    : isReinstall
                      ? 'Reinstall'
                      : 'Install'}
              </Button>
            </ResponsiveDialogFooter>
          </>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
