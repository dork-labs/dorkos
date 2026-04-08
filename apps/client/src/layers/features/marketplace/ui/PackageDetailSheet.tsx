/**
 * Slide-in detail sheet shown when the user clicks a package card in the Dork Hub.
 *
 * Reads the currently-open package from `useDorkHubStore`. When a package is
 * set, it fetches the full manifest via `useMarketplacePackage` and a fresh
 * permission preview via `usePermissionPreview`. Provides Install / Uninstall
 * actions; Install delegates to the install confirmation dialog via
 * `openInstallConfirm`.
 *
 * Shape notes (verified against `packages/shared/src/marketplace-schemas.ts`):
 * - `MarketplacePackageDetail` has `{ manifest, packagePath, preview }`.
 *   Version/author/license live in `detail.manifest`, not at the top level.
 * - `AggregatedPackage` has no `displayName` field — `pkg.name` is used as the title.
 * - There is no `readme` field anywhere — README rendering is intentionally omitted.
 * - `usePermissionPreview` returns `MarketplacePackageDetail`; its `.preview`
 *   field carries the `PermissionPreview` shape expected by `PermissionPreviewSection`.
 *
 * @module features/marketplace/ui/PackageDetailSheet
 */
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Button,
  Badge,
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
// Internal sub-components
// ---------------------------------------------------------------------------

/** Meta row rendered beneath the sheet title when detail data is available. */
function PackageMetaRow({
  version,
  author,
  license,
}: {
  version?: string;
  author?: string;
  license?: string;
}) {
  const hasAnyMeta = version !== undefined || author !== undefined || license !== undefined;
  if (!hasAnyMeta) return null;

  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-2 pt-2 text-xs">
      {version && (
        <Badge variant="outline" className="font-mono text-[10px]">
          v{version}
        </Badge>
      )}
      {author && <span>by {author}</span>}
      {license && <span>· {license}</span>}
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
 *
 * Install vs Uninstall button is determined by comparing the package name
 * against the list returned by `useInstalledPackages`.
 */
export function PackageDetailSheet() {
  const pkg = useDorkHubStore((s) => s.detailPackage);
  const closeDetail = useDorkHubStore((s) => s.closeDetail);
  const openInstallConfirm = useDorkHubStore((s) => s.openInstallConfirm);

  // Only fetch when a package is selected.
  const enabled = pkg !== null;
  const packageName = pkg?.name ?? null;

  const { data: detail, isLoading: isDetailLoading } = useMarketplacePackage(packageName, {
    enabled,
  });

  // usePermissionPreview returns MarketplacePackageDetail — access .preview for
  // the PermissionPreview shape needed by PermissionPreviewSection.
  const { data: previewDetail, isLoading: isPreviewLoading } = usePermissionPreview(packageName, {
    enabled,
  });

  const { data: installed } = useInstalledPackages();
  const uninstall = useUninstallPackage();

  const isInstalled = pkg !== null && (installed ?? []).some((p) => p.name === pkg.name);

  const isLoading = isDetailLoading || isPreviewLoading;

  // The permission preview to render. Prefer the dedicated preview endpoint
  // result; fall back to the preview embedded in the detail response if
  // usePermissionPreview hasn't resolved yet.
  const permissionPreview = previewDetail?.preview ?? detail?.preview;

  return (
    <Sheet open={pkg !== null} onOpenChange={(open) => !open && closeDetail()}>
      <SheetContent side="right" className="flex w-full flex-col overflow-hidden sm:max-w-xl">
        {pkg && (
          <>
            {/* Header */}
            <SheetHeader className="shrink-0 pr-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate">{pkg.name}</SheetTitle>
                  {pkg.description && (
                    <SheetDescription className="mt-1 line-clamp-3">
                      {pkg.description}
                    </SheetDescription>
                  )}
                </div>
                <PackageTypeBadge type={pkg.type ?? 'plugin'} className="shrink-0" />
              </div>

              <PackageMetaRow
                version={detail?.manifest.version}
                author={detail?.manifest.author}
                license={detail?.manifest.license}
              />
            </SheetHeader>

            {/* Scrollable body */}
            <div className="mt-6 flex-1 space-y-6 overflow-y-auto pr-1">
              {isLoading && <p className="text-muted-foreground text-sm">Loading details…</p>}

              {permissionPreview && !isLoading && (
                <section>
                  <h3 className="mb-3 text-sm font-semibold">Permissions</h3>
                  <PermissionPreviewSection preview={permissionPreview} />
                </section>
              )}
            </div>

            {/* Sticky action footer */}
            <div className="bg-background/95 mt-6 flex shrink-0 gap-2 border-t pt-4 backdrop-blur">
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
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
