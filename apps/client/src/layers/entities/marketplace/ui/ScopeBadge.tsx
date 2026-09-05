import type { PackageScope } from '@dorkos/shared/marketplace-schemas';
import { cn } from '@/layers/shared/lib';
import { Badge } from '@/layers/shared/ui';

interface ScopeBadgeProps {
  scope?: PackageScope;
  className?: string;
}

const SCOPE_LABELS: Record<PackageScope, string> = {
  global: 'global',
  'agent-local': 'local',
  override: 'override',
};

const SCOPE_CLASSES: Record<PackageScope, string> = {
  global: 'bg-muted text-muted-foreground',
  'agent-local': 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  override: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

/**
 * Small pill badge that indicates where a marketplace package is installed.
 *
 * @param scope - The package scope; defaults to `'global'` when undefined.
 * @param className - Additional classes to merge onto the badge element.
 */
export function ScopeBadge({ scope = 'global', className }: ScopeBadgeProps) {
  return (
    <Badge
      data-slot="scope-badge"
      shape="pill"
      size="xs"
      className={cn(
        'border-transparent font-semibold tracking-wide uppercase',
        SCOPE_CLASSES[scope],
        className
      )}
    >
      {SCOPE_LABELS[scope]}
    </Badge>
  );
}
