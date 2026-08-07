import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn, getAgentDisplayName } from '@/layers/shared/lib';
import { resolveAgentVisual } from '../model/use-agent-visual';
import { AgentAvatar } from './AgentAvatar';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

export interface AgentOptionRowProps {
  /** The agent this row represents — resolves the avatar's colour/emoji and the default display name. */
  agent: AgentPathEntry;
  /**
   * Overrides the plain display name, e.g. a fuzzy-match-highlighted node.
   * Defaults to {@link getAgentDisplayName}. `entities/` may not import the
   * highlighter itself (a `features/command-palette` concern) — the caller
   * renders it and hands the result in.
   */
  name?: ReactNode;
  /** Secondary text — typically the agent's shortened project path. */
  secondary?: ReactNode;
  /** Content at the row's trailing edge. Defaults to a checkmark when `selected` is true and no `trailing` is given. */
  trailing?: ReactNode;
  /** True when this row is the current selection — drives the default checkmark. */
  selected?: boolean;
  className?: string;
}

/**
 * One agent row — avatar, name, secondary text, trailing content — shared by
 * every `Command`-based single-select agent picker (`AgentPicker`,
 * `AgentCommandItem`). Purely presentational: the caller owns selection
 * state, the outer `CommandItem` and its `onSelect`.
 *
 * `AgentChipPicker`'s multi-select row is deliberately NOT built on this —
 * its keyboard model is genuinely different, and merging it would be
 * coincidental-duplication extraction (DOR-970).
 */
export function AgentOptionRow({
  agent,
  name,
  secondary,
  trailing,
  selected,
  className,
}: AgentOptionRowProps) {
  const { color, emoji } = resolveAgentVisual(agent);

  return (
    <div className={cn('flex w-full min-w-0 items-center gap-2', className)}>
      <AgentAvatar color={color} emoji={emoji} size="xs" className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {name ?? getAgentDisplayName(agent)}
      </span>
      {secondary != null && (
        <span
          data-slot="agent-option-row-secondary"
          className="text-muted-foreground shrink-0 truncate text-xs"
        >
          {secondary}
        </span>
      )}
      {trailing ?? (selected && <Check className="size-4 shrink-0" aria-hidden />)}
    </div>
  );
}
