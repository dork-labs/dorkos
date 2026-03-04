import { useActiveRunCount, useCompletedRunBadge, usePulseEnabled } from '@/layers/entities/pulse';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useAgentToolStatus, type ChipState } from '@/layers/entities/agent';
import { useAppStore } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { icons } from '@dorkos/icons/registry';

interface AgentContextChipsProps {
  /** Working directory path for per-agent tool status resolution. Pass null to use global flags only. */
  projectPath?: string | null;
}

/**
 * Compact row of status chips showing Pulse/Relay/Mesh status at a glance.
 * Each chip opens its respective panel dialog on click via Zustand actions.
 *
 * Rendering rules per ChipState:
 * - `enabled`: Colored chip, normal opacity.
 * - `disabled-by-agent`: Muted chip, reduced opacity with `[off]` suffix in tooltip.
 * - `disabled-by-server`: Chip hidden entirely (not rendered).
 *
 * Design principles:
 * - Tooltip-first: status details shown in tooltips, not inline labels
 * - Muted disabled states: visually de-emphasizes disabled features without hiding them
 * - Status dots: animated green for active Pulse runs, amber for unviewed, blue for Mesh agents
 */
export function AgentContextChips({ projectPath = null }: AgentContextChipsProps) {
  const toolStatus = useAgentToolStatus(projectPath);
  const pulseEnabled = toolStatus.pulse !== 'disabled-by-server';
  const { data: activeRunCount = 0 } = useActiveRunCount(pulseEnabled);
  const { unviewedCount } = useCompletedRunBadge(pulseEnabled);
  const { data: agentsData } = useRegisteredAgents();
  const agents = agentsData?.agents ?? [];
  const { setPulseOpen, setRelayOpen, setMeshOpen } = useAppStore();

  const pulseTooltip = getPulseTooltip(toolStatus.pulse, activeRunCount, unviewedCount, projectPath);
  const relayTooltip = getToolTooltip('Relay messaging', toolStatus.relay, projectPath);
  const meshTooltip =
    toolStatus.mesh === 'disabled-by-agent'
      ? `Mesh — disabled for this agent`
      : agents.length > 0
        ? `${agents.length} agent${agents.length > 1 ? 's' : ''} registered`
        : 'No agents registered';

  // disabled-by-server chips are hidden entirely
  if (toolStatus.pulse === 'disabled-by-server' && toolStatus.relay === 'disabled-by-server' && toolStatus.mesh === 'disabled-by-server') {
    return null;
  }

  return (
    <div className="flex items-center gap-1 px-2 py-1">
      {toolStatus.pulse !== 'disabled-by-server' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setPulseOpen(true)}
              className={cn(
                'relative rounded-md p-1.5 transition-colors duration-150',
                toolStatus.pulse === 'enabled'
                  ? 'text-muted-foreground/50 hover:text-muted-foreground'
                  : 'text-muted-foreground/25 hover:text-muted-foreground/40'
              )}
              aria-label="Pulse scheduler"
            >
              <icons.pulse className="size-(--size-icon-sm)" />
              {toolStatus.pulse === 'enabled' && activeRunCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 size-2 animate-pulse rounded-full bg-green-500" />
              )}
              {toolStatus.pulse === 'enabled' && activeRunCount === 0 && unviewedCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-amber-500" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{pulseTooltip}</TooltipContent>
        </Tooltip>
      )}

      {toolStatus.relay !== 'disabled-by-server' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setRelayOpen(true)}
              className={cn(
                'relative rounded-md p-1.5 transition-colors duration-150',
                toolStatus.relay === 'enabled'
                  ? 'text-muted-foreground/50 hover:text-muted-foreground'
                  : 'text-muted-foreground/25 hover:text-muted-foreground/40'
              )}
              aria-label="Relay messaging"
            >
              <icons.relay className="size-(--size-icon-sm)" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{relayTooltip}</TooltipContent>
        </Tooltip>
      )}

      {toolStatus.mesh !== 'disabled-by-server' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setMeshOpen(true)}
              className={cn(
                'relative rounded-md p-1.5 transition-colors duration-150',
                toolStatus.mesh === 'enabled'
                  ? 'text-muted-foreground/50 hover:text-muted-foreground'
                  : 'text-muted-foreground/25 hover:text-muted-foreground/40'
              )}
              aria-label="Mesh discovery"
            >
              <icons.mesh className="size-(--size-icon-sm)" />
              {toolStatus.mesh === 'enabled' && agents.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-blue-500" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{meshTooltip}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/** Build Pulse chip tooltip text based on per-agent chip state and run counts. */
function getPulseTooltip(
  state: ChipState,
  activeRuns: number,
  unviewed: number,
  projectPath: string | null,
): string {
  if (state === 'disabled-by-agent') {
    return projectPath ? `Pulse — disabled for this agent` : 'Pulse — disabled for this agent';
  }
  if (activeRuns > 0) return `${activeRuns} run${activeRuns > 1 ? 's' : ''} active`;
  if (unviewed > 0) return `${unviewed} completed run${unviewed > 1 ? 's' : ''} unviewed`;
  return 'Pulse — no active runs';
}

/** Build a generic tool chip tooltip based on chip state. */
function getToolTooltip(label: string, state: ChipState, _projectPath: string | null): string {
  if (state === 'disabled-by-agent') return `${label} — disabled for this agent`;
  return label;
}
