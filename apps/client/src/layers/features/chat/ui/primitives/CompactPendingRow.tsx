import { Loader2 } from 'lucide-react';
import { getToolLabel } from '@/layers/shared/lib';

interface CompactPendingRowProps {
  /** Type of interaction being handled in the input zone. */
  type: 'approval' | 'question';
  /** Tool name for contextual display (optional). */
  toolName?: string;
  /** Tool input JSON string for label derivation (optional). */
  toolInput?: string;
  'data-testid'?: string;
}

/** Compact single-line placeholder for interactions handled in the input zone. */
export function CompactPendingRow({
  type,
  toolName,
  toolInput,
  ...dataProps
}: CompactPendingRowProps) {
  const baseLabel = type === 'approval' ? 'Waiting for approval' : 'Answering questions';
  const toolLabel = toolName ? getToolLabel(toolName, toolInput ?? '') : null;
  const label = toolLabel ? `${baseLabel} — ${toolLabel}` : `${baseLabel}...`;

  return (
    <div
      className="bg-muted/50 rounded-msg-tool text-muted-foreground shadow-msg-tool border px-3 py-1 text-sm transition-all duration-150"
      {...dataProps}
    >
      <div className="flex items-center gap-2">
        <Loader2 className="size-(--size-icon-sm) shrink-0 animate-spin" />
        <span className="truncate text-xs">{label}</span>
      </div>
    </div>
  );
}
