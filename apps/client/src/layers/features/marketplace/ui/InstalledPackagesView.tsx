import { useState } from 'react';
import { Trash2, RefreshCw, FolderOpen } from 'lucide-react';
import {
  useInstalledPackages,
  useUninstallPackage,
  useUpdatePackage,
} from '@/layers/entities/marketplace';
import { Badge, Button } from '@/layers/shared/ui';
import { PackageTypeBadge } from './PackageTypeBadge';
import { PackageLoadingSkeleton } from './PackageLoadingSkeleton';
import { PackageEmptyState } from './PackageEmptyState';
import { PackageErrorState } from './PackageErrorState';

// ---------------------------------------------------------------------------
// Package row sub-component
// ---------------------------------------------------------------------------

interface PackageRowProps {
  name: string;
  version: string;
  type: import('@dorkos/shared/marketplace-schemas').MarketplacePackageType;
  installedFrom?: string;
  installedAt?: string;
  isConfirmingUninstall: boolean;
  isUninstalling: boolean;
  isUpdating: boolean;
  onUpdateClick: () => void;
  onUninstallClick: () => void;
}

function PackageRow({
  name,
  version,
  type,
  installedFrom,
  installedAt,
  isConfirmingUninstall,
  isUninstalling,
  isUpdating,
  onUpdateClick,
  onUninstallClick,
}: PackageRowProps) {
  const formattedDate = installedAt
    ? new Date(installedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;

  return (
    <div className="bg-card flex items-center justify-between gap-4 rounded-xl border p-6">
      {/* Left: metadata */}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{name}</span>
          <PackageTypeBadge type={type} />
          <Badge variant="outline" className="font-mono text-xs">
            v{version}
          </Badge>
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
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
        <Button
          size="sm"
          variant="outline"
          onClick={onUpdateClick}
          disabled={isUpdating}
          aria-label={`Check for updates to ${name}`}
        >
          <RefreshCw className={`mr-1 size-3 ${isUpdating ? 'animate-spin' : ''}`} aria-hidden />
          {isUpdating ? 'Updating…' : 'Update'}
        </Button>

        <Button
          size="sm"
          variant={isConfirmingUninstall ? 'destructive' : 'ghost'}
          onClick={onUninstallClick}
          disabled={isUninstalling}
          aria-label={isConfirmingUninstall ? `Confirm uninstall of ${name}` : `Uninstall ${name}`}
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
  const uninstall = useUninstallPackage();
  const update = useUpdatePackage();

  // Track which package name is in the confirm-uninstall window.
  const [confirmingName, setConfirmingName] = useState<string | null>(null);

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

  function handleUpdate(name: string) {
    update.mutate({ name, options: { apply: true } });
  }

  function handleUninstallClick(name: string) {
    if (confirmingName === name) {
      // Second click within the window — fire the mutation.
      uninstall.mutate({ name, options: { purge: false } });
      setConfirmingName(null);
    } else {
      // First click — open the confirm window and schedule auto-cancel.
      setConfirmingName(name);
      setTimeout(() => {
        setConfirmingName((current) => (current === name ? null : current));
      }, CONFIRM_WINDOW_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-3" role="list" aria-label="Installed packages">
      {installed.map((pkg) => (
        <div key={pkg.name} role="listitem">
          <PackageRow
            name={pkg.name}
            version={pkg.version}
            type={pkg.type}
            installedFrom={pkg.installedFrom}
            installedAt={pkg.installedAt}
            isConfirmingUninstall={confirmingName === pkg.name}
            isUninstalling={uninstall.isPending && uninstall.variables?.name === pkg.name}
            isUpdating={update.isPending && update.variables?.name === pkg.name}
            onUpdateClick={() => handleUpdate(pkg.name)}
            onUninstallClick={() => handleUninstallClick(pkg.name)}
          />
        </div>
      ))}
    </div>
  );
}
