import { Loader2 } from 'lucide-react';

interface CompactPendingRowProps {
  /** Type of interaction being handled in the input zone. */
  type: 'approval' | 'question';
  'data-testid'?: string;
}

/** Compact single-line placeholder for interactions handled in the input zone. */
export function CompactPendingRow({ type, ...dataProps }: CompactPendingRowProps) {
  const label = type === 'approval' ? 'Waiting for approval...' : 'Answering questions...';

  return (
    <div
      className="bg-muted/50 rounded-msg-tool border px-3 py-1 text-sm text-muted-foreground shadow-msg-tool transition-all duration-150"
      {...dataProps}
    >
      <div className="flex items-center gap-2">
        <Loader2 className="size-(--size-icon-sm) shrink-0 animate-spin" />
        <span className="text-xs">{label}</span>
      </div>
    </div>
  );
}
