import { Lock, DollarSign } from 'lucide-react';
import { Badge } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { deriveModelNature } from '../lib/model-nature';

interface ModelNatureBadgeProps {
  /** Provider id (e.g. `ollama`, `openrouter`), when known — the primary locality signal. */
  provider?: string | null;
  /** Model id, e.g. `ollama/qwen2.5-coder:7b` — the fallback locality signal and the size source. */
  modelId: string;
  /**
   * When true, render the benefit + honest capability lines beneath the badge
   * (the point-of-choice detail); otherwise just the compact badge.
   */
  detail?: boolean;
  className?: string;
}

/**
 * A small, honest per-model nature badge: 🔒 local · private · free vs
 * $ cloud · per-token, derived from the model's provider/locality (never a
 * hardcoded per-model table). With `detail`, it also spells out the tradeoff and
 * an honest capability line — a local model is never sold as frontier-equivalent
 * (spec effortless-runtime-switching, decision 11; DOR-180 honesty rule).
 */
export function ModelNatureBadge({ provider, modelId, detail, className }: ModelNatureBadgeProps) {
  const nature = deriveModelNature({ provider, modelId });
  const isLocal = nature.locality === 'local';
  const Icon = isLocal ? Lock : DollarSign;

  return (
    <div className={cn('space-y-1', className)}>
      <Badge
        variant="secondary"
        className={cn(
          'gap-1 font-normal',
          isLocal ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
        )}
        data-locality={nature.locality}
      >
        <Icon className="size-3" aria-hidden />
        {nature.badgeLabel}
      </Badge>
      {detail && (
        <div className="space-y-0.5">
          <p className="text-muted-foreground text-xs">{nature.benefit}</p>
          <p className="text-muted-foreground/80 text-[11px] leading-snug">{nature.capability}</p>
        </div>
      )}
    </div>
  );
}
