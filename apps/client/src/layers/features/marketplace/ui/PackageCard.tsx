import { Star, Check, Store, User } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { cn, packageDisplayLabel } from '@/layers/shared/lib';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { PackageTypeBadge } from './PackageTypeBadge';
import { adapterBridge } from '../lib/adapter-bridge';

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
 * "Installed" indicator or an Install button. The card body is a focusable
 * `role="button"` region (a `div`, not a `<button>`, so the inner Install
 * `<button>` is not an invalid nested button) that activates on click and on
 * Enter/Space. The Install action uses `stopPropagation` to avoid also
 * triggering the card-level `onClick` (which opens the detail sheet).
 *
 * The title prefers the author's `displayName` and falls back to a humanized
 * `name`, so a package that ships only a kebab-case slug never reads as code.
 *
 * The meta line under the description carries the author and the marketplace
 * source the entry came from. They used to share one slot, with the source
 * standing in when no author was declared under a person icon — which read as
 * if a registry were a person, and hid the source on every package that did
 * name an author. They are two different facts and now sit side by side.
 *
 * Field notes vs. spec:
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
  const authorLabel = resolveAuthorLabel(pkg.author);
  const isCompact = variant === 'compact';
  const bridge = adapterBridge(pkg.type, pkg.adapterType);

  const handleInstallClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onInstallClick?.(e);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          // Space would otherwise scroll the page; both keys activate the card.
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'card-interactive group bg-card flex h-full cursor-pointer flex-col rounded-xl border text-left',
        isCompact ? 'p-4' : 'p-6',
        // `card-interactive` owns the transition (and now the focus-visible
        // twin of this hover). A `transition-all` here would put border width,
        // padding and every layout property back in it.
        'hover:border-border/80 hover:shadow-md',
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
      <h3 className="mb-1 text-sm leading-tight font-semibold">{packageDisplayLabel(pkg)}</h3>

      {/* Type badge */}
      <PackageTypeBadge
        type={packageType}
        adapterType={pkg.adapterType}
        className="mb-2 self-start"
      />

      {/* Bridge line: what this adapter becomes on the Connections page */}
      {bridge && <p className="text-muted-foreground/90 text-2xs mb-3">{bridge.line}</p>}

      {/* Description */}
      {pkg.description && (
        <p className="text-muted-foreground mb-3 line-clamp-2 text-xs">{pkg.description}</p>
      )}

      {/* Author and source. The source is the marketplace the entry was
          aggregated from — most of the catalog is mirrored from other
          registries, so it is the fastest way to tell a DorkOS package from a
          borrowed one. It reads muted next to the author rather than as a
          badge: it is provenance, not a claim. */}
      {!isCompact && (authorLabel || pkg.marketplace) && (
        <div className="text-muted-foreground text-2xs mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 overflow-hidden">
          {/* Each fact is a flex child with a floor, and the row wraps.
              Sized from their own content, the two shared the squeeze in
              proportion to how long each string happened to be, so on a card in
              the four-column grid both crushed together — `C… · d` (DOR-1747).
              A floor makes that impossible: when both cannot fit, the source
              takes the next line and each one is read whole rather than two
              halves of nothing. `flex-1` lets a lone fact take the full width.

              The floor is `min(6.5rem,100%)`, not a bare `6.5rem` — on a card
              narrower than 6.5rem itself (a docked panel, a half-width window,
              a tablet at the exact width a grid column bumps up), a bare floor
              cannot shrink and paints past the card's edge; `min()` caps it at
              the card's own width instead, so the fact still gets the full
              floor when there's room and never asks for more than the card
              has. `overflow-hidden` on the row is the backstop: even if a
              future change reintroduces a hard floor here, nothing can ever
              paint past this box again.

              The mid-dot between them is gone with the same change. It divided
              two facts on one line, and a divider that can end up dangling at
              the end of a wrapped line divides nothing — the icons already say
              which fact is which, and the screen reader gets the word "from". */}
          {authorLabel && (
            <span className="flex min-w-[min(6.5rem,100%)] flex-1 items-center gap-1.5">
              <User className="size-3 shrink-0" aria-hidden />
              <span className="truncate" title={authorLabel}>
                {authorLabel}
              </span>
            </span>
          )}
          {pkg.marketplace && (
            <span className="flex min-w-[min(6.5rem,100%)] flex-1 items-center gap-1.5">
              <Store className="size-3 shrink-0" aria-hidden />
              <span className="truncate" title={pkg.marketplace}>
                {/* The icons are aria-hidden, so sighted readers get the
                    distinction from the glyphs and everyone else would hear
                    "Dork Labs dorkos-community" as one name. This word is the
                    only thing separating them. */}
                <span className="sr-only">from </span>
                {pkg.marketplace}
              </span>
            </span>
          )}
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
    </div>
  );
}
