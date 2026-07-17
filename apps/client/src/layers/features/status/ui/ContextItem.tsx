import { Layers } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { resolveDisplayContextPercent, contextSeverity } from '@/layers/entities/session';
import type { ContextUsage } from '@dorkos/shared/types';

/** Format a token count as a compact human-readable string (e.g. 42.1k, 200k). */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

interface ContextItemProps {
  percent: number;
  /** Rich context usage breakdown from the SDK, if available. */
  contextUsage?: ContextUsage | null;
}

/** Status bar item displaying context window usage with optional breakdown tooltip. */
export function ContextItem({ percent, contextUsage }: ContextItemProps) {
  // Prefer the SDK breakdown when available, else the passed estimate — the one
  // shared resolution + severity source (entities/session/lib/context-health).
  const displayPercent = resolveDisplayContextPercent(percent, contextUsage) ?? percent;
  const severity = contextSeverity(displayPercent);
  const colorClass =
    severity === 'critical' ? 'text-red-500' : severity === 'warning' ? 'text-amber-500' : '';

  const trigger = (
    <span className={cn('inline-flex items-center gap-1', colorClass)}>
      <Layers className="size-(--size-icon-xs)" />
      <span>{displayPercent}%</span>
    </span>
  );

  if (!contextUsage) return trigger;

  // Filter out zero-token categories and sort by size descending
  const significantCategories = contextUsage.categories
    .filter((c) => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default" aria-label="Context window usage">
          {trigger}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        <div className="space-y-1.5">
          <div className="text-xs font-medium">
            {formatTokens(contextUsage.totalTokens)} / {formatTokens(contextUsage.maxTokens)} tokens
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
