/**
 * A burst of prompts from one agent, as one card.
 *
 * Five files to read is one decision, not five, and answering it five times is
 * the failure the shipped batch bar existed to prevent. This is that behaviour
 * with the card's own chrome: one headline, one **Allow all**, and the list
 * itself a disclosure for whoever wants to check before saying yes.
 *
 * Presentational on purpose — it takes the lines and the two handlers rather
 * than reaching for a store. Two surfaces draw it from two different shapes
 * (the tray from the fleet-wide list, the session's input zone from the tool
 * calls it already holds), and neither should have to convert into the other's.
 *
 * @module features/ask/ui/AskStack
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { AskCard } from './AskCard';

/** One prompt inside a burst. */
interface AskStackItem {
  /** The interaction id — the stable key. */
  id: string;
  /** What it is asking for, in one line. */
  line: string;
}

/** What {@link AskStack} takes. */
export interface AskStackProps {
  /** The prompts in this burst. Same session, same tool, all approvals. */
  items: readonly AskStackItem[];
  /** The one sentence at the top. */
  headline: string;
  /** The session's directory, for the agent's face. Omitted draws no face. */
  cwd?: string;
  /** Allow every prompt in the burst. */
  onAllowAll: () => void;
  /** Refuse every prompt in the burst. */
  onDenyAll: () => void;
  /** True while an answer is in flight. */
  isAnswering?: boolean;
  /** Whatever went wrong with the last answer. */
  error?: string | null;
  className?: string;
}

/**
 * One agent's burst of same-tool approvals.
 *
 * Never mixes agents and never mixes tools: those are different decisions, and
 * a single Allow over the lot of them would be a person answering something
 * they were not shown. `groupAsks` is what decides membership.
 */
export function AskStack({
  items,
  headline,
  cwd,
  onAllowAll,
  onDenyAll,
  isAnswering = false,
  error,
  className,
}: AskStackProps) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <AskCard.Root
      onAllow={onAllowAll}
      onDeny={onDenyAll}
      className={className}
      data-testid="ask-stack"
      data-ask-count={String(items.length)}
    >
      <div className="flex min-w-0 items-center gap-2">
        {cwd !== undefined && <AskCard.Face cwd={cwd} />}
        <button
          type="button"
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          <AskCard.Headline className="min-w-0 flex-1 truncate">{headline}</AskCard.Headline>
          <Chevron className="text-muted-foreground size-4 shrink-0" aria-hidden />
        </button>
      </div>

      {open && (
        <AskCard.Detail className="mt-2">
          {items.map((item) => (
            <p key={item.id}>{item.line}</p>
          ))}
        </AskCard.Detail>
      )}

      {error && <p className="text-status-error text-2xs mt-2">{error}</p>}

      <AskCard.Actions className="mt-2">
        <Button size="sm" data-slot="ask-allow-all" disabled={isAnswering} onClick={onAllowAll}>
          Allow all
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-slot="ask-deny-all"
          disabled={isAnswering}
          onClick={onDenyAll}
        >
          Deny all
        </Button>
      </AskCard.Actions>
    </AskCard.Root>
  );
}
