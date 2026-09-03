import { Badge } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { CONNECTOR_ADAPTER_TYPE } from '@dorkos/marketplace';
import type { MarketplacePackageType } from '@dorkos/shared/marketplace-schemas';

// ---------------------------------------------------------------------------
// Style and label maps
// ---------------------------------------------------------------------------

const TYPE_STYLES: Record<MarketplacePackageType, string> = {
  agent: 'border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  plugin: 'border-purple-500/20 bg-purple-500/10 text-purple-600 dark:text-purple-400',
  'skill-pack': 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  adapter: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  shape: 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400',
};

const TYPE_LABELS: Record<MarketplacePackageType, string> = {
  agent: 'AGENT',
  plugin: 'PLUGIN',
  'skill-pack': 'SKILL PACK',
  adapter: 'ADAPTER',
  shape: 'SHAPE',
};

/** Distinct hue for connector adapters — cyan, unused by the five base types. */
const CONNECTOR_STYLE = 'border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400';

const CONNECTOR_LABEL = 'CONNECTOR';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PackageTypeBadgeProps {
  /** The marketplace package type to display. */
  type: MarketplacePackageType;
  /**
   * Adapter type identifier for adapter packages. When it names the well-known
   * connector value, the badge renders CONNECTOR instead of ADAPTER; any other
   * value (or absence) leaves the badge unchanged.
   */
  adapterType?: string;
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
 * skill-packs, adapters, and shapes at a glance in the browse grid. An adapter
 * whose `adapterType` is the well-known connector value renders a distinct
 * CONNECTOR badge (cyan), so connector-gateway packages stand out from other
 * adapters.
 *
 * @param type - The package type to render.
 * @param adapterType - The adapter type identifier, for adapter packages.
 * @param className - Optional additional class names.
 */
export function PackageTypeBadge({ type, adapterType, className }: PackageTypeBadgeProps) {
  const isConnector = type === 'adapter' && adapterType === CONNECTOR_ADAPTER_TYPE;
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-mono text-3xs tracking-wider',
        isConnector ? CONNECTOR_STYLE : TYPE_STYLES[type],
        className
      )}
    >
      {isConnector ? CONNECTOR_LABEL : TYPE_LABELS[type]}
    </Badge>
  );
}
