import { Button } from '@/layers/shared/ui';
import { motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import type { RecentActivityItem } from '../model/use-recent-activity-items';
import { formatRelativeTime } from '../lib/format-relative-time';

const staggerItem = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
} as const;

interface RecentActivityRowProps {
  item: RecentActivityItem;
}

/** Single activity row with icon, description, relative timestamp, and action button. */
export function RecentActivityRow({ item }: RecentActivityRowProps) {
  const Icon = item.icon;
  const relativeTime = formatRelativeTime(item.timestamp);

  return (
    <motion.div
      variants={staggerItem}
      className="hover:bg-accent/50 flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1 transition-colors"
    >
      {/* Theme tokens, not raw palette: this row draws in light, dark and the
          Obsidian theme, and only the tokens are defined in all three. */}
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          item.severity === 'error' ? 'bg-status-error' : 'bg-status-warning'
        )}
      />
      <Icon
        className={cn(
          'size-3.5 shrink-0',
          item.severity === 'error' ? 'text-status-error/70' : 'text-status-warning/70'
        )}
      />
      <span className="text-foreground/90 min-w-0 flex-1 truncate text-xs">{item.description}</span>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{relativeTime}</span>
      {/* A 24px button on a row this tight is under a fingertip on a phone, and
          a bigger one would break the row. So the target grows and the button
          does not, the way `SidebarGroupAction` does it. */}
      <Button
        variant="ghost"
        size="sm"
        className="relative h-6 shrink-0 px-2 text-xs after:absolute after:-inset-3 md:after:hidden"
        onClick={item.action.onClick}
      >
        {item.action.label}
      </Button>
    </motion.div>
  );
}
