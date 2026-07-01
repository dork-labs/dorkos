/**
 * Slide-in detail sheet shown when the user clicks a package card in the Dork Hub.
 *
 * Reads the currently-open package from `useDorkHubStore`. When a package is
 * set, it fetches the full manifest via `useMarketplacePackage`. If the package
 * is not installed it shows a fresh permission preview via `usePermissionPreview`
 * and an Install action. If it IS installed it shows an installed-state panel
 * (scope, source, date, capability counts via `useInstalledPackage`) and
 * Reinstall / Uninstall actions. Reinstall delegates to the install
 * confirmation dialog via `openInstallConfirm`.
 *
 * @module features/marketplace/ui/PackageDetailSheet
 */
import {
  Calendar,
  Check,
  ExternalLink,
  FolderOpen,
  Globe,
  Puzzle,
  Scale,
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
} from '@/layers/shared/ui';
import {
  useMarketplacePackage,
  usePermissionPreview,
  useInstalledPackages,
  useInstalledPackage,
} from '@/layers/entities/marketplace';
import { useDorkHubStore } from '../model/dork-hub-store';
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

/** Human label for where a package is installed. */
function formatScopeLabel(pkg: InstalledPackage | undefined): string {
  if (pkg?.scope === 'agent-local' || pkg?.scope === 'override') {
    const agent = pkg.agentPath?.split('/').filter(Boolean).pop();
    return agent ? `Installed for ${agent}` : 'Installed for this agent';
  }
  return 'Installed globally';
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

/**
 * Installed-state panel shown in place of the install permission preview once a
 * package is already installed: where it lives (scope), where it came from, when
 * it landed, and what it contributes.
 */
function InstalledPanel({ installedPkg }: { installedPkg: InstalledPackage | undefined }) {
  const providesLine = formatProvides(installedPkg?.provides);
  const installedDate = installedPkg?.installedAt
    ? new Date(installedPkg.installedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
        <Check className="size-4 shrink-0" aria-hidden />
        {formatScopeLabel(installedPkg)}
      </div>
      <dl className="text-muted-foreground space-y-1.5 text-xs">
        {installedPkg?.installedFrom && (
          <div className="flex items-center gap-1.5">
            <FolderOpen className="size-3 shrink-0" aria-hidden />
            <span>from {installedPkg.installedFrom}</span>
          </div>
        )}
        {installedDate && (
          <div className="flex items-center gap-1.5">
            <Calendar className="size-3 shrink-0" aria-hidden />
            <span>Installed {installedDate}</span>
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
 * Opens automatically when `useDorkHubStore.detailPackage` is non-null.
 * Closing the sheet (ESC, backdrop click, or the Close button) resets store
 * state via `closeDetail()`.
 */
export function PackageDetailSheet() {
  const pkg = useDorkHubStore((s) => s.detailPackage);
  const closeDetail = useDorkHubStore((s) => s.closeDetail);
  const openInstallConfirm = useDorkHubStore((s) => s.openInstallConfirm);

  const enabled = pkg !== null;
  const packageName = pkg?.name ?? null;

  const { data: detail, isLoading: isDetailLoading } = useMarketplacePackage(packageName, {
    enabled,
  });

  const { data: installed, isLoading: isInstalledListLoading } = useInstalledPackages();
  const installedEntry =
    pkg !== null ? (installed ?? []).find((p) => p.name === pkg.name) : undefined;
  const isInstalled = installedEntry !== undefined;

  // Installed packages show an installed-state panel (scope + provides) instead
  // of an install preview. Fetch the enriched single-package record for the
  // provides counts; the panel falls back to `installedEntry` (which already
  // carries scope/source/date) so it never flashes a wrong "globally" label
  // while the enriched fetch is in flight. Skip the permission preview for an
  // installed package — and hold it until the installed list has loaded, so a
  // still-loading list can't briefly fire a preview that is then discarded.
  const { data: installedPkg } = useInstalledPackage(packageName, { enabled: isInstalled });
  const { data: previewDetail, isLoading: isPreviewLoading } = usePermissionPreview(packageName, {
    enabled: enabled && !isInstalled && !isInstalledListLoading,
  });

  const uninstall = useUninstallWithToast();

  const isLoading = isDetailLoading || isPreviewLoading;
  const permissionPreview = previewDetail?.preview ?? detail?.preview;

  const authorLabel = resolveAuthorLabel(detail?.manifest.author ?? pkg?.author);
  const version = detail?.manifest.version;
  const license = detail?.manifest.license;
  const homepage = pkg?.homepage;
  const marketplace = pkg?.marketplace;

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
              {isInstalled ? (
                <InstalledPanel installedPkg={installedPkg ?? installedEntry} />
              ) : (
                <>
                  {isLoading && <DetailSkeleton />}

                  {permissionPreview && !isLoading && (
                    <section>
                      <h3 className="mb-3 text-sm font-semibold">Permissions & Effects</h3>
                      <PermissionPreviewSection preview={permissionPreview} />
                    </section>
                  )}

                  {!isLoading && !permissionPreview && (
                    <p className="text-muted-foreground text-sm">
                      No special permissions required.
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Sticky action footer */}
            <SheetFooter className="flex-row gap-2 border-t pt-4">
              <Button variant="ghost" onClick={closeDetail} className="flex-1">
                Close
              </Button>

              {isInstalled ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => openInstallConfirm(pkg)}
                    className="flex-1"
                  >
                    Reinstall
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={uninstall.isPending}
                    onClick={() => uninstall.mutate({ name: pkg.name })}
                    className="text-destructive hover:text-destructive flex-1"
                  >
                    {uninstall.isPending ? 'Uninstalling…' : 'Uninstall'}
                  </Button>
                </>
              ) : (
                <Button onClick={() => openInstallConfirm(pkg)} className="flex-1">
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
