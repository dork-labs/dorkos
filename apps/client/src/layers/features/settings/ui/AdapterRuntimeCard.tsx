import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Badge, Switch } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
const EASE_OUT = [0, 0, 0.2, 1] as const;

const expandVariants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;

const expandTransition = { duration: 0.2, ease: EASE_OUT } as const;

interface AdapterRuntimeCardProps {
  /** Runtime adapter name. */
  name: string;
  /** Icon component for the adapter — accepts Lucide icons and adapter logo components. */
  icon: React.ComponentType<{ className?: string }>;
  /** Short description of the adapter. */
  description: string;
  /** Current status. */
  status: 'active' | 'coming-soon' | 'disabled';
  /** Whether the adapter is enabled. */
  enabled: boolean;
  /** Called when the enable/disable toggle changes. Only available for non-coming-soon adapters. */
  onToggle?: (enabled: boolean) => void;
  /** Config rows to render in the expanded body. */
  children?: React.ReactNode;
}

/** Expandable card displaying agent adapter runtime configuration. */
export function AdapterRuntimeCard({
  name,
  icon: Icon,
  description,
  status,
  enabled,
  onToggle,
  children,
}: AdapterRuntimeCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isComingSoon = status === 'coming-soon';
  const hasBody = !!children && !isComingSoon;

  return (
    <div
      className={cn(
        'rounded-lg border transition-colors',
        isComingSoon && 'border-dashed opacity-60'
      )}
    >
      {/* Header row — always visible */}
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        onClick={() => hasBody && setExpanded((v) => !v)}
        disabled={!hasBody}
      >
        <Icon className="text-muted-foreground size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{name}</span>
            {status === 'active' && (
              <Badge variant="default" className="text-xs">
                Active
              </Badge>
            )}
            {isComingSoon && (
              <Badge variant="secondary" className="text-xs">
                Coming Soon
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
        </div>

        {/* Toggle (not for coming-soon) */}
        {!isComingSoon && onToggle && (
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- Event boundary only; Switch itself is keyboard-accessible
          <div onClick={(e) => e.stopPropagation()}>
            <Switch checked={enabled} onCheckedChange={onToggle} />
          </div>
        )}

        {/* Expand chevron (only when body exists) */}
        {hasBody && (
          <ChevronDown
            className={cn(
              'text-muted-foreground size-4 shrink-0 transition-transform duration-200',
              expanded && 'rotate-180'
            )}
          />
        )}
      </button>

      {/* Expandable body */}
      <AnimatePresence initial={false}>
        {expanded && hasBody && (
          <motion.div
            variants={expandVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={expandTransition}
            className="overflow-hidden"
          >
            <div className="space-y-3 border-t px-4 py-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
