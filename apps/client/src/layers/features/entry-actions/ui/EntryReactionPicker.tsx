import { useId, useMemo, useState, type KeyboardEvent, type Ref } from 'react';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  PRESS_MARK,
} from '@/layers/shared/ui';
import { EMOJI_GROUPS, emojiLabel, searchEmoji } from '../lib/emoji-catalog';

interface EntryReactionGridProps {
  /** Which emoji this reader has already put on the message. */
  mine: readonly string[];
  /** This reader's most-used emoji, drawn first under their own heading. */
  frequents: readonly string[];
  /** Put one on, or take it back. */
  onPick: (emoji: string) => void;
  /**
   * True when reacting cannot land — a room whose stream has died.
   *
   * Gated HERE and not only on whatever opened this grid: a picker is a surface
   * that stays on screen, so the room can go quiet while it is open and the
   * options a person is looking at were drawn while it was still live.
   */
  disabled?: boolean;
}

/**
 * The picker's body: a search field over a grouped grid.
 *
 * Its own component because both surfaces draw it — a popover under the capsule
 * on a pointer device, and inline inside the long-press drawer on a touch screen
 * — and they must offer the same set in the same order. One strip, two frames.
 *
 * Search matches keyword prefixes over the catalog (`emoji-catalog.ts`); a blank
 * field draws the full grouped grid, which is what makes browsing possible for
 * somebody who does not know what the thing they want is called.
 *
 * **Every group carries its heading as its accessible name.** The quick row
 * repeats emoji that also live in the catalog below it — that is the point of it
 * — so the open picker draws three buttons whose own names are duplicates of
 * three others. The names are not ambiguous, but the CONTROLS are: "the heart
 * button" resolves to two, which is a thing neither a screen-reader user nor a
 * browser spec can address. Naming the groups makes each one uniquely reachable
 * as "Your most used → heart" rather than bare "heart".
 *
 * `role="group"` rather than the `region` a named `<section>` would imply: these
 * are sets of related controls inside a popover, not landmarks of the page, and
 * eleven landmarks in a dropdown is a worse experience than none.
 *
 * **A stalled room disables the options and says so; it does not close the
 * picker.** Closing was the other candidate and is worse twice over: it yanks a
 * surface out from under somebody mid-interaction, and it explains nothing — a
 * picker that vanishes on its own reads as a bug rather than as a room that has
 * gone quiet. Disabling matches every other reaction control (the pills, the
 * ghost +, the quick row) and leaves somewhere to put the reason. Search stays
 * live, because browsing costs the server nothing and a dead field would make
 * the surface read as broken rather than as paused.
 */
export function EntryReactionGrid({ mine, frequents, onPick, disabled }: EntryReactionGridProps) {
  const [query, setQuery] = useState('');
  // Stable and collision-free across however many pickers are mounted — two
  // rows can each have one open on a wide screen, and duplicate ids would point
  // both groups' names at the first one's heading.
  const headingId = useId();
  const found = useMemo(() => searchEmoji(query), [query]);
  const searching = query.trim().length > 0;

  /** One emoji button, wherever in the picker it is drawn. */
  const cell = (emoji: string) => (
    <button
      key={emoji}
      type="button"
      disabled={disabled}
      onClick={() => onPick(emoji)}
      aria-pressed={mine.includes(emoji)}
      aria-label={emojiLabel(emoji)}
      title={emojiLabel(emoji)}
      className={cn(
        'focus-ring hover:bg-accent flex size-8 items-center justify-center rounded-md text-base',
        PRESS_MARK,
        'disabled:pointer-events-none disabled:opacity-50',
        mine.includes(emoji) && 'bg-brand/15 ring-brand/40 ring-1'
      )}
    >
      <span aria-hidden>{emoji}</span>
    </button>
  );

  return (
    <div className="flex flex-col gap-2" data-testid="reaction-picker">
      <Input
        // The picker opens on a deliberate press and exists to be typed into, so
        // the field is where focus belongs; landing it anywhere else makes every
        // keyboard reader Tab in before they can search.
        // eslint-disable-next-line jsx-a11y/no-autofocus -- see above
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search emoji…"
        aria-label="Search emoji"
        className="h-8"
      />
      {disabled === true && (
        <p role="status" className="text-muted-foreground px-1 text-xs">
          Reactions won&apos;t send until the room reconnects.
        </p>
      )}
      <div className="max-h-64 overflow-y-auto pr-1">
        {searching ? (
          found.length === 0 ? (
            <p className="text-muted-foreground px-1 py-6 text-center text-xs">
              Nothing here matches that.
            </p>
          ) : (
            <div className="grid grid-cols-8 gap-0.5">
              {found.map((entry) => cell(entry.emoji))}
            </div>
          )
        ) : (
          <div className="flex flex-col gap-2">
            <section role="group" aria-labelledby={`${headingId}-frequents`}>
              <h3
                id={`${headingId}-frequents`}
                className="text-muted-foreground px-1 pb-1 text-2xs font-medium"
              >
                Your most used
              </h3>
              <div className="grid grid-cols-8 gap-0.5">{frequents.map(cell)}</div>
            </section>
            {EMOJI_GROUPS.map((group, index) => (
              <section
                key={group.name}
                role="group"
                aria-labelledby={`${headingId}-group-${index}`}
              >
                <h3
                  id={`${headingId}-group-${index}`}
                  className="text-muted-foreground px-1 pb-1 text-2xs font-medium"
                >
                  {group.name}
                </h3>
                <div className="grid grid-cols-8 gap-0.5">
                  {group.entries.map((entry) => cell(entry.emoji))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface EntryReactionPickerProps extends EntryReactionGridProps {
  /**
   * How the trigger is drawn.
   *
   * `capsule` is the icon button inside the message toolbar; `ghost-pill` is the
   * faint 🙂+ that ends a row that already has reactions on it. Two looks, one
   * picker — a second component would be a second set of emoji to keep in step.
   */
  appearance?: 'capsule' | 'ghost-pill';
  /** True when reacting cannot land right now — a room whose stream has died. */
  disabled?: boolean;
  /** Registers the trigger with the toolbar's roving sequence. */
  triggerRef?: Ref<HTMLButtonElement>;
  /** The toolbar's own arrow-key handling, so the trigger stays in the sequence. */
  onTriggerKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * The capsule's 🙂+ button, and the picker it opens.
 *
 * The trigger is an ordinary member of the toolbar's roving sequence — the
 * toolbar hands it a ref and its arrow-key handler, so reaching it with a
 * keyboard costs the same as reaching Copy, and Enter opens the picker with the
 * search field already focused. Its own popover swallows arrow keys once open,
 * which is what a reader browsing a grid wants.
 */
export function EntryReactionPicker({
  appearance = 'capsule',
  mine,
  frequents,
  onPick,
  disabled,
  triggerRef,
  onTriggerKeyDown,
}: EntryReactionPickerProps) {
  const [open, setOpen] = useState(false);
  const capsule = appearance === 'capsule';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size={capsule ? 'icon-xs' : 'sm'}
          // Never a tab stop, in either frame: both groups it can sit in — the
          // capsule and the pill row — are single roving stops reached from the
          // message itself.
          tabIndex={-1}
          disabled={disabled}
          data-entry-action="react-more"
          data-testid={capsule ? undefined : 'entry-reactions-add'}
          aria-label="Pick a reaction"
          title="Pick a reaction"
          onKeyDown={onTriggerKeyDown}
          className={cn(
            'leading-none',
            capsule
              ? 'text-[0.8125rem]'
              : // The ghost + ends the pill row and measures 45×24 on a phone,
                // which clears WCAG 2.5.8 on its own. It carries no invisible
                // reach for the reason `EntryReactionRow` measures out: down
                // here, reach overlaps the thread reply row and costs more than
                // it buys.
                'text-muted-foreground/60 hover:text-foreground h-auto rounded-full px-2 py-0.5 text-xs'
          )}
        >
          <span aria-hidden>🙂+</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[19rem] p-2">
        <EntryReactionGrid
          mine={mine}
          frequents={frequents}
          disabled={disabled}
          onPick={(emoji) => {
            onPick(emoji);
            // Closed on the pick. The pill that appears IS the confirmation, and
            // a picker left open over it hides the thing it just did.
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
