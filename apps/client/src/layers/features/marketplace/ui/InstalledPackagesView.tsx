import { useState } from 'react';
import { Trash2, RefreshCw, FolderOpen, Bot, Shapes } from 'lucide-react';
import type { InstalledPackage } from '@dorkos/shared/marketplace-schemas';
import { useInstalledPackages } from '@/layers/entities/marketplace';
import { useShapes } from '@/layers/entities/shapes';
import { Badge, Button } from '@/layers/shared/ui';
import { humanizePackageName } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useUninstallWithToast } from '../model/use-uninstall-with-toast';
import { useUpdateWithToast } from '../model/use-update-with-toast';
import { PackageTypeBadge } from './PackageTypeBadge';
import { PackageLoadingSkeleton } from './PackageLoadingSkeleton';
import { PackageEmptyState } from './PackageEmptyState';
import { PackageErrorState } from './PackageErrorState';

// ---------------------------------------------------------------------------
// Package row sub-component
// ---------------------------------------------------------------------------

/** Display name for an agent-scoped installation's owner. */
function agentLabel(pkg: InstalledPackage): string | null {
  if (pkg.scope !== 'agent-local' && pkg.scope !== 'override') return null;
  return pkg.agentName ?? pkg.agentPath?.split('/').filter(Boolean).pop() ?? 'agent';
}

interface PackageRowProps {
  installation: InstalledPackage;
  /** True when this row is the Shape currently applied — shows an "Active" badge. */
  isActiveShape: boolean;
  isConfirmingUninstall: boolean;
  isUninstalling: boolean;
  isUpdating: boolean;
  /** Open the Shape switcher to apply this Shape (Shapes only). */
  onApplyClick: () => void;
  onUpdateClick: () => void;
  onUninstallClick: () => void;
}

function PackageRow({
  installation,
  isActiveShape,
  isConfirmingUninstall,
  isUninstalling,
  isUpdating,
  onApplyClick,
  onUpdateClick,
  onUninstallClick,
}: PackageRowProps) {
  const { name, version, type, scope, installedFrom, installedAt } = installation;
  const isShape = type === 'shape';
  // The installed record ships only a slug (no `displayName`), so humanize it
  // for the row title and every action label that names the package.
  const displayName = humanizePackageName(name);
  const formattedDate = installedAt
    ? new Date(installedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;
  const agent = agentLabel(installation);

  return (
    <div className="bg-card flex items-center justify-between gap-4 rounded-xl border p-6">
      {/* Left: metadata */}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{displayName}</span>
          <PackageTypeBadge type={type} />
          {isActiveShape && <Badge variant="secondary">Active</Badge>}
          <Badge variant="outline" className="font-mono text-xs">
            v{version}
          </Badge>
          {scope === 'agent-local' && (
            <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-medium text-blue-700 dark:bg-blue-900 dark:text-blue-300">
              Local
            </span>
          )}
          {scope === 'override' && (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-900 dark:text-amber-300">
              Overrides global
            </span>
          )}
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
          {agent && (
            <span className="flex items-center gap-1">
              <Bot className="size-3" aria-hidden />
              {agent}
            </span>
          )}
          {installedFrom && (
            <span className="flex items-center gap-1">
              <FolderOpen className="size-3" aria-hidden />
              {installedFrom}
            </span>
          )}
          {formattedDate && <span>Installed {formattedDate}</span>}
        </div>
      </div>

      {/* Right: actions */}
      <div className="flex shrink-0 items-center gap-2">
        {/* Apply lands the user on this Shape in the switcher. The active Shape
            already reads "Active"; re-apply/reset lives in the switcher, so its
            row shows no Apply — the badge is the state, no redundant button. */}
        {isShape && !isActiveShape && (
          <Button
            size="sm"
            variant="outline"
            onClick={onApplyClick}
            aria-label={`Apply ${displayName}`}
          >
            <Shapes className="mr-1 size-3" aria-hidden />
            Apply…
          </Button>
        )}

        <Button
          size="sm"
          variant="outline"
          onClick={onUpdateClick}
          disabled={isUpdating}
          aria-label={`Check for updates to ${displayName}${agent ? ` on ${agent}` : ''}`}
        >
          <RefreshCw className={`mr-1 size-3 ${isUpdating ? 'animate-spin' : ''}`} aria-hidden />
          {isUpdating ? 'Updating…' : 'Update'}
        </Button>

        <Button
          size="sm"
          variant={isConfirmingUninstall ? 'destructive' : 'ghost'}
          onClick={onUninstallClick}
          disabled={isUninstalling}
          aria-label={
            isConfirmingUninstall
              ? `Confirm uninstall of ${displayName}${agent ? ` from ${agent}` : ''}`
              : `Uninstall ${displayName}${agent ? ` from ${agent}` : ''}`
          }
          className={isConfirmingUninstall ? '' : 'text-destructive hover:text-destructive'}
        >
          <Trash2 className="mr-1 size-3" aria-hidden />
          {isUninstalling ? 'Removing…' : isConfirmingUninstall ? 'Confirm' : 'Uninstall'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Milliseconds a destructive confirm is held open before auto-cancel. */
const CONFIRM_WINDOW_MS = 3_000;

// ---------------------------------------------------------------------------
// InstalledPackagesView
// ---------------------------------------------------------------------------

/**
 * "Manage Installed" surface — lists every installed marketplace package with
 * per-row update and uninstall actions.
 *
 * Update is advisory by default and applies the reinstall when the user clicks
 * the Update button (passes `apply: true`). Uninstall requires a two-click
 * confirmation: the first click opens a 3-second confirm window; a second
 * click within that window fires the mutation with `purge: false` (data is
 * preserved). If the window expires without a second click the row resets
 * silently.
 *
 * Renders loading, error, empty, and populated states via shared primitives
 * (`PackageLoadingSkeleton`, `PackageErrorState`, `PackageEmptyState`).
 */
export function InstalledPackagesView() {
  const { data: installed, isLoading, error, refetch } = useInstalledPackages();
  // Shapes carry an "active" flag; the installed list marks which one is applied
  // and offers Apply on the rest. Reuses the switcher's data (listShapes), no new
  // endpoint. A missing/erroring query just means no Active badge — Apply still shows.
  const { data: shapes } = useShapes();
  const activeShapeName = shapes?.find((s) => s.active)?.name;
  const openShapeSwitcherToShape = useAppStore((s) => s.openShapeSwitcherToShape);
  const uninstall = useUninstallWithToast();
  const update = useUpdateWithToast();

  // Track which installation (by installPath — unique per scope, unlike the
  // package name) is in the confirm-uninstall window.
  const [confirmingPath, setConfirmingPath] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return <PackageLoadingSkeleton count={3} />;
  }

  if (error) {
    return <PackageErrorState error={error} onRetry={() => void refetch()} />;
  }

  if (!installed || installed.length === 0) {
    return (
      <PackageEmptyState
        title="No packages installed"
        description="Browse the marketplace to discover and install your first package."
      />
    );
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleUpdate(pkg: InstalledPackage) {
    update.mutate({
      name: pkg.name,
      options: { apply: true, ...(pkg.agentPath && { projectPath: pkg.agentPath }) },
    });
  }

  function handleUninstallClick(pkg: InstalledPackage) {
    if (confirmingPath === pkg.installPath) {
      // Second click within the window — fire the mutation, scoped to this
      // installation's project when it is agent-local.
      uninstall.mutate({
        name: pkg.name,
        options: { purge: false, ...(pkg.agentPath && { projectPath: pkg.agentPath }) },
        where: agentLabel(pkg) ?? undefined,
      });
      setConfirmingPath(null);
    } else {
      // First click — open the confirm window and schedule auto-cancel.
      setConfirmingPath(pkg.installPath);
      setTimeout(() => {
        setConfirmingPath((current) => (current === pkg.installPath ? null : current));
      }, CONFIRM_WINDOW_MS);
    }
  }

  /** Whether an in-flight mutation's variables target this exact installation. */
  function targetsInstallation(
    variables: { name: string; options?: { projectPath?: string } } | undefined,
    pkg: InstalledPackage
  ): boolean {
    return (
      variables?.name === pkg.name &&
      (variables?.options?.projectPath ?? undefined) === (pkg.agentPath ?? undefined)
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-3" role="list" aria-label="Installed packages">
      {installed.map((pkg) => (
        <div key={pkg.installPath} role="listitem">
          <PackageRow
            installation={pkg}
            isActiveShape={pkg.type === 'shape' && pkg.name === activeShapeName}
            isConfirmingUninstall={confirmingPath === pkg.installPath}
            isUninstalling={uninstall.isPending && targetsInstallation(uninstall.variables, pkg)}
            isUpdating={update.isPending && targetsInstallation(update.variables, pkg)}
            onApplyClick={() => openShapeSwitcherToShape(pkg.name)}
            onUpdateClick={() => handleUpdate(pkg)}
            onUninstallClick={() => handleUninstallClick(pkg)}
          />
        </div>
      ))}
    </div>
  );
}
