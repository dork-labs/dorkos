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
  /** Merged onto the row's root element, after the built-in layout classes so a caller can override them. */
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
      {/*
       * `flex-auto` (basis: auto), not `flex-1` (basis: 0%): with a 0%
       * basis, an unbounded sibling (the path below) can overflow the row
       * on its own content alone, and the flex shrink algorithm gives a
       * 0-basis item none of the deficit to absorb — it renders at literal
       * 0 width, not merely truncated. `flex-auto` seeds this item's basis
       * from its own (usually short) content, so it takes its proportional
       * share of any squeeze instead of vanishing first (DOR-970 review).
       *
       * And a floor, because proportional is not enough on its own: a short
       * name loses a large FRACTION of itself while the long path beside it
       * loses a large absolute amount and still reads. "DorkBot" was cut to
       * "Dork…" next to fifty-odd characters of path (DOR-1747). The floor
       * inverts the yield order — the path is provenance, so it gives way
       * first — and it is safe to cross the row's own width only in theory:
       * `secondary` may shrink to nothing, so nothing here can overflow.
       */}
      <span className="min-w-[8ch] flex-auto truncate text-sm font-medium">
        {name ?? getAgentDisplayName(agent)}
      </span>
      {secondary != null && (
        <span
          data-slot="agent-option-row-secondary"
          className="text-muted-foreground min-w-0 shrink truncate text-xs"
        >
          {secondary}
        </span>
      )}
      {trailing ?? (selected && <Check className="size-4 shrink-0" aria-hidden />)}
    </div>
  );
}
