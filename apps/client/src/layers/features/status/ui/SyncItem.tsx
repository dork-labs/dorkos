import { RefreshCw, RefreshCwOff } from 'lucide-react';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/layers/shared/ui';

interface SyncItemProps {
  enabled: boolean;
  onToggle: () => void;
}

/** Status bar toggle button for enabling and disabling cross-client sync. */
export function SyncItem({ enabled, onToggle }: SyncItemProps) {
  const Icon = enabled ? RefreshCw : RefreshCwOff;
  return (
    <HoverCard openDelay={300}>
      <HoverCardTrigger asChild>
        <button
          onClick={onToggle}
          className="hover:text-foreground inline-flex items-center gap-1 transition-colors duration-150"
          aria-label={enabled ? 'Disable multi-window sync' : 'Enable multi-window sync'}
        >
          <Icon className="size-(--size-icon-xs)" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="center" className="w-64 p-3">
        <p className="text-sm font-medium">Multi-window sync {enabled ? 'on' : 'off'}</p>
        <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
          {enabled
            ? 'Changes you make in other DorkOS windows or the Obsidian plugin appear here instantly. Turn off if you only use one window.'
            : 'Turn on if you use DorkOS in multiple windows or alongside the Obsidian plugin, so changes stay in sync everywhere.'}
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}
