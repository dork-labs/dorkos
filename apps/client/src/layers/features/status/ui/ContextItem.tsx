import type { ReactNode } from 'react';
import { Layers, RefreshCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import {
  resolveDisplayContextPercent,
  contextSeverity,
  CONTEXT_ACTION_PERCENT,
} from '@/layers/entities/session';
import type { ContextUsage } from '@dorkos/shared/types';

/** Format a token count as a compact human-readable string (e.g. 42.1k, 200k). */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/** The one-click compaction action offered when the window is nearly full. */
export interface ContextCompactAction {
  /** True while a compaction is in flight — disables the button and spins its icon. */
  pending: boolean;
  /** Fire the compact intent. */
  onCompact: () => void;
}

interface ContextItemProps {
  percent: number;
  /** Rich context usage breakdown from the SDK, if available. */
  contextUsage?: ContextUsage | null;
  /**
   * The inline compaction action. Pass it only when the runtime can compact and
   * no turn is streaming; it appears once usage reaches
   * {@link CONTEXT_ACTION_PERCENT}, so the fix arrives beside the warning rather
   * than in a row of its own below it.
   */
  compact?: ContextCompactAction | null;
}

/**
 * Status line item showing how full the conversation window is, with an optional
 * breakdown tooltip and — once the window is nearly full — a one-click Compact
 * action beside the number.
 *
 * @param props - The percent to show, the optional SDK breakdown, and the compact action.
 */
export function ContextItem({ percent, contextUsage, compact }: ContextItemProps) {
  // Prefer the SDK breakdown when available, else the passed estimate — the one
  // shared resolution + severity source (entities/session/lib/context-health).
  const displayPercent = resolveDisplayContextPercent(percent, contextUsage) ?? percent;
  const severity = contextSeverity(displayPercent);
  const colorClass =
    severity === 'critical' ? 'text-red-500' : severity === 'warning' ? 'text-amber-500' : '';
  const showCompact = compact != null && displayPercent >= CONTEXT_ACTION_PERCENT;

  const badge = (
    <span className={cn('inline-flex shrink-0 items-center gap-1', colorClass)}>
      <Layers className="size-(--size-icon-xs)" />
      <span>{displayPercent}%</span>
    </span>
  );

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {contextUsage ? <ContextBreakdown usage={contextUsage}>{badge}</ContextBreakdown> : badge}
      <AnimatePresence initial={false}>
        {showCompact && (
          <motion.button
            key="compact"
            type="button"
            onClick={compact.onCompact}
            disabled={compact.pending}
            aria-label={
              compact.pending
                ? 'Compacting conversation…'
                : `Context ${displayPercent}% full — compact now`
            }
            aria-busy={compact.pending}
            data-testid="compaction-chip"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="bg-secondary text-muted-foreground hover:text-foreground hover:bg-muted inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw
              aria-hidden="true"
              className={cn('size-(--size-icon-xs) shrink-0', compact.pending && 'animate-spin')}
            />
            Compact
          </motion.button>
        )}
      </AnimatePresence>
    </span>
  );
}

/**
 * Hover breakdown of what is occupying the context window.
 *
 * @internal
 */
function ContextBreakdown({ usage, children }: { usage: ContextUsage; children: ReactNode }) {
  // Filter out zero-token categories and sort by size descending
  const significantCategories = usage.categories
    .filter((c) => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 cursor-default" aria-label="Context window usage">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        <div className="space-y-1.5">
          <div className="text-xs font-medium">
            {formatTokens(usage.totalTokens)} / {formatTokens(usage.maxTokens)} tokens
          </div>
          {significantCategories.length > 0 && (
            <div className="space-y-0.5">
              {significantCategories.map((cat) => (
                <div key={cat.name} className="flex items-center justify-between gap-3 text-[10px]">
                  <span className="flex items-center gap-1 truncate">
                    <span
                      className="inline-block size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: cat.color }}
                    />
                    {cat.name}
                  </span>
                  <span className="text-muted-foreground shrink-0">{formatTokens(cat.tokens)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
