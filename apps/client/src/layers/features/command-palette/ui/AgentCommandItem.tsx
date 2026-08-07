import { motion } from 'motion/react';
import { CommandItem } from '@/layers/shared/ui';
import { getAgentDisplayName, shortenHomePath } from '@/layers/shared/lib';
import { AgentOptionRow } from '@/layers/entities/agent';
import { HighlightedText } from './HighlightedText';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

interface AgentCommandItemProps {
  /** Agent data from useMeshAgentPaths */
  agent: AgentPathEntry;
  /** Whether this is the currently active agent */
  isActive: boolean;
  /** Called when the user selects this agent */
  onSelect: () => void;
  /** Fuse.js match indices for highlighting the agent name */
  nameIndices?: readonly [number, number][];
  /**
   * Whether this item is currently focused/selected in the palette.
   * When true, renders the sliding selection indicator behind the item content.
   */
  isSelected?: boolean;
}

/**
 * Custom CommandItem rendering for agent rows in the global palette.
 *
 * The avatar/name/secondary-path/checkmark row itself is
 * `entities/agent`'s `AgentOptionRow` — this file owns only what is
 * palette-specific:
 *
 * - When `nameIndices` is provided, the agent name is rendered with matched
 *   characters bolded via `HighlightedText`.
 * - When `isSelected` is true, a `motion.div` with
 *   `layoutId="cmd-palette-selection"` renders as an absolutely-positioned
 *   background behind the item content. The sliding indicator animates
 *   between items during keyboard navigation using motion's shared layout
 *   animation system.
 */
export function AgentCommandItem({
  agent,
  isActive,
  onSelect,
  nameIndices,
  isSelected,
}: AgentCommandItemProps) {
  return (
    <CommandItem
      value={getAgentDisplayName(agent)}
      keywords={[agent.name, agent.projectPath, agent.id]}
      onSelect={() => onSelect()}
      className="relative py-2"
      forceMount={isActive ? true : undefined}
    >
      {/* Sliding selection background — animates between items via shared layoutId */}
      {isSelected && (
        <motion.div
          layoutId="cmd-palette-selection"
          className="bg-accent absolute inset-0 rounded-sm"
          transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
        />
      )}

      {/* Content above the selection indicator */}
      <div className="relative z-10 w-full">
        <AgentOptionRow
          agent={agent}
          name={
            nameIndices ? (
              <HighlightedText
                text={getAgentDisplayName(agent)}
                indices={nameIndices}
                className="truncate text-sm font-semibold"
              />
            ) : (
              <span className="truncate text-sm font-semibold">{getAgentDisplayName(agent)}</span>
            )
          }
          secondary={shortenHomePath(agent.projectPath)}
          selected={isActive}
        />
      </div>
    </CommandItem>
  );
}
