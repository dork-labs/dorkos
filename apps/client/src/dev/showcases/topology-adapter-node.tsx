import { Plus } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';
import { cn } from '@/layers/shared/lib';

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

export interface AdapterDemoData {
  name: string;
  type: string;
  status: 'running' | 'stopped' | 'error';
  bindingCount: number;
  label?: string;
}

/* ---------------------------------------------------------------------------
 * Constants
 * --------------------------------------------------------------------------- */

export const ADAPTER_STATUS_COLORS: Record<string, string> = {
  running: 'bg-green-500',
  stopped: 'bg-zinc-400',
  error: 'bg-red-500',
};

/* ---------------------------------------------------------------------------
 * Visual components
 * --------------------------------------------------------------------------- */

/** Default card rendered at normal zoom (~200px wide). */
export function AdapterDefaultCard({ d }: { d: AdapterDemoData }) {
  return (
    <div className="bg-card shadow-soft w-[200px] rounded-xl border p-4" style={{ minHeight: 100 }}>
      <div className="flex items-center gap-2">
        <span className={cn('size-2.5 shrink-0 rounded-full', ADAPTER_STATUS_COLORS[d.status])} />
        <div className="flex min-w-0 flex-col">
          <span className="text-foreground truncate text-sm font-medium">{d.label || d.name}</span>
          {d.label && <span className="text-muted-foreground truncate text-xs">{d.name}</span>}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-muted-foreground text-xs capitalize">{d.type}</span>
        {d.bindingCount > 0 && (
          <Badge variant="secondary" className="text-xs">
            {d.bindingCount} {d.bindingCount === 1 ? 'connection' : 'connections'}
          </Badge>
        )}
      </div>
    </div>
  );
}

/** Compact pill rendered at low zoom (~120px wide). */
export function AdapterCompactPill({ d }: { d: AdapterDemoData }) {
  return (
    <div className="bg-card flex w-[120px] items-center gap-1.5 rounded-full border px-2.5 py-1 shadow-sm">
      <span className={cn('size-2 shrink-0 rounded-full', ADAPTER_STATUS_COLORS[d.status])} />
      <span className="text-foreground truncate text-xs font-medium">{d.label || d.name}</span>
    </div>
  );
}

/** Ghost placeholder shown when no adapters are registered. */
export function AdapterGhostPlaceholder() {
  return (
    <div
      className="border-muted-foreground/30 bg-card/40 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 opacity-40 transition-opacity hover:opacity-70"
      style={{ width: 200, height: 100 }}
      role="button"
      tabIndex={0}
    >
      <Plus className="text-muted-foreground size-4" />
      <span className="text-muted-foreground text-sm">Add a platform</span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Mock data
 * --------------------------------------------------------------------------- */

export const ADAPTERS: AdapterDemoData[] = [
  { name: 'Slack Bot', type: 'slack', status: 'running', bindingCount: 3, label: 'Team Slack' },
  { name: 'Discord Bot', type: 'discord', status: 'stopped', bindingCount: 0 },
  { name: 'Telegram Bot', type: 'telegram', status: 'error', bindingCount: 1 },
];
