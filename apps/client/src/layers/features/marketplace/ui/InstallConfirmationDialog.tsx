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
import type { PackageScope } from '@dorkos/shared/marketplace-schemas';
import { usePermissionPreview, useInstalledPackages } from '@/layers/entities/marketplace';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { AgentPicker } from '@/layers/features/tasks';

import { useMarketplaceStore } from '../model/marketplace-store';
import { useInstallWithToast } from '../model/use-install-with-toast';
import { PermissionPreviewSection } from './PermissionPreviewSection';

/** The two install targets the dialog offers. */
type InstallScope = 'global' | 'agent-local';

/**
 * Whether an installed package's scope tag means it occupies the slot the user
 * is targeting. A `global`/legacy-undefined entry occupies the global slot; an
 * `agent-local`/`override` entry occupies the selected agent's local slot. This
 * keeps a package that is only installed globally from reading as a "reinstall"
 * when the user targets a specific agent (where it is actually absent).
 */
function occupiesScope(pkgScope: PackageScope | undefined, target: InstallScope): boolean {
  if (target === 'global') {
    return pkgScope === undefined || pkgScope === 'global';
  }
  return pkgScope === 'agent-local' || pkgScope === 'override';
}

/**
 * Compute the install button's label from mutation and conflict state. Hoisted
 * out of the JSX to keep the render free of nested ternaries.
 */
function computeInstallButtonLabel(state: {
  isPending: boolean;
  isReinstall: boolean;
  hasBlockingConflicts: boolean;
}): string {
  if (state.isPending) {
    return state.isReinstall ? 'Reinstalling…' : 'Installing…';
  }
  if (state.hasBlockingConflicts) {
    return 'Cannot install — conflicts detected';
  }
  return state.isReinstall ? 'Reinstall' : 'Install';
}

/**
 * Marketplace install confirmation dialog.
 *
 * Opens when `useMarketplaceStore.installConfirmPackage` is non-null. Fetches
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
  const pkg = useMarketplaceStore((s) => s.installConfirmPackage);
  const installContext = useMarketplaceStore((s) => s.installContext);
  const close = useMarketplaceStore((s) => s.closeInstallConfirm);

  const install = useInstallWithToast();
  const { data: agentsData } = useMeshAgentPaths();
  const agents = agentsData?.agents ?? [];

  // Shapes are global-only by design (a Shape rearranges the whole cockpit, a
  // person-scoped concept — see install-shape.ts) — the server silently
  // ignores `projectPath` for them. The dialog must not offer a scope choice
  // it can't honor.
  const isShape = pkg?.type === 'shape';

  // Context-aware scope default: agent-local when opened from agent hub, global otherwise.
  const [installScope, setInstallScope] = useState<InstallScope>(
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

  // The scope actually in effect. Shapes are pinned to 'global' regardless of
  // `installScope` state — which may carry a stale 'agent-local' selection
  // left over from a prior, non-shape package — so a leftover choice can never
  // leak a `projectPath` into a shape install.
  const effectiveScope: InstallScope = isShape ? 'global' : installScope;

  // The project path of the currently-selected scope. Global → undefined; a
  // specific agent → that agent's project path. Everything scope-sensitive
  // (preview, conflicts, reinstall detection) is computed against this so the
  // dialog reflects the ACTUAL install target, not always the global scope.
  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const selectedProjectPath =
    effectiveScope === 'agent-local' ? selectedAgent?.projectPath : undefined;

  // "Specific agent" chosen but no agent picked yet: the install target is
  // undetermined, so there is nothing truthful to preview — a fetch here would
  // show the GLOBAL scope's effects and conflicts for a non-global install.
  const needsAgent = effectiveScope === 'agent-local' && !selectedAgentId;

  const { data: detail, isLoading: previewLoading } = usePermissionPreview(pkg?.name ?? null, {
    enabled: pkg !== null && !needsAgent,
    ...(selectedProjectPath ? { projectPath: selectedProjectPath } : {}),
  });

  const preview = needsAgent ? null : (detail?.preview ?? null);

  // Block install if any conflict carries error severity.
  const hasBlockingConflicts =
    preview !== null && preview.conflicts.some((c) => c.level === 'error');

  // Is the package already installed at the SELECTED scope? A reinstall means the
  // same package occupies this exact slot (a true replace) — not that it shadows a
  // different scope. Derive it from the installed list, matching the scope tag to
  // the selected target, never from a `package-name` conflict (which also fires for
  // cross-scope shadowing). Agent-local scope: an `agent-local`/`override` entry is a
  // real slot occupant; a `global`-tagged entry in the merged list is not. Global
  // scope: only a `global` (or legacy-undefined) entry counts. With no agent
  // selected the target slot is unknown — and the scope-less list spans EVERY
  // agent, where some other agent's local install must not read as a reinstall.
  const { data: installedPackages } = useInstalledPackages(selectedProjectPath);
  const isReinstall =
    !needsAgent &&
    (installedPackages ?? []).some(
      (p) => p.name === pkg?.name && occupiesScope(p.scope, effectiveScope)
    );

  const installDisabled =
    install.isPending || previewLoading || hasBlockingConflicts || pkg === null || needsAgent;

  const buttonLabel = computeInstallButtonLabel({
    isPending: install.isPending,
    isReinstall,
    hasBlockingConflicts,
  });

  async function handleInstall() {
    if (!pkg) return;
    try {
      const opts = selectedProjectPath ? { projectPath: selectedProjectPath } : undefined;
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

            {/* Scope selector — outside scroll area so AgentPicker dropdown isn't clipped.
                Shapes are global-only, so no scope choice is offered for them (a
                choice the server would silently ignore is worse than no choice). */}
            <div className="shrink-0 space-y-2 px-4 sm:px-6">
              {isShape ? (
                <p className="text-muted-foreground text-sm">
                  Shapes set up your whole cockpit, so they install once for you — not per agent.
                </p>
              ) : (
                <>
                  <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
                    Install for
                  </div>
                  <RadioGroup
                    value={installScope}
                    onValueChange={(v) => {
                      setInstallScope(v as InstallScope);
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
                </>
              )}
            </div>

            {/* Permission preview — scrolls independently */}
            <ResponsiveDialogBody className="mt-4">
              {needsAgent && (
                <p className="text-muted-foreground text-sm">
                  Select an agent to preview what this install will do.
                </p>
              )}
              {previewLoading && <p className="text-muted-foreground text-sm">Loading preview…</p>}
              {preview && <PermissionPreviewSection preview={preview} />}
            </ResponsiveDialogBody>

            <ResponsiveDialogFooter className="shrink-0">
              <Button variant="ghost" onClick={close} disabled={install.isPending}>
                Cancel
              </Button>
              <Button onClick={handleInstall} disabled={installDisabled}>
                {buttonLabel}
              </Button>
            </ResponsiveDialogFooter>
          </>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
