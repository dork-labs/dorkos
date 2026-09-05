import type { ReactNode } from 'react';
import { Layers, RefreshCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { STATUS_TONE_TEXT, Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import {
  resolveDisplayContextPercent,
  contextSeverity,
  CONTEXT_ACTION_PERCENT,
} from '@/layers/entities/session';
import type { ContextUsage } from '@dorkos/shared/types';
import { formatTokens } from '../lib/format-tokens';

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
    severity === 'critical'
      ? STATUS_TONE_TEXT.error
      : severity === 'warning'
        ? STATUS_TONE_TEXT.warning
        : '';
  const showCompact = compact != null && displayPercent >= CONTEXT_ACTION_PERCENT;

  // The percent never abbreviates. The registry marks this item `rigid`, so the
  // row cannot squeeze it in the first place — and if it ever does, `88%` must
  // still not degrade to `8…`, which is a different number rather than the same
  // one in fewer letters (DOR-461 review). The Compact action beside it is a
  // label, so that one may give way.
  const badge = (
    <span
      // `aria-label`, not a wrapper: an extra box between the tooltip trigger and
      // this one is another place for a stray `min-w-0` to squeeze the number.
      aria-label={contextUsage ? 'Context window usage' : undefined}
      className={cn(
        'inline-flex shrink-0 items-center gap-1',
        contextUsage && 'cursor-default',
        colorClass
      )}
    >
      <Layers className="size-(--size-icon-xs) shrink-0" />
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
                : `Context ${displayPercent}% full. Compact now`
            }
            aria-busy={compact.pending}
            data-testid="compaction-chip"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            // Shrinkable, though nothing squeezes it today: the registry marks
            // this item rigid, so the row cannot compress the item at all and the
            // label renders whole at every width. That is worth knowing rather
            // than assuming — the percent plus this action is a 128px block that
            // cannot give up a pixel, the largest single rigid demand in the row
            // and the main reason `model` and `connection` are the ones paying at
            // the `full` floor. The shrink stays because it is the honest fallback
            // if that decision is ever revisited: a label may abbreviate, and the
            // glyph alone is still a 44px target named by `aria-label`.
            className="bg-secondary text-muted-foreground hover:text-foreground hover:bg-muted inline-flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw
              aria-hidden="true"
              className={cn('size-(--size-icon-xs) shrink-0', compact.pending && 'animate-spin')}
            />
            <span className="truncate">Compact</span>
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
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        <div className="space-y-1.5">
          <div className="text-xs font-medium">
            {formatTokens(usage.totalTokens)} / {formatTokens(usage.maxTokens)} tokens
          </div>
          {significantCategories.length > 0 && (
            <div className="space-y-0.5">
              {significantCategories.map((cat) => (
                <div key={cat.name} className="text-3xs flex items-center justify-between gap-3">
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
