import { Star, Check, User } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { PackageTypeBadge } from './PackageTypeBadge';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a renderable author string. The schema declares `author` as
 * `string`, but CC plugin.json manifests can pass through npm-style objects
 * like `{ name: "...", email: "..." }`. Handle both shapes defensively.
 */
function resolveAuthorLabel(author: unknown): string | null {
  if (typeof author === 'string') return author;
  if (author && typeof author === 'object' && 'name' in author) {
    return String((author as { name: unknown }).name);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PackageCardProps {
  /** The aggregated marketplace package to display. */
  pkg: AggregatedPackage;
  /** Whether this package is already installed. */
  installed?: boolean;
  /** Called when the card body is clicked (opens detail sheet). */
  onClick: () => void;
  /**
   * Called when the Install button is clicked.
   *
   * The event has already had `stopPropagation()` called before this fires,
   * so `onClick` (the card-level handler) will not also be triggered.
   */
  onInstallClick?: (e: React.MouseEvent) => void;
  /** Card display variant. 'compact' hides author and install button, uses smaller padding. */
  variant?: 'default' | 'compact';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Grid card for a single marketplace package.
 *
 * Renders the package icon, name, type badge, description, and either an
 * "Installed" indicator or an Install button. The entire card is a focusable
 * button; the Install action uses `stopPropagation` to avoid also triggering
 * the card-level `onClick` (which opens the detail sheet).
 *
 * Field notes vs. spec:
 * - Uses `pkg.name` as the title — `displayName` does not exist on
 *   `AggregatedPackage`.
 * - The install-count line is omitted — `installCount` is not part of the
 *   `AggregatedPackage` shape.
 * - `pkg.type` defaults to `'plugin'` when absent (matches server default).
 *
 * @param pkg - The package to render.
 * @param installed - Whether the package is currently installed.
 * @param onClick - Handler for card-body clicks (opens detail sheet).
 * @param onInstallClick - Handler for the Install button click.
 */
export function PackageCard({
  pkg,
  installed,
  onClick,
  onInstallClick,
  variant = 'default',
}: PackageCardProps) {
  const packageType = pkg.type ?? 'plugin';
  const authorLabel = resolveAuthorLabel(pkg.author) ?? pkg.marketplace ?? null;
  const isCompact = variant === 'compact';

  const handleInstallClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onInstallClick?.(e);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'card-interactive group bg-card flex h-full flex-col rounded-xl border text-left',
        isCompact ? 'p-4' : 'p-6',
        'hover:border-border/80 transition-all duration-200 hover:shadow-md',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2'
      )}
      data-testid={`package-card-${pkg.name}`}
    >
      {/* Icon row */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <span className="text-2xl leading-none" aria-hidden>
          {pkg.icon ?? '📦'}
        </span>
        {!isCompact && pkg.featured && (
          <Star
            className="size-4 shrink-0 fill-amber-400 text-amber-400"
            aria-label="Featured package"
          />
        )}
      </div>

      {/* Name */}
      <h3 className="mb-1 text-sm leading-tight font-semibold">{pkg.name}</h3>

      {/* Type badge */}
      <PackageTypeBadge type={packageType} className="mb-3 self-start" />

      {/* Description */}
      {pkg.description && (
        <p className="text-muted-foreground mb-3 line-clamp-2 text-xs">{pkg.description}</p>
      )}

      {/* Author / source */}
      {!isCompact && authorLabel && (
        <div className="text-muted-foreground mb-3 flex items-center gap-1.5 text-[11px]">
          <User className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{authorLabel}</span>
        </div>
      )}

      {/* Action row */}
      {!isCompact && (
        <div className="mt-auto flex items-center justify-end gap-2">
          {installed ? (
            <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <Check className="size-3" aria-hidden />
              Installed
            </span>
          ) : (
            <Button size="sm" variant="ghost" onClick={handleInstallClick} className="gap-1">
              Install
              <span className="inline-block transition-transform duration-200 group-hover:translate-x-0.5">
                →
              </span>
            </Button>
          )}
        </div>
      )}
    </button>
  );
}
