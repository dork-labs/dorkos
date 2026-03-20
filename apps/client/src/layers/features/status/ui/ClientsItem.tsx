import { Users, Lock } from 'lucide-react';
import { motion } from 'motion/react';
import type { PresenceClient, PresenceUpdateEvent } from '@dorkos/shared/types';
import { Popover, PopoverContent, PopoverTrigger } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

/** Friendly display names for client types. */
const CLIENT_TYPE_LABELS: Record<PresenceClient['type'], string> = {
  web: 'Web browser',
  obsidian: 'Obsidian plugin',
  mcp: 'External client',
  unknown: 'Unknown client',
};

interface ClientsItemProps {
  clientCount: number;
  clients: PresenceClient[];
  lockInfo: PresenceUpdateEvent['lockInfo'];
  pulse: boolean;
}

/** Format a relative time string from an ISO timestamp. */
function relativeTime(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now - then;
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 60) return 'just now';
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  return `${diffHours}h ago`;
}

/** Status bar item displaying multi-client session presence. */
export function ClientsItem({ clientCount, clients, lockInfo, pulse }: ClientsItemProps) {
  const isLocked = lockInfo !== null;

  const badge = (
    <motion.span
      animate={pulse ? { scale: [1, 1.15, 1] } : undefined}
      transition={pulse ? { duration: 0.4 } : undefined}
      className={cn('inline-flex items-center gap-1', isLocked && 'text-amber-500')}
    >
      {isLocked ? (
        <Lock className="size-(--size-icon-xs)" />
      ) : (
        <Users className="size-(--size-icon-xs)" />
      )}
      <span>{clientCount} clients</span>
    </motion.span>
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex cursor-pointer items-center"
          aria-label={`${clientCount} clients connected${isLocked ? ', session locked' : ''}`}
        >
          {badge}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-56 p-3">
        <p className="text-muted-foreground mb-2 text-xs font-medium">Connected clients</p>
        <ul className="space-y-1.5">
          {clients.map((client, i) => (
            <li key={`${client.type}-${i}`} className="flex items-center justify-between text-xs">
              <span>{CLIENT_TYPE_LABELS[client.type]}</span>
              <span className="text-muted-foreground">{relativeTime(client.connectedAt)}</span>
            </li>
          ))}
        </ul>
        {isLocked && <p className="mt-2 text-xs text-amber-500">Locked by another client</p>}
      </PopoverContent>
    </Popover>
  );
}
