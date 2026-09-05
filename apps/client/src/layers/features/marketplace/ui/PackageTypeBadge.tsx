import { Badge } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { CONNECTOR_ADAPTER_TYPE } from '@dorkos/marketplace';
import type { MarketplacePackageType } from '@dorkos/shared/marketplace-schemas';

// ---------------------------------------------------------------------------
// Style and label maps
// ---------------------------------------------------------------------------

/**
 * One hue per package kind, from the `--package-*` token family.
 *
 * Tokens rather than palette classes because each hue needs a value per theme:
 * the old `bg-blue-500/10` was one colour written once and then shown over a
 * near-white page and a near-black one, where a 10%-alpha tint reads completely
 * differently. Each token is tuned for both.
 */
const TYPE_STYLES: Record<MarketplacePackageType, string> = {
  agent: 'border-package-agent-border bg-package-agent-bg text-package-agent-fg',
  plugin: 'border-package-plugin-border bg-package-plugin-bg text-package-plugin-fg',
  'skill-pack': 'border-package-skill-border bg-package-skill-bg text-package-skill-fg',
  adapter: 'border-package-adapter-border bg-package-adapter-bg text-package-adapter-fg',
  shape: 'border-package-shape-border bg-package-shape-bg text-package-shape-fg',
};

const TYPE_LABELS: Record<MarketplacePackageType, string> = {
  agent: 'AGENT',
  plugin: 'PLUGIN',
  'skill-pack': 'SKILL PACK',
  adapter: 'ADAPTER',
  shape: 'SHAPE',
};

/** Distinct hue for connector adapters — cyan, unused by the five base types. */
const CONNECTOR_STYLE =
  'border-package-connector-border bg-package-connector-bg text-package-connector-fg';

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
      size="xs"
      variant="outline"
      className={cn(
        'font-mono tracking-wider',
        isConnector ? CONNECTOR_STYLE : TYPE_STYLES[type],
        className
      )}
    >
      {isConnector ? CONNECTOR_LABEL : TYPE_LABELS[type]}
    </Badge>
  );
}
