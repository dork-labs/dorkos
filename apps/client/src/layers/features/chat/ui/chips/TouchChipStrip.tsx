/**
 * The touch-chip strip — a turn's record of what it handled, kept at the turn
 * level so it survives the tool cards auto-hiding underneath it.
 *
 * @module features/chat/ui/chips/TouchChipStrip
 */
import { Fragment, useCallback, useId, useMemo, useState } from 'react';
import type { MessagePart } from '@dorkos/shared/types';
import { cn, getPlatform } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { accumulateTouchChips, type TouchChip as TouchChipData } from '../../lib/touch-chips';
import { groupChipsByVerb, VERB_ICON, VERB_LABEL } from './chip-verbs';
import { ChipTray } from './ChipTray';

export interface TouchChipStripProps {
  /** The assistant message's parts, in transcript order. */
  parts: MessagePart[];
}

/** One verb's tally in the collapsed line: `📖 21`, or `✏️ 3 +34 −11`. */
function SummaryGroup({
  verb,
  count,
  additions,
  deletions,
}: {
  verb: TouchChipData['verb'];
  count: number;
  additions?: number;
  deletions?: number;
}) {
  return (
    <span data-testid={`chip-summary-${verb}`} className="inline-flex items-center gap-1">
      <span aria-hidden="true">{VERB_ICON[verb]}</span>
      <span className="sr-only">{VERB_LABEL[verb]}</span>
      <span className="tabular-nums">{count}</span>
      {(additions !== undefined || deletions !== undefined) && (
        <span className="tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{additions ?? 0}</span>{' '}
          <span className="text-red-600 dark:text-red-400">−{deletions ?? 0}</span>
        </span>
      )}
    </span>
  );
}

/**
 * Derive the turn's chips and show them: one quiet line of tallies, and — behind
 * a disclosure — the full roster.
 *
 * The chips are derived on render from `parts` rather than accumulated into a
 * store, so a replayed or rehydrated transcript can never disagree with what is
 * on screen. A turn that touched nothing renders nothing at all.
 *
 * Expansion is plain component state: the design calls for it to be per-message
 * and not remembered, so there is nothing here worth persisting.
 *
 * @param props - The message's parts.
 */
export function TouchChipStrip({ parts }: TouchChipStripProps) {
  const chips = useMemo(() => accumulateTouchChips(parts), [parts]);
  const [expanded, setExpanded] = useState(false);
  const trayId = useId();
  const openCanvasDocument = useAppStore((s) => s.openCanvasDocument);
  const setCanvasOpen = useAppStore((s) => s.setCanvasOpen);

  const handleOpen = useCallback(
    (chip: TouchChipData) => {
      const embedded = getPlatform().isEmbedded;

      if (chip.kind === 'url') {
        // No canvas inside Obsidian, so the page opens where it can: a new tab.
        if (embedded) {
          window.open(chip.fullTarget, '_blank', 'noopener,noreferrer');
          return;
        }
        openCanvasDocument({ type: 'url', url: chip.fullTarget });
        setCanvasOpen(true);
        return;
      }

      if (chip.kind === 'file') {
        // A file chip in the plugin is a record with a tooltip and nothing more —
        // there is no pane to open it into. Revisit when that surface is verified.
        if (embedded) return;
        openCanvasDocument({ type: 'file', sourcePath: chip.fullTarget });
        setCanvasOpen(true);
      }

      // A bare command or a search pattern has no target to open.
    },
    [openCanvasDocument, setCanvasOpen]
  );

  const groups = useMemo(() => groupChipsByVerb(chips), [chips]);

  if (chips.length === 0) return null;

  return (
    <div data-testid="touch-chip-strip" className="mt-2 flex flex-col gap-2">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
        {groups.map((group, index) => (
          <Fragment key={group.verb}>
            {index > 0 && <span aria-hidden="true">·</span>}
            <SummaryGroup
              verb={group.verb}
              count={group.chips.length}
              additions={group.additions}
              deletions={group.deletions}
            />
          </Fragment>
        ))}
        <span aria-hidden="true">—</span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={trayId}
          onClick={() => setExpanded((open) => !open)}
          className={cn(
            'hover:text-foreground rounded-sm underline underline-offset-2',
            'focus-visible:ring-ring/50 outline-none focus-visible:ring-2'
          )}
        >
          {expanded ? 'hide' : 'show all'}
        </button>
      </div>
      {expanded && <ChipTray id={trayId} chips={chips} onOpen={handleOpen} />}
    </div>
  );
}
