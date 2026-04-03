import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

interface CollapsibleCardProps {
  /** Whether the accordion body is expanded. */
  expanded: boolean;
  /** Toggle callback for expand/collapse. */
  onToggle: () => void;
  /** Icon + label content rendered in the header row. */
  header: React.ReactNode;
  /** Body content inside the accordion. */
  children: React.ReactNode;
  /** Visual variant: default for tool calls, thinking for reasoning blocks. */
  variant?: 'default' | 'thinking';
  /** When true and collapsed, dims the card. Hover restores full brightness. */
  dimmed?: boolean;
  /** Disable toggle interaction and hide chevron (e.g. during streaming). */
  disabled?: boolean;
  /** Hide the chevron entirely (e.g. non-expandable SubagentBlock). */
  hideChevron?: boolean;
  /** Slot between header and accordion body (e.g. ToolCallCard hooks section). */
  extraContent?: React.ReactNode;
  /** Accessible label for the header button. */
  ariaLabel?: string;
  className?: string;
  'data-testid'?: string;
  [key: `data-${string}`]: string | undefined;
}

/** Animated accordion card shared by ToolCallCard, SubagentBlock, ThinkingBlock, and CollapsibleRun. */
export function CollapsibleCard({
  expanded,
  onToggle,
  header,
  children,
  variant = 'default',
  dimmed = false,
  disabled = false,
  hideChevron = false,
  extraContent,
  ariaLabel,
  className,
  ...dataProps
}: CollapsibleCardProps) {
  // When chevron is hidden the card is not expandable — omit aria-expanded entirely
  const ariaExpanded = hideChevron ? undefined : expanded;

  return (
    <div
      className={cn(
        'bg-muted/40 mt-px rounded-md border-l-2 text-sm transition-all duration-200 first:mt-1',
        variant === 'default' && 'border-l-muted-foreground/30',
        variant === 'thinking' && 'border-l-muted-foreground/20',
        dimmed && !expanded && 'opacity-50 hover:opacity-100',
        className
      )}
      {...dataProps}
    >
      <button
        onClick={() => !disabled && onToggle()}
        disabled={disabled}
        className={cn('flex w-full items-center gap-2 px-3 py-1', disabled && 'cursor-default')}
        aria-expanded={ariaExpanded}
        aria-label={ariaLabel}
      >
        {header}
        {!hideChevron && !disabled && (
          <motion.div
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="ml-auto"
          >
            <ChevronDown className="text-muted-foreground size-(--size-icon-xs)" />
          </motion.div>
        )}
      </button>
      {extraContent}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="border-border/50 border-t px-3 pt-1 pb-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
