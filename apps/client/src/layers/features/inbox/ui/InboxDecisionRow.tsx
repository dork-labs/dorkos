/**
 * One short row that asks a person something, and the same row once they
 * answered (spec `flow-multiproject` V1, V2, V8, V9; DOR-2517, DOR-2523).
 *
 * @module features/inbox/ui/InboxDecisionRow
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Info, ThumbsDown, ThumbsUp, type LucideIcon } from 'lucide-react';
import {
  Button,
  Textarea,
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
  /**
   * 👎 first asks for a short note ("What needs to change?") and sends it
   * with the answer. It never closes anything by itself.
   */
  rejectNote?: { onSubmit(note: string): void };
}

/** One small text button, for an answer that is not yes or no ("Answer", "Reconnect"). */
export interface InboxDecisionWord {
  kind: 'word';
  label: string;
  onClick(): void;
  /** The button opens an inline field instead, and sends what is typed. */
  input?: { placeholder: string; maxLength: number; onSubmit(text: string): void };
}

/** A question: chips, the agent's pick marked, and maybe a deadline and "Reply…". */
export interface InboxDecisionChoice {
  kind: 'choice';
  choices: { id: string; label: string }[];
  /** The agent's pick, marked "agent's pick", or null when there is none. */
  defaultChoiceId: string | null;
  /** "If you don't answer by 5pm, the agent picks “Keep it”.", or null for no deadline. */
  deadlineLine: string | null;
  /** Offer "Reply…" with free text. */
  allowReply: boolean;
  onChoose(id: string): void;
  onReply(text: string): void;
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
  /** The muted mono line: "flow plugin · dork-labs/marketplace", or the extension's name. */
  sourceLine?: string;
  /** A muted line of timing: "since 09:14 · asked after 1h". */
  meta?: string;
  /** A line that needs the reader: "The agent couldn't go ahead. It needs you." */
  notice?: string;
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
  actions?: InboxDecisionYesNo | InboxDecisionWord | InboxDecisionChoice;
  /** Which answer is in flight, so every button waits for it. */
  pending?: 'approve' | 'reject' | 'word' | 'choice' | null;
  /** What clicking the title does, when the item links somewhere. */
  onOpen?: () => void;
  /** A chat started about it: "Sorting 12 ideas… · Watch". */
  watch?: { label: string; onWatch(): void } | null;
  /** The one-time green "next time, on its own?" line under an answered row (V9). */
  followUp?: { text: string; onAccept(): void; onDismiss(): void } | null;
  /** A history row the person has not seen yet ("Tell me after"): draws the unread dot. */
  unread?: boolean;
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
 * A short text field inside the row with Send and Cancel: a "Needs changes"
 * note, a typed answer, or a question's "Reply…". Shows a counter once the
 * text is near its limit, and never sends more than the limit.
 */
function InlineAnswer({
  label,
  placeholder,
  maxLength,
  busy,
  onSend,
  onCancel,
}: {
  label: string;
  placeholder: string;
  maxLength: number;
  busy: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  // The field opens because the person just asked for it (👎, "Answer",
  // "Reply…"), so the cursor goes there.
  useEffect(() => {
    field.current?.focus();
  }, []);
  const trimmed = text.trim();
  const nearLimit = text.length >= maxLength * 0.8;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5" data-slot="inbox-decision-answer">
      <Textarea
        aria-label={label}
        placeholder={placeholder}
        value={text}
        maxLength={maxLength}
        rows={2}
        ref={field}
        onChange={(event) => setText(event.target.value.slice(0, maxLength))}
        className="min-h-14 text-xs"
      />
      <div className="flex items-center justify-end gap-1.5">
        {nearLimit && (
          <span className="text-muted-foreground mr-auto text-[11px] tabular-nums">
            {text.length}/{maxLength}
          </span>
        )}
        <Button type="button" variant="ghost" size="xs" responsive={false} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          responsive={false}
          disabled={busy || trimmed.length === 0}
          onClick={() => onSend(trimmed)}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

/**
 * A decision in the inbox, in one short row.
 *
 * **Presentational.** It takes the words and the callbacks and owns only what
 * is open (ⓘ, a note field, "Reply…"), which is what lets a widget wire it to
 * any data it holds without this row importing another feature.
 *
 * **Three icon buttons, in this order: ⓘ, 👎, 👍.** Real icons from the house
 * set, each with its name as a tooltip and as its accessible name, and the two
 * answers named as outcomes ("Not now", "Turn it on") rather than as yes and
 * no (V8). A decision that is not yes or no draws one small word button; a
 * question draws its chips, the agent's pick marked, and its deadline line.
 *
 * **ⓘ grows the row in place.** It never opens a popover, on any screen: the
 * panel slides open below the row, ⓘ shows as pressed, and focus stays on it.
 *
 * **A history row is the same row, answered.** With no `actions` it draws
 * compactly — the title, then its `trail` — so the Activity list reads the
 * outcome in the words the question was asked in. A one-time follow-up offer
 * sits under it as a green line.
 *
 * @param props - The words, the answers and what is in flight.
 */
export function InboxDecisionRow({
  icon: Icon,
  title,
  why,
  sourceLine,
  meta,
  notice,
  trail,
  more,
  actions,
  pending = null,
  onOpen,
  watch,
  followUp,
  unread = false,
}: InboxDecisionRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [answering, setAnswering] = useState<'note' | 'word' | 'reply' | null>(null);
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

  const watchLine = watch ? (
    <span className="text-muted-foreground">
      {watch.label} ·{' '}
      <button
        type="button"
        onClick={watch.onWatch}
        className="text-foreground underline underline-offset-2"
      >
        Watch
      </button>
    </span>
  ) : null;

  return (
    <div
      data-slot="inbox-decision-row"
      data-history={history ? 'true' : 'false'}
      data-unread={unread ? 'true' : undefined}
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
              history ? 'text-foreground/90' : 'text-foreground text-[13px] font-semibold',
              unread && 'text-foreground font-medium'
            )}
          >
            {unread && (
              <>
                <span
                  aria-hidden
                  className="bg-status-info mr-1.5 inline-block size-1.5 rounded-full align-middle"
                />
                <span className="sr-only">Unread. </span>
              </>
            )}
            {titleText}
            {trail?.map((part, index) => (
              <span key={index} className="text-muted-foreground font-normal">
                {' · '}
                {part}
              </span>
            ))}
          </p>
          {why && <p className="text-foreground mt-0.5 text-xs leading-snug">{why}</p>}
          {notice && (
            <p className="text-status-warning-fg mt-0.5 text-xs leading-snug font-medium">
              {notice}
            </p>
          )}
          {meta && <p className="text-muted-foreground mt-0.5 text-[11px]">{meta}</p>}
          {watchLine && <p className="mt-0.5 text-[11px]">{watchLine}</p>}
          {sourceLine && (
            <p className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]">
              {sourceLine}
            </p>
          )}
          {actions?.kind === 'choice' && (
            <div className="mt-1.5" data-slot="inbox-decision-choices">
              <div className="flex flex-wrap gap-1.5">
                {actions.choices.map((choice) => {
                  const pick = choice.id === actions.defaultChoiceId;
                  return (
                    <Button
                      key={choice.id}
                      type="button"
                      variant="outline"
                      size="xs"
                      responsive={false}
                      disabled={busy}
                      onClick={() => actions.onChoose(choice.id)}
                      className={cn('rounded-full', pick && 'border-foreground')}
                    >
                      {choice.label}
                      {pick && (
                        <span className="text-muted-foreground ml-1 font-normal">
                          · agent’s pick
                        </span>
                      )}
                    </Button>
                  );
                })}
                {actions.allowReply && answering !== 'reply' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    responsive={false}
                    disabled={busy}
                    onClick={() => setAnswering('reply')}
                    className="rounded-full"
                  >
                    Reply…
                  </Button>
                )}
              </div>
              {actions.deadlineLine && (
                <p className="text-muted-foreground mt-1 text-[11px]">{actions.deadlineLine}</p>
              )}
              {answering === 'reply' && (
                <InlineAnswer
                  label="Your reply"
                  placeholder="Your reply"
                  maxLength={2000}
                  busy={busy}
                  onCancel={() => setAnswering(null)}
                  onSend={(text) => {
                    setAnswering(null);
                    actions.onReply(text);
                  }}
                />
              )}
            </div>
          )}
          {actions?.kind === 'yes-no' && answering === 'note' && actions.rejectNote && (
            <InlineAnswer
              label="What needs to change?"
              placeholder="What needs to change?"
              maxLength={2000}
              busy={busy}
              onCancel={() => setAnswering(null)}
              onSend={(note) => {
                setAnswering(null);
                actions.rejectNote?.onSubmit(note);
              }}
            />
          )}
          {actions?.kind === 'word' && answering === 'word' && actions.input && (
            <InlineAnswer
              label={actions.label}
              placeholder={actions.input.placeholder}
              maxLength={actions.input.maxLength}
              busy={busy}
              onCancel={() => setAnswering(null)}
              onSend={(text) => {
                setAnswering(null);
                actions.input?.onSubmit(text);
              }}
            />
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
              {actions.kind === 'yes-no' && (
                <>
                  <IconAction
                    label={actions.rejectLabel}
                    icon={ThumbsDown}
                    onClick={actions.rejectNote ? () => setAnswering('note') : actions.onReject}
                    pressed={answering === 'note'}
                    disabled={busy}
                  />
                  <IconAction
                    label={actions.approveLabel}
                    icon={ThumbsUp}
                    onClick={actions.onApprove}
                    disabled={busy}
                  />
                </>
              )}
              {actions.kind === 'word' && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  responsive={false}
                  onClick={actions.input ? () => setAnswering('word') : actions.onClick}
                  disabled={busy || answering === 'word'}
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
      {followUp && (
        <div
          data-slot="inbox-decision-follow-up"
          className="bg-status-success-bg text-status-success-fg border-status-success-border mx-2 mb-1.5 ml-9 flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs"
        >
          <span className="min-w-0">{followUp.text}</span>
          <span className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="xs"
              responsive={false}
              onClick={followUp.onAccept}
            >
              Yes
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              responsive={false}
              aria-label="No thanks"
              onClick={followUp.onDismiss}
              className="text-muted-foreground"
            >
              No thanks
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}
