import { cn } from '@/layers/shared/lib';
import { Badge } from '@/layers/shared/ui';
import type { ActivityCategory } from '../model/activity-types';
import { CATEGORY_CONFIG } from '../model/activity-types';

export interface CategoryBadgeProps {
  /** The activity category determines the color. */
  category: ActivityCategory;
  className?: string;
}

/**
 * Category pill rendered on activity rows and filter chips.
 *
 * Colors match the dashboard activity feed:
 * tasks=purple, relay=teal, agent=indigo, config=amber, system=neutral.
 */
export function CategoryBadge({ category, className }: CategoryBadgeProps) {
  const config = CATEGORY_CONFIG[category];

  return (
    <Badge
      data-slot="category-badge"
      shape="pill"
      className={cn('border-transparent', config.bg, config.text, className)}
    >
      {config.label}
    </Badge>
  );
}
