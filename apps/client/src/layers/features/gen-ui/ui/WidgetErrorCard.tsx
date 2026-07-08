import { useState } from 'react';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

interface WidgetErrorCardProps {
  /** Short, human-readable reason the widget failed to render. */
  error: string;
  /** The raw fence payload, shown collapsed for debugging. */
  raw: string;
}

/**
 * D5 failure card: when a `dorkos-ui` payload is invalid JSON or fails schema
 * validation, render this instead of crashing. Shows a calm message with the
 * raw payload collapsed underneath so the user (or agent) can inspect it.
 *
 * @param error - Short reason the widget could not be rendered
 * @param raw - The raw fence payload, revealed on expand
 */
export function WidgetErrorCard({ error, raw }: WidgetErrorCardProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-card text-card-foreground rounded-lg border p-3 text-sm">
      <div className="flex items-start gap-2">
        <AlertTriangle className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">This widget couldn&apos;t be rendered</p>
          <p className="text-muted-foreground mt-0.5 text-xs break-words">{error}</p>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mt-2 inline-flex items-center gap-1 rounded text-xs focus-visible:ring-2 focus-visible:outline-none"
          >
            <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
            {open ? 'Hide' : 'Show'} raw JSON
          </button>
          {open && (
            <pre className="bg-muted text-muted-foreground mt-2 max-h-64 overflow-auto rounded-md p-2 text-xs">
              <code>{raw}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
