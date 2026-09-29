/**
 * One short row that asks a person something, and the same row once they
 * answered (spec `flow-multiproject` V1, V8; DOR-2517).
 *
 * @module features/inbox/ui/InboxDecisionRow
 */
import { useId, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Info, ThumbsDown, ThumbsUp, type LucideIcon } from 'lucide-react';
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

/** A yes-or-no answer drawn as 👎 and 👍, each labelled as its outcome. */
export interface InboxDecisionYesNo {
  kind: 'yes-no';
  /** What 👍 does, as an outcome: "Turn it on". */
  approveLabel: string;
  /** What 👎 does, as an outcome: "Not now". */
  rejectLabel: string;
  onApprove(): void;
  onReject(): void;
}

/** One small text button, for an answer that is not yes or no ("Answer", "Reconnect"). */
export interface InboxDecisionWord {
  kind: 'word';
  label: string;
  onClick(): void;
}

/** Props for {@link InboxDecisionRow}. */
export interface InboxDecisionRowProps {
  /** The mark in the row's icon tile. */
  icon: LucideIcon;
  /** A question or an outcome, never a command: "Turn on Flow?". */
  title: string;
  /**
   * The second line: what happens, why now, and what "no" means. Drawn in the
   * row's normal text colour and never cut below two lines. Optional only for
   * a history row, which has already been answered.
   */
  why?: string;
  /** The muted mono line: "flow plugin · dork-labs/marketplace". */
  sourceLine?: string;
  /**
   * What follows the title on a history row, joined with " · ": the time, and
   * what happened or what can still be done.
   */
  trail?: ReactNode[];
  /** The ⓘ panel's content. With none, there is no ⓘ button. */
  more?: ReactNode;
  /**
   * The answers. Absent on a history row, which draws in its compact form with
   * no buttons.
   */
  actions?: InboxDecisionYesNo | InboxDecisionWord;
  /** Which answer is in flight, so every button waits for it. */
  pending?: 'approve' | 'reject' | 'word' | null;
  /** What clicking the title does, when the item links somewhere. */
  onOpen?: () => void;
}

/** One 26px outlined icon button with its name as a tooltip. */
function IconAction({
  label,
  icon: Icon,
  onClick,
  disabled,
  pressed,
  expanded,
  controls,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  controls?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          responsive={false}
          aria-label={label}
          aria-pressed={pressed}
          aria-expanded={expanded}
          aria-controls={controls}
          disabled={disabled}
          onClick={onClick}
          className={cn('size-[26px]', pressed && 'bg-accent text-accent-foreground')}
        >
          <Icon aria-hidden className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A decision in the inbox, in one short row.
 *
 * **Presentational.** It takes the words and the callbacks and owns only
 * whether ⓘ is open, which is what lets a widget wire it to any data it holds
 * without this row importing another feature.
 *
 * **Three icon buttons, in this order: ⓘ, 👎, 👍.** Real icons from the house
 * set, each with its name as a tooltip and as its accessible name, and the two
 * answers named as outcomes ("Not now", "Turn it on") rather than as yes and
 * no (V8).
 *
 * **ⓘ grows the row in place.** It never opens a popover, on any screen: the
 * panel slides open below the row, ⓘ shows as pressed, and focus stays on it.
 *
 * **A history row is the same row, answered.** With no `actions` it draws
 * compactly — the title, then its `trail` — so the Activity list reads the
 * outcome in the words the question was asked in.
 *
 * @param props - The words, the answers and what is in flight.
 */
export function InboxDecisionRow({
  icon: Icon,
  title,
  why,
  sourceLine,
  trail,
  more,
  actions,
  pending = null,
  onOpen,
}: InboxDecisionRowProps) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const reducedMotion = useReducedMotion();
  const busy = pending !== null;
  const history = actions === undefined;

  const titleText = onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className="hover:text-foreground focus-visible:ring-ring/60 rounded-sm text-left outline-none hover:underline focus-visible:ring-2"
    >
      {title}
    </button>
  ) : (
    title
  );

  return (
    <div
      data-slot="inbox-decision-row"
      data-history={history ? 'true' : 'false'}
      className="min-w-0"
    >
      <div className={cn('flex min-w-0 items-start gap-2.5 px-2', history ? 'py-1' : 'py-1.5')}>
        <span
          aria-hidden
          className={cn(
            'bg-muted text-muted-foreground flex shrink-0 items-center justify-center rounded-md border',
            history ? 'size-[18px]' : 'size-7'
          )}
        >
          <Icon className={history ? 'size-3' : 'size-4'} />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'text-xs',
              history ? 'text-foreground/90' : 'text-foreground text-[13px] font-semibold'
            )}
          >
            {titleText}
            {trail?.map((part, index) => (
              <span key={index} className="text-muted-foreground font-normal">
                {' · '}
                {part}
              </span>
            ))}
          </p>
          {why && <p className="text-foreground mt-0.5 text-xs leading-snug">{why}</p>}
          {sourceLine && (
            <p className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]">
              {sourceLine}
            </p>
          )}
        </div>
        {actions && (
          <TooltipProvider>
            <div className="flex shrink-0 items-center gap-1 pt-0.5">
              {more !== undefined && (
                <IconAction
                  label="More about this"
                  icon={Info}
                  onClick={() => setExpanded((open) => !open)}
                  pressed={expanded}
                  expanded={expanded}
                  controls={expanded ? panelId : undefined}
                />
              )}
              {actions.kind === 'yes-no' ? (
                <>
                  <IconAction
                    label={actions.rejectLabel}
                    icon={ThumbsDown}
                    onClick={actions.onReject}
                    disabled={busy}
                  />
                  <IconAction
                    label={actions.approveLabel}
                    icon={ThumbsUp}
                    onClick={actions.onApprove}
                    disabled={busy}
                  />
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  responsive={false}
                  onClick={actions.onClick}
                  disabled={busy}
                >
                  {actions.label}
                </Button>
              )}
            </div>
          </TooltipProvider>
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded && more !== undefined && (
          <motion.div
            key="more"
            id={panelId}
            initial={reducedMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={
              reducedMotion
                ? { opacity: 0, transition: { duration: 0 } }
                : { height: 0, opacity: 0 }
            }
            transition={{ duration: reducedMotion ? 0 : 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="bg-muted/60 text-muted-foreground mx-2 mb-1.5 space-y-1.5 rounded-md p-2.5 text-xs">
              {more}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
