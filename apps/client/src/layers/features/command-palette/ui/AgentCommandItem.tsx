import { Check } from 'lucide-react';
import { CommandItem } from '@/layers/shared/ui';
import { hashToHslColor, hashToEmoji, shortenHomePath } from '@/layers/shared/lib';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

interface AgentCommandItemProps {
  /** Agent data from useMeshAgentPaths */
  agent: AgentPathEntry;
  /** Whether this is the currently active agent */
  isActive: boolean;
  /** Called when the user selects this agent */
  onSelect: (e: React.MouseEvent | React.KeyboardEvent) => void;
}

/**
 * Custom CommandItem rendering for agent rows in the global palette.
 *
 * Layout:
 * [colored dot] emoji agent-name          ~/path/to/project    [checkmark if active]
 *                     "Optional description"
 *
 * Color and emoji use agent overrides when present, otherwise fall back to
 * hash-based deterministic values derived from the agent id.
 */
export function AgentCommandItem({ agent, isActive, onSelect }: AgentCommandItemProps) {
  const color = agent.color ?? hashToHslColor(agent.id);
  const emoji = agent.icon ?? hashToEmoji(agent.id);

  return (
    <CommandItem
      value={agent.name}
      keywords={[agent.projectPath, agent.id]}
      onSelect={() => {
        onSelect({} as React.MouseEvent);
      }}
      className="flex items-start gap-2 py-2"
      forceMount={isActive ? true : undefined}
    >
      {/* Colored dot */}
      <span
        className="mt-1.5 size-2.5 flex-shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />

      {/* Agent info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm">{emoji}</span>
          <span className="truncate text-sm font-semibold">{agent.name}</span>
          <span className="text-muted-foreground ml-auto flex-shrink-0 text-xs">
            {shortenHomePath(agent.projectPath)}
          </span>
          {isActive && <Check className="text-muted-foreground size-4 flex-shrink-0" />}
        </div>
      </div>
    </CommandItem>
  );
}
