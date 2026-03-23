import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSessions } from '@/layers/entities/session';
import { Button } from '@/layers/shared/ui/button';
import { Badge } from '@/layers/shared/ui/badge';
import { Popover, PopoverTrigger, PopoverContent } from '@/layers/shared/ui/popover';

interface SessionLaunchPopoverProps {
  /** Filesystem path of the agent's project directory. */
  projectPath: string;
}

/**
 * Session launch action for an agent row.
 *
 * - **No sessions:** Plain "Start Session" button that navigates to /session with the agent's
 *   project path as the `dir` param.
 * - **Has sessions:** "Open Session" button that opens a popover listing active sessions,
 *   each navigating to /session with the session ID. Also includes "New Session" at the bottom.
 */
export function SessionLaunchPopover({ projectPath }: SessionLaunchPopoverProps) {
  const navigate = useNavigate();
  const { sessions: allSessions } = useSessions();

  const agentSessions = useMemo(
    () => allSessions.filter((s) => s.cwd === projectPath),
    [allSessions, projectPath]
  );
  const activeCount = agentSessions.length;

  if (activeCount === 0) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-7 min-h-[44px] text-xs sm:min-h-0"
        onClick={() => navigate({ to: '/session', search: { dir: projectPath } })}
      >
        Start Session
      </Button>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 min-h-[44px] gap-1.5 text-xs sm:min-h-0">
          Open Session
          <Badge variant="secondary" className="ml-1 text-[10px]">
            {activeCount}
          </Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="end">
        <div className="space-y-1">
          {agentSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className="hover:bg-accent flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm sm:min-h-0"
              onClick={() => navigate({ to: '/session', search: { session: session.id } })}
            >
              <div className="flex-1 truncate">
                <span className="text-muted-foreground font-mono text-xs">
                  {session.id.slice(0, 8)}...
                </span>
                {session.lastMessagePreview && (
                  <p className="text-muted-foreground truncate text-xs">
                    {session.lastMessagePreview}
                  </p>
                )}
              </div>
            </button>
          ))}
          <div className="mt-1 border-t pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-xs"
              onClick={() => navigate({ to: '/session', search: { dir: projectPath } })}
            >
              New Session
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
