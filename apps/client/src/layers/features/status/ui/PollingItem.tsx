import { Timer, TimerOff } from 'lucide-react';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/layers/shared/ui';

interface PollingItemProps {
  enabled: boolean;
  onToggle: () => void;
}

/** Status bar toggle button for enabling and disabling message polling. */
export function PollingItem({ enabled, onToggle }: PollingItemProps) {
  const Icon = enabled ? Timer : TimerOff;
  return (
    <HoverCard openDelay={300}>
      <HoverCardTrigger asChild>
        <button
          onClick={onToggle}
          className="hover:text-foreground inline-flex items-center gap-1 transition-colors duration-150"
          aria-label={enabled ? 'Disable background refresh' : 'Enable background refresh'}
        >
          <Icon className="size-(--size-icon-xs)" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="center" className="w-64 p-3">
        <p className="text-sm font-medium">Background refresh {enabled ? 'on' : 'off'}</p>
        <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
          {enabled
            ? 'Messages are checked for updates periodically, even when no one is typing. Useful if agents run in the background. Turn off to reduce network usage.'
            : 'Messages only update while someone is actively responding. Turn on if you have agents running unattended and want to see their progress.'}
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}
