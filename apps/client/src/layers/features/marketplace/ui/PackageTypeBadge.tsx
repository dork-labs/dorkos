import { Badge } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { MarketplacePackageType } from '@dorkos/shared/marketplace-schemas';

// ---------------------------------------------------------------------------
// Style and label maps
// ---------------------------------------------------------------------------

const TYPE_STYLES: Record<MarketplacePackageType, string> = {
  agent: 'border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  plugin: 'border-purple-500/20 bg-purple-500/10 text-purple-600 dark:text-purple-400',
  'skill-pack': 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  adapter: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

const TYPE_LABELS: Record<MarketplacePackageType, string> = {
  agent: 'AGENT',
  plugin: 'PLUGIN',
  'skill-pack': 'SKILL PACK',
  adapter: 'ADAPTER',
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PackageTypeBadgeProps {
  /** The marketplace package type to display. */
  type: MarketplacePackageType;
  /** Additional class names merged onto the badge element. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Color-coded badge representing a marketplace package type.
 *
 * Each type maps to a distinct hue so users can distinguish agents, plugins,
 * skill-packs, and adapters at a glance in the browse grid.
 *
 * @param type - The package type to render.
 * @param className - Optional additional class names.
 */
export function PackageTypeBadge({ type, className }: PackageTypeBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn('font-mono text-[10px] tracking-wider', TYPE_STYLES[type], className)}
    >
      {TYPE_LABELS[type]}
    </Badge>
  );
}
