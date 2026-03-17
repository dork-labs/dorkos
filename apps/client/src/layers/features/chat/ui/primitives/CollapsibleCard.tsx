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
  /** Visual variant: default has border+shadow, thinking has left-border-only. */
  variant?: 'default' | 'thinking';
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

/** Animated accordion card shared by ToolCallCard, SubagentBlock, and ThinkingBlock. */
export function CollapsibleCard({
  expanded,
  onToggle,
  header,
  children,
  variant = 'default',
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
        'bg-muted/50 mt-px text-sm first:mt-1',
        variant === 'default' &&
          'hover:border-border rounded-msg-tool border shadow-msg-tool transition-all duration-150 hover:shadow-msg-tool-hover',
        variant === 'thinking' &&
          'rounded-msg-tool border-l-2 border-muted-foreground/20',
        className,
      )}
      {...dataProps}
    >
      <button
        onClick={() => !disabled && onToggle()}
        disabled={disabled}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-1',
          disabled && 'cursor-default',
        )}
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
            <ChevronDown className={cn(
              'size-(--size-icon-xs)',
              variant === 'thinking' && 'text-muted-foreground',
            )} />
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
            <div className="border-t px-3 pt-1 pb-3">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
