import { Badge } from '@/layers/shared/ui/badge';
import { Switch } from '@/layers/shared/ui/switch';
import type { AdapterListItem } from '@dorkos/shared/transport';

const STATUS_COLORS: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-gray-400',
  error: 'bg-red-500',
  starting: 'bg-yellow-500',
  stopping: 'bg-yellow-500',
};

interface AdapterCardProps {
  item: AdapterListItem;
  onToggle: (enabled: boolean) => void;
}

/** Displays a single Relay adapter's status, message counts, and enable/disable toggle. */
export function AdapterCard({ item, onToggle }: AdapterCardProps) {
  const { config, status } = item;
  const dotColor = STATUS_COLORS[status.state] ?? 'bg-gray-400';

  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <span className={`h-2 w-2 rounded-full ${dotColor}`} />
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{status.displayName || config.id}</span>
            <Badge variant="outline" className="text-xs">
              {config.type}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground">
            In: {status.messageCount.inbound} | Out: {status.messageCount.outbound}
            {status.errorCount > 0 && ` | Errors: ${status.errorCount}`}
          </div>
          {status.lastError && (
            <div className="mt-1 max-w-[200px] truncate text-xs text-red-500">
              {status.lastError}
            </div>
          )}
        </div>
      </div>
      <Switch checked={config.enabled} onCheckedChange={onToggle} />
    </div>
  );
}
