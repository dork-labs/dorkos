import { Check } from 'lucide-react';
import { motion } from 'motion/react';
import { CommandItem } from '@/layers/shared/ui';
import { shortenHomePath } from '@/layers/shared/lib';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
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
 * Layout:
 * [colored dot] emoji agent-name          ~/path/to/project    [checkmark if active]
 *                     "Optional description"
 *
 * Color and emoji use agent overrides when present, otherwise fall back to
 * hash-based deterministic values derived from the agent id.
 *
 * When nameIndices is provided, the agent name is rendered with matched
 * characters bolded via HighlightedText.
 *
 * When isSelected is true, a motion.div with layoutId="cmd-palette-selection"
 * renders as an absolutely-positioned background behind the item content.
 * The sliding indicator animates between items during keyboard navigation
 * using motion's shared layout animation system.
 */
export function AgentCommandItem({
  agent,
  isActive,
  onSelect,
  nameIndices,
  isSelected,
}: AgentCommandItemProps) {
  const { color, emoji } = resolveAgentVisual(agent);

  return (
    <CommandItem
      value={agent.name}
      keywords={[agent.projectPath, agent.id]}
      onSelect={() => onSelect()}
      className="relative flex items-start gap-2 py-2"
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
      <div className="relative z-10 flex w-full items-start gap-2">
        <AgentAvatar color={color} emoji={emoji} size="xs" className="mt-0.5 flex-shrink-0" />

        {/* Agent info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {nameIndices ? (
              <HighlightedText
                text={agent.name}
                indices={nameIndices}
                className="truncate text-sm font-semibold"
              />
            ) : (
              <span className="truncate text-sm font-semibold">{agent.name}</span>
            )}
            <span className="text-muted-foreground ml-auto flex-shrink-0 text-xs">
              {shortenHomePath(agent.projectPath)}
            </span>
            {isActive && <Check className="text-muted-foreground size-4 flex-shrink-0" />}
          </div>
        </div>
      </div>
    </CommandItem>
  );
}
