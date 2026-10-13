import { useNavigate } from '@tanstack/react-router';
import { useExperimentEnabledState } from '@/layers/entities/config';
import { setSessionRouteContext } from '@/layers/entities/session';
import { toSession } from '@/layers/shared/lib';
import { AgentComputerPanel } from './AgentComputerPanel';

/** Show the experimental computer only after the server confirms the switch is on. */
export function TeamComputerEntry() {
  const { enabled } = useExperimentEnabledState('computers.enabled');
  const navigate = useNavigate();
  if (!enabled) return null;

  return (
    <div data-slot="team-computer-entry" className="px-4 py-4 sm:px-6">
      <AgentComputerPanel
        onOpenSession={(session) => {
          setSessionRouteContext(session.id, {
            cwd: session.cwd,
            runtime: session.runtime,
            draft: false,
          });
          void navigate(toSession({ session: session.id, runtime: session.runtime }));
        }}
      />
    </div>
  );
}
