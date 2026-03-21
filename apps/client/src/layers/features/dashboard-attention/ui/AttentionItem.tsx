import { Button } from '@/layers/shared/ui';
import { motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import type { AttentionItem as AttentionItemType } from '../model/use-attention-items';

const staggerItem = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
} as const;

/** @internal Formats a timestamp as a relative time string (e.g., "5m", "2h", "3d"). */
function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

interface AttentionItemProps {
  item: AttentionItemType;
}

/** Single attention row with icon, description, relative timestamp, and action button. */
export function AttentionItemRow({ item }: AttentionItemProps) {
  const Icon = item.icon;
  const relativeTime = formatRelativeTime(item.timestamp);

  return (
    <motion.div variants={staggerItem} className="flex items-center gap-3 py-1.5">
      <Icon
        className={cn(
          'size-[--size-icon-sm] shrink-0',
          item.severity === 'error' ? 'text-red-500' : 'text-amber-500'
        )}
      />
      <span className="text-foreground flex-1 truncate text-sm">{item.description}</span>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{relativeTime}</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 text-xs"
        onClick={item.action.onClick}
      >
        {item.action.label}
      </Button>
    </motion.div>
  );
}
