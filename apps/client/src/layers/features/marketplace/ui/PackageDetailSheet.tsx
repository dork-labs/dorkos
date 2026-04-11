/**
 * Slide-in detail sheet shown when the user clicks a package card in the Dork Hub.
 *
 * Reads the currently-open package from `useDorkHubStore`. When a package is
 * set, it fetches the full manifest via `useMarketplacePackage` and a fresh
 * permission preview via `usePermissionPreview`. Provides Install / Uninstall
 * actions; Install delegates to the install confirmation dialog via
 * `openInstallConfirm`.
 *
 * @module features/marketplace/ui/PackageDetailSheet
 */
import { ExternalLink, Globe, Scale, User } from 'lucide-react';
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
  useUninstallPackage,
} from '@/layers/entities/marketplace';
import { useDorkHubStore } from '../model/dork-hub-store';
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

  const { data: previewDetail, isLoading: isPreviewLoading } = usePermissionPreview(packageName, {
    enabled,
  });

  const { data: installed } = useInstalledPackages();
  const uninstall = useUninstallPackage();

  const isInstalled = pkg !== null && (installed ?? []).some((p) => p.name === pkg.name);
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
              <div className="flex items-start gap-4">
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

            {/* Scrollable body */}
            <div className="flex-1 space-y-6 overflow-y-auto py-6 pr-1">
              {isLoading && <DetailSkeleton />}

              {permissionPreview && !isLoading && (
                <section>
                  <h3 className="mb-3 text-sm font-semibold">Permissions & Effects</h3>
                  <PermissionPreviewSection preview={permissionPreview} />
                </section>
              )}

              {!isLoading && !permissionPreview && (
                <p className="text-muted-foreground text-sm">No special permissions required.</p>
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
                  onClick={() => uninstall.mutate({ name: pkg.name })}
                  className="flex-1"
                >
                  {uninstall.isPending ? 'Uninstalling…' : 'Uninstall'}
                </Button>
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
