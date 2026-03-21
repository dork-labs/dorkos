import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { ActiveSession } from '../model/use-active-sessions';

interface ActiveSessionCardProps {
  session: ActiveSession;
}

/** Single active session card showing agent identity, last activity, and status. */
export function ActiveSessionCard({ session }: ActiveSessionCardProps) {
  const navigate = useNavigate();

  return (
    <div className="bg-card shadow-soft card-interactive rounded-xl border p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-base">{session.agentEmoji}</span>
        <span className="text-foreground truncate text-sm font-medium">{session.agentName}</span>
      </div>
      <p className="text-muted-foreground mb-3 truncate text-xs">
        {session.lastActivity || 'idle'}
      </p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'size-2 rounded-full',
              session.status === 'active' ? 'animate-pulse bg-blue-500' : 'bg-muted-foreground/30'
            )}
          />
          <span className="text-muted-foreground text-xs tabular-nums">{session.elapsedTime}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() =>
            navigate({
              to: '/session',
              search: { session: session.id, dir: session.cwd },
            })
          }
        >
          Open
        </Button>
      </div>
    </div>
  );
}
