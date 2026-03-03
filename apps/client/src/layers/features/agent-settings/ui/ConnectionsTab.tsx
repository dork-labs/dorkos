import { usePulseEnabled } from '@/layers/entities/pulse';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useMeshAgentHealth } from '@/layers/entities/mesh';
import { Badge } from '@/layers/shared/ui';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

interface ConnectionsTabProps {
  agent: AgentManifest;
}

/**
 * Read-only connections tab showing status of Pulse, Relay, and Mesh subsystems
 * for the current agent.
 */
export function ConnectionsTab({ agent }: ConnectionsTabProps) {
  const pulseEnabled = usePulseEnabled();
  const relayEnabled = useRelayEnabled();
  const { data: health } = useMeshAgentHealth(agent.id);

  return (
    <div className="space-y-6">
      {/* Pulse */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Pulse Schedules</h3>
          <Badge variant={pulseEnabled ? 'default' : 'secondary'} className="text-xs">
            {pulseEnabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          {pulseEnabled
            ? 'Configure automated schedules for this agent in the Pulse panel.'
            : 'Enable Pulse to schedule automated agent runs.'}
        </p>
      </section>

      {/* Relay */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Relay Endpoints</h3>
          <Badge variant={relayEnabled ? 'default' : 'secondary'} className="text-xs">
            {relayEnabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          {relayEnabled
            ? 'Manage messaging endpoints for this agent in the Relay panel.'
            : 'Enable Relay for inter-agent messaging.'}
        </p>
      </section>

      {/* Mesh */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Mesh Health</h3>
          <Badge variant="default" className="text-xs">Enabled</Badge>
        </div>
        {health ? (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm">Status:</span>
            <Badge
              variant={health.status === 'active' ? 'default' : 'secondary'}
              className="text-xs"
            >
              {health.status}
            </Badge>
            {health.lastSeenAt && (
              <span className="text-muted-foreground text-xs">
                Last seen {new Date(health.lastSeenAt).toLocaleString()}
              </span>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Loading health information...</p>
        )}
      </section>
    </div>
  );
}
