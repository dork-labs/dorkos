/**
 * The "and N more steps…" collapse over a run of quiet blocks.
 *
 * Split out of `AssistantMessageContent` with the auto-hiding parts it wraps:
 * it is about a RUN of them, which makes it the same idea one level up.
 *
 * @module features/chat/ui/message/CollapsibleRun
 */
import { useState } from 'react';
import { CollapsibleCard } from '../primitives';

/** Minimum run length before the "N more" collapse kicks in. */
export const COLLAPSE_THRESHOLD = 4;
/** Number of items shown before the collapse button. */
export const VISIBLE_COUNT = 2;

/**
 * Wraps a run of consecutive tool/thinking elements with a "show N more" collapse.
 * Runs shorter than COLLAPSE_THRESHOLD render all children directly.
 * Uses CollapsibleCard as the visual base to stay in the same family as tool calls and thinking.
 *
 * @param props - The run of elements to collapse.
 */
export function CollapsibleRun({ children }: { children: React.ReactNode[] }) {
  const [expanded, setExpanded] = useState(false);

  if (children.length <= COLLAPSE_THRESHOLD || expanded) {
    return <>{children}</>;
  }

  const hiddenCount = children.length - VISIBLE_COUNT;

  return (
    <>
      {children.slice(0, VISIBLE_COUNT)}
      {/* The card's own chevron, not a hand-drawn one: `hideChevron` also drops
          `aria-expanded`, and this header IS a real expand control — a screen
          reader has to hear that it is collapsed. */}
      <CollapsibleCard
        expanded={false}
        onToggle={() => setExpanded(true)}
        ariaLabel={`Show ${hiddenCount} more steps`}
        className="border-l-muted-foreground/15"
        header={
          <span className="text-3xs text-muted-foreground font-mono">
            and {hiddenCount} more steps&hellip;
          </span>
        }
      >
        <></>
      </CollapsibleCard>
    </>
  );
}
