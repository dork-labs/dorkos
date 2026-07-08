import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAgentSessions } from '@/layers/entities/session';
import { RuntimeSetupDialog, useRuntimeReadiness } from '@/layers/entities/runtime';
import { renderRuntimeConnect } from '@/layers/features/runtime-connect';
import { Button } from '@/layers/shared/ui/button';
import { Badge } from '@/layers/shared/ui/badge';
import { Popover, PopoverTrigger, PopoverContent } from '@/layers/shared/ui/popover';

interface SessionLaunchPopoverProps {
  /** Filesystem path of the agent's project directory. */
  projectPath: string;
  /**
   * The agent's runtime (from its manifest). Carried as the `?runtime=` launch
   * param on new-session navigations so the session pre-selects it; omitted on
   * existing-session links (a session's runtime is immutable after start).
   */
  runtime?: string;
}

/**
 * Session launch action for an agent row.
 *
 * - **No sessions:** Plain "Start Session" button that navigates to /session with the agent's
 *   project path as the `dir` param.
 * - **Has sessions:** "Open Session" button that opens a popover listing active sessions,
 *   each navigating to /session with the session ID. Also includes "New Session" at the bottom.
 *
 * When the agent's declared runtime is registered but its dependency checks
 * fail (or it is not registered at all), launching would only fail at the
 * first message — so instead of navigating, the launch actions open the
 * runtime setup panel with copyable install/auth commands. Once the checks
 * pass, the same click launches normally.
 */
export function SessionLaunchPopover({ projectPath, runtime }: SessionLaunchPopoverProps) {
  const navigate = useNavigate();
  // Canonical cwd-scoped membership (DOR-203).
  const { sessions: agentSessions } = useAgentSessions(projectPath);
  const readiness = useRuntimeReadiness(runtime);
  const [setupOpen, setSetupOpen] = useState(false);

  const activeCount = agentSessions.length;

  const launchNewSession = () => {
    if (!readiness.ready) {
      setSetupOpen(true);
      return;
    }
    void navigate({ to: '/session', search: { dir: projectPath, runtime } });
  };

  // Rendered outside the popover so it survives the popover closing.
  const setupDialog = runtime ? (
    <RuntimeSetupDialog
      runtime={runtime}
      open={setupOpen}
      onOpenChange={setSetupOpen}
      renderConnect={renderRuntimeConnect}
      onRuntimeReady={(type) => {
        // Connect succeeded → launch the session that was waiting on it.
        setSetupOpen(false);
        void navigate({ to: '/session', search: { dir: projectPath, runtime: type } });
      }}
    />
  ) : null;

  if (activeCount === 0) {
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          className="h-7 min-h-[44px] text-xs sm:min-h-0"
          onClick={launchNewSession}
        >
          Start Session
        </Button>
        {setupDialog}
      </>
    );
  }

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 min-h-[44px] gap-1.5 text-xs sm:min-h-0"
          >
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
                onClick={launchNewSession}
              >
                New Session
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {setupDialog}
    </>
  );
}
