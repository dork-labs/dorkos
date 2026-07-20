/**
 * Slide-in detail sheet shown when the user clicks a package card in the Marketplace.
 *
 * Reads the currently-open package from the URL (`?pkg=<name>` via
 * `useMarketplaceParams`) and resolves it against the cached catalog. When a
 * package is set, it fetches the full manifest via `useMarketplacePackage`. If
 * the package is not installed it shows a fresh permission preview via
 * `usePermissionPreview` and an Install action. If it IS installed it shows an
 * installations panel — one row per scope the package occupies (globally
 * and/or per agent, via `usePackageInstallations`) with row-level Reinstall
 * and Uninstall — plus an "Install…" footer action for adding another scope.
 * Reinstall delegates to the install confirmation dialog via
 * `openInstallConfirm`, pre-scoped to the row's agent.
 *
 * @module features/marketplace/ui/PackageDetailSheet
 */
import { useEffect, useState } from 'react';
import {
  Bot,
  Check,
  ExternalLink,
  FolderOpen,
  Globe,
  Puzzle,
  RefreshCw,
  Scale,
  Trash2,
  User,
} from 'lucide-react';
import type { InstalledPackage, PackageProvides } from '@dorkos/shared/marketplace-schemas';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Button,
  Badge,
  Skeleton,
  MarkdownContent,
} from '@/layers/shared/ui';
import {
  useMarketplacePackage,
  useMarketplacePackages,
  usePermissionPreview,
  useInstalledPackages,
  usePackageInstallations,
} from '@/layers/entities/marketplace';
import { useRequestInstall } from '../model/use-request-install';
import { useMarketplaceParams } from '../model/use-marketplace-params';
import { useUninstallWithToast } from '../model/use-uninstall-with-toast';
import { PackageTypeBadge } from './PackageTypeBadge';
import { PermissionPreviewSection } from './PermissionPreviewSection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a renderable author string. CC plugin.json manifests can pass
 * through npm-style objects like `{ name: "...", email: "..." }`.
 */
function resolveAuthorLabel(author: unknown): string | undefined {
  if (typeof author === 'string') return author;
  if (author && typeof author === 'object' && 'name' in author) {
    return String((author as { name: unknown }).name);
  }
  return undefined;
}

/** Whether an installation occupies the global scope. */
function isGlobalInstallation(installation: InstalledPackage): boolean {
  return installation.scope === undefined || installation.scope === 'global';
}

/** Display title for an installation row. */
function installationTitle(installation: InstalledPackage): string {
  if (isGlobalInstallation(installation)) return 'All agents (global)';
  return (
    installation.agentName ??
    installation.agentPath?.split('/').filter(Boolean).pop() ??
    'This agent'
  );
}

/** Join capability counts into a "3 commands · 2 skills · hooks" string, or null when empty. */
function formatProvides(provides: PackageProvides | undefined): string | null {
  if (!provides) return null;
  const parts: string[] = [];
  if (provides.commands > 0)
    parts.push(`${provides.commands} command${provides.commands === 1 ? '' : 's'}`);
  if (provides.skills > 0)
    parts.push(`${provides.skills} skill${provides.skills === 1 ? '' : 's'}`);
  if (provides.hooks) parts.push('hooks');
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Milliseconds a destructive uninstall confirm is held open before auto-cancel. */
const CONFIRM_WINDOW_MS = 3_000;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Loading skeleton for the detail body. */
function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-20 w-full rounded-lg" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

/** A small metadata chip with icon + label. */
function MetaChip({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-muted/50 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs">
      <Icon className="text-muted-foreground size-3 shrink-0" aria-hidden />
      <span className="truncate">{children}</span>
    </div>
  );
}

/** One installation of the package — its scope, version, date, and actions. */
function InstallationRow({
  installation,
  isRemoving,
  isConfirmingUninstall,
  disabled,
  onReinstall,
  onUninstallClick,
}: {
  installation: InstalledPackage;
  isRemoving: boolean;
  isConfirmingUninstall: boolean;
  disabled: boolean;
  onReinstall: () => void;
  onUninstallClick: () => void;
}) {
  const isGlobal = isGlobalInstallation(installation);
  const title = installationTitle(installation);
  const ScopeIcon = isGlobal ? Globe : Bot;
  const installedDate = installation.installedAt
    ? new Date(installation.installedAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <ScopeIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{title}</span>
            {installation.scope === 'override' && (
              <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                Overrides global
              </span>
            )}
          </div>
          <div className="text-muted-foreground text-xs">
            v{installation.version}
            {installedDate && ` · ${installedDate}`}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={onReinstall}
          aria-label={`Reinstall for ${title}`}
        >
          <RefreshCw className="mr-1 size-3" aria-hidden />
          Reinstall
        </Button>
        <Button
          size="sm"
          variant={isConfirmingUninstall ? 'destructive' : 'ghost'}
          disabled={disabled}
          onClick={onUninstallClick}
          aria-label={
            isConfirmingUninstall ? `Confirm uninstall for ${title}` : `Uninstall for ${title}`
          }
          className={isConfirmingUninstall ? '' : 'text-destructive hover:text-destructive'}
        >
          <Trash2 className="mr-1 size-3" aria-hidden />
          {isRemoving ? 'Removing…' : isConfirmingUninstall ? 'Confirm' : 'Uninstall'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Installed-state panel: one row per installation (global and/or per agent),
 * each with Reinstall and two-click-confirm Uninstall, plus a provenance and
 * capability summary underneath.
 */
function InstallationsPanel({
  installations,
  uninstallPendingFor,
  anyMutationPending,
  onReinstall,
  onUninstall,
}: {
  installations: InstalledPackage[];
  /** installPath of the installation whose uninstall is in flight, if any. */
  uninstallPendingFor: string | null;
  anyMutationPending: boolean;
  onReinstall: (installation: InstalledPackage) => void;
  onUninstall: (installation: InstalledPackage) => void;
}) {
  const [confirmingPath, setConfirmingPath] = useState<string | null>(null);

  function handleUninstallClick(installation: InstalledPackage) {
    if (confirmingPath === installation.installPath) {
      setConfirmingPath(null);
      onUninstall(installation);
    } else {
      setConfirmingPath(installation.installPath);
      setTimeout(() => {
        setConfirmingPath((current) => (current === installation.installPath ? null : current));
      }, CONFIRM_WINDOW_MS);
    }
  }

  // Shapes provide a workspace layout, agents, and schedules rather than
  // commands/skills/hooks, so their capability counts read as empty. Fall back
  // to a Shape-appropriate descriptor so the panel says something honest
  // instead of dropping the "Provides" line entirely.
  const isShape = installations.some((i) => i.type === 'shape');
  const providesLine =
    formatProvides(installations.find((i) => i.provides)?.provides) ??
    (isShape ? 'a workspace layout, agents, and schedules' : null);
  const installedFrom = installations.find((i) => i.installedFrom)?.installedFrom;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
        <Check className="size-4 shrink-0" aria-hidden />
        {installations.length === 1
          ? 'Installed'
          : `Installed in ${installations.length} locations`}
      </div>

      <div className="space-y-2" role="list" aria-label="Installations">
        {installations.map((installation) => (
          <div key={installation.installPath} role="listitem">
            <InstallationRow
              installation={installation}
              isRemoving={uninstallPendingFor === installation.installPath}
              isConfirmingUninstall={confirmingPath === installation.installPath}
              disabled={anyMutationPending}
              onReinstall={() => onReinstall(installation)}
              onUninstallClick={() => handleUninstallClick(installation)}
            />
          </div>
        ))}
      </div>

      <dl className="text-muted-foreground space-y-1.5 text-xs">
        {installedFrom && (
          <div className="flex items-center gap-1.5">
            <FolderOpen className="size-3 shrink-0" aria-hidden />
            <span>from {installedFrom}</span>
          </div>
        )}
        {providesLine && (
          <div className="flex items-center gap-1.5">
            <Puzzle className="size-3 shrink-0" aria-hidden />
            <span>Provides {providesLine}</span>
          </div>
        )}
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * Slide-over detail sheet for a single marketplace package.
 *
 * Opens automatically when the URL `pkg` param resolves to a package in the
 * catalog. Closing the sheet (ESC, backdrop click, or the Close button) clears
 * the `pkg` param via `closeDetail()`.
 */
export function PackageDetailSheet() {
  const { selectedPackageName, closeDetail } = useMarketplaceParams();
  const requestInstall = useRequestInstall();

  // Resolve the open package from the cached catalog by its URL `pkg` name. On a
  // fresh deep link the list may still be loading (pkg stays null → the sheet
  // opens once it resolves); an unknown or removed name clears the param.
  const { data: packages } = useMarketplacePackages();
  const pkg = selectedPackageName
    ? ((packages ?? []).find((p) => p.name === selectedPackageName) ?? null)
    : null;

  useEffect(() => {
    if (selectedPackageName && packages && !packages.some((p) => p.name === selectedPackageName)) {
      closeDetail();
    }
  }, [selectedPackageName, packages, closeDetail]);

  const enabled = pkg !== null;
  const packageName = pkg?.name ?? null;

  const { data: detail, isLoading: isDetailLoading } = useMarketplacePackage(packageName, {
    enabled,
  });

  // The cross-scope installed list carries one entry per installation (global
  // and per agent), so filtering by name yields every scope this package
  // occupies — enough to render the installations panel immediately.
  const { data: installed, isLoading: isInstalledListLoading } = useInstalledPackages();
  const installedEntries = pkg !== null ? (installed ?? []).filter((p) => p.name === pkg.name) : [];
  const isInstalled = installedEntries.length > 0;

  // Enriched per-installation records (adds `provides` capability counts). The
  // panel falls back to the list entries — which already carry scope, agent
  // identity, and dates — so it never blocks on this fetch. Skip the permission
  // preview for an installed package, and hold it until the installed list has
  // loaded so a still-loading list can't briefly fire a preview that is then
  // discarded.
  const { data: installations } = usePackageInstallations(packageName, { enabled: isInstalled });
  const { data: previewDetail, isLoading: isPreviewLoading } = usePermissionPreview(packageName, {
    enabled: enabled && !isInstalled && !isInstalledListLoading,
  });

  const uninstall = useUninstallWithToast();

  // While the installed list is still loading the install-state is unknown, so
  // the body must not pick a render branch yet: `isInstalled` is `false` during
  // that window and `permissionPreview` still surfaces `detail.preview`, which
  // would briefly flash the install preview (or "No special permissions
  // required") before flipping to the installations panel. Fold the
  // list-loading state into `isLoading` so the body holds the skeleton until we
  // know whether the package is installed.
  const isInstallStateUnknown = enabled && isInstalledListLoading;
  const isLoading = isDetailLoading || isPreviewLoading || isInstallStateUnknown;
  const permissionPreview = previewDetail?.preview ?? detail?.preview;

  const authorLabel = resolveAuthorLabel(detail?.manifest.author ?? pkg?.author);
  const version = detail?.manifest.version;
  const license = detail?.manifest.license;
  const homepage = pkg?.homepage;
  const marketplace = pkg?.marketplace;

  function handleReinstall(installation: InstalledPackage) {
    if (!pkg) return;
    // An agent row pre-scopes the confirm dialog to that agent; the global row
    // opens it at the default global scope. An agent PACKAGE never reinstalls
    // over an existing agent — `requestInstall` routes it to a fresh creation
    // instead, so the scope here only ever reaches non-agent packages.
    requestInstall(
      pkg,
      installation.agentPath
        ? { agentPath: installation.agentPath, agentName: installationTitle(installation) }
        : undefined
    );
  }

  function handleUninstall(installation: InstalledPackage) {
    if (!pkg) return;
    uninstall.mutate({
      name: pkg.name,
      options: installation.agentPath ? { projectPath: installation.agentPath } : undefined,
      where: installation.agentPath ? installationTitle(installation) : undefined,
    });
  }

  const uninstallPendingFor =
    uninstall.isPending && uninstall.variables
      ? (installedEntries.find(
          (i) => (i.agentPath ?? undefined) === uninstall.variables?.options?.projectPath
        )?.installPath ?? null)
      : null;

  return (
    <Sheet open={pkg !== null} onOpenChange={(open) => !open && closeDetail()}>
      <SheetContent side="right" className="flex w-full flex-col overflow-hidden sm:max-w-xl">
        {pkg && (
          <>
            {/* Hero header */}
            <SheetHeader className="shrink-0 space-y-4 border-b pb-6">
              {/* pr-8 clears the absolute top-right Sheet close (X) button so the type badge doesn't overlap it */}
              <div className="flex items-start gap-4 pr-8">
                {/* Large icon */}
                <div className="bg-muted flex size-14 shrink-0 items-center justify-center rounded-xl text-3xl">
                  {pkg.icon ?? '📦'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <SheetTitle className="text-lg">{pkg.name}</SheetTitle>
                    <PackageTypeBadge type={pkg.type ?? 'plugin'} className="shrink-0" />
                  </div>
                  {pkg.description && (
                    <SheetDescription className="mt-1.5 line-clamp-3 text-sm">
                      {pkg.description}
                    </SheetDescription>
                  )}
                </div>
              </div>

              {/* Metadata chips */}
              <div className="flex flex-wrap gap-2">
                {version && (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    v{version}
                  </Badge>
                )}
                {authorLabel && <MetaChip icon={User}>{authorLabel}</MetaChip>}
                {marketplace && <MetaChip icon={Globe}>{marketplace}</MetaChip>}
                {license && <MetaChip icon={Scale}>{license}</MetaChip>}
              </div>

              {/* Homepage link */}
              {homepage && (
                <a
                  href={homepage}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs transition-colors"
                >
                  <ExternalLink className="size-3" aria-hidden />
                  <span className="truncate">{homepage}</span>
                </a>
              )}
            </SheetHeader>

            {/* Scrollable body — px-4 matches the SheetHeader/SheetFooter p-4 horizontal padding so content doesn't bump the drawer edges */}
            <div className="flex-1 space-y-6 overflow-y-auto px-4 py-6">
              {isLoading ? (
                // Hold the skeleton until every gate resolves — crucially
                // `isInstallStateUnknown`, so we never render the install
                // preview for a package that turns out to be installed.
                <DetailSkeleton />
              ) : isInstalled ? (
                <InstallationsPanel
                  installations={installations ?? installedEntries}
                  uninstallPendingFor={uninstallPendingFor}
                  anyMutationPending={uninstall.isPending}
                  onReinstall={handleReinstall}
                  onUninstall={handleUninstall}
                />
              ) : permissionPreview ? (
                <section>
                  <h3 className="mb-3 text-sm font-semibold">Permissions & Effects</h3>
                  <PermissionPreviewSection preview={permissionPreview} />
                </section>
              ) : (
                <p className="text-muted-foreground text-sm">No special permissions required.</p>
              )}

              {/* README ("About") — shown for every install state so the user can
                  see what a package does before installing. Rendered below
                  permissions to mirror the marketing site's header → permissions
                  → readme ordering. Relative-path images won't resolve (no
                  base-URL rewriting yet); streamdown degrades a broken image
                  without breaking layout. linkSafety gates external links —
                  README content is third-party and untrusted. */}
              {!isLoading && detail?.readme && (
                <section>
                  <h3 className="mb-3 text-sm font-semibold">About</h3>
                  <MarkdownContent
                    content={detail.readme}
                    className="text-sm"
                    linkSafety
                    errorFallback={
                      <p className="text-muted-foreground text-sm">
                        This README couldn&rsquo;t be displayed.
                      </p>
                    }
                  />
                </section>
              )}
            </div>

            {/* Sticky action footer */}
            <SheetFooter className="flex-row gap-2 border-t pt-4">
              <Button variant="ghost" onClick={closeDetail} className="flex-1">
                Close
              </Button>

              {isInstalled ? (
                <Button
                  variant="outline"
                  disabled={uninstall.isPending}
                  onClick={() => requestInstall(pkg)}
                  className="flex-1"
                >
                  Install…
                </Button>
              ) : (
                <Button onClick={() => requestInstall(pkg)} className="flex-1">
                  Install
                </Button>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
