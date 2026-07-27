import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  SidebarGroupAction,
} from '@/layers/shared/ui';

/** One agent the operator can put in a conversation. */
export interface DirectMessageCandidate {
  /** The agent's directory — its stable identity (ADR 260726-170126). */
  agentPath: string;
  /** What to call it on screen, already disambiguated across the roster. */
  displayName: string;
}

interface NewDirectMessageMenuProps {
  /** Every agent on the roster, sorted by name. Nothing is filtered out. */
  candidates: DirectMessageCandidate[];
  /**
   * Open a conversation with these agents, in the order they were picked. One
   * gives a one-to-one; two or more give a group.
   */
  onStart: (chosen: DirectMessageCandidate[]) => void;
}

/**
 * The "+" beside Direct messages: pick one agent for a one-to-one, or several
 * for a group conversation.
 *
 * **Chips, not a checkbox list.** Discord uses checkboxes and would not be
 * absurd at our scale, but a chip row keeps _who is already in this
 * conversation_ visible and ordered, which matters more here than it does in a
 * friends list: each agent brings its own `responseMode` into the room, so the
 * set being assembled decides how loud the room will be
 * (`research/20260727_chat-navigation-quick-switcher-patterns.md`).
 *
 * **Nothing is filtered out of the list.** Every agent stays offerable however
 * many conversations it is already in, because Ana alone and Ana + Kai are
 * different conversations. What used to stop a duplicate — hiding agents that
 * already had a DM — now lives on the server, which matches a direct message on
 * its exact member set and answers with the one you already have.
 *
 * The keyboard is the whole interaction, and Enter does one of exactly three
 * things. All three are worth stating in full, because every bug this component
 * has had was two of them collapsing into each other:
 *
 * 1. **An agent is highlighted** → add it. So `an` `⏎` `ka` `⏎` `⏎` assembles a
 *    group and opens it without touching the mouse.
 * 2. **Nothing is highlighted, the field is empty, and nobody was pointed at**
 *    → open the conversation. All three, not just the first: "open this" is the
 *    only branch that acts on its own, so it answers only to a reader who has
 *    asked for nothing else.
 * 3. **Anything else** → nothing at all. That covers a query nobody matches
 *    (typing `Kia` for Kai and pressing Enter to try again must not open the
 *    half-assembled conversation and throw the rest away) and a highlight whose
 *    agent has since left the list — a mesh rebuild can do that under an open
 *    picker, and "aimed at somebody who is gone" must not read as "aimed at
 *    nobody" at the one gate where the difference costs an action.
 *
 * - **Backspace** on an empty field takes back the last agent picked.
 * - **↓ / ↑** move the highlight; **Escape** closes without opening anything.
 *
 * The highlight is keyed on an `agentPath`, never on a position in the list.
 * That list recomputes from `chosen` and `query`, so an index silently comes to
 * mean a different agent the moment either changes — highlight Bo, take a chip
 * back, and a positional highlight is sitting on whoever moved into that slot.
 * A path either still matches something on screen or falls through to the
 * default, which makes that whole class of bug unrepresentable rather than
 * something every mutation site has to remember to reset.
 *
 * Hand-rolled rather than built on `Command` (`cmdk`), which the single-select
 * pickers in this codebase use: it binds Enter to the highlighted item
 * unconditionally and always highlights the first one, so there is no state in
 * which Enter can mean "open this conversation".
 *
 * **A panel on a wide screen, the whole screen on a narrow one**
 * (`ResponsivePopover`, one 768px breakpoint shared by the shell and the `md:`
 * classes below). Picking who to talk to is a task, not a glance, and the
 * anchored panel was the wrong shape for it on a phone twice over: the sidebar
 * it hangs off _is_ a sheet down there, so it had to close for the panel to be
 * seen, and what was left was a floating box drawn at `x = -17` — off the left
 * edge of the screen. The sheet puts the field at the top where the keyboard
 * cannot reach it, gives the list the height to be a list, and carries a close
 * button, because a phone has no Escape key.
 *
 * Three flex rules carry that, and each one is load-bearing at a size the
 * others are not. The field and the button do not shrink, so they are legible
 * and tappable at every size. The list takes what is left, which is most of a
 * portrait phone. And the list has a **floor** — because when a landscape
 * phone puts its keyboard up there is under 200px of sheet to divide, and a
 * list that only ever takes "what is left" takes nothing, leaving a search
 * field above a blank space while you type. The floor costs a short scroll to
 * reach the button in that one case, which is the right way round: the
 * keyboard is up because you are still choosing, and Enter commits anyway.
 */
export function NewDirectMessageMenu({ candidates, onStart }: NewDirectMessageMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<DirectMessageCandidate[]>([]);
  /**
   * The agent the reader pointed at, by directory. `null` means "nobody has
   * said", which is not the same as "nothing is highlighted" — see `active`.
   */
  const [aimedAt, setAimedAt] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const picked = new Set(chosen.map((c) => c.agentPath));
  const needle = query.trim().toLowerCase();
  const matches = candidates.filter(
    (c) => !picked.has(c.agentPath) && c.displayName.toLowerCase().includes(needle)
  );
  // Derived every render rather than stored, which is what makes a stale aim
  // harmless: an agent that has left the list simply falls through to the
  // default instead of pointing at whoever took its place. Typing implies a
  // target and an empty field does not, which is what leaves Enter free to open
  // the conversation.
  const active =
    (aimedAt ? matches.find((c) => c.agentPath === aimedAt) : undefined) ??
    (needle ? matches[0] : undefined) ??
    null;
  const activeIndex = active ? matches.indexOf(active) : -1;

  /** Reset to a blank picker whenever it opens or closes. */
  function handleOpenChange(next: boolean) {
    setOpen(next);
    setQuery('');
    setChosen([]);
    setAimedAt(null);
  }

  function add(candidate: DirectMessageCandidate) {
    setChosen((prev) => [...prev, candidate]);
    setQuery('');
    setAimedAt(null);
    inputRef.current?.focus();
  }

  function commit() {
    if (chosen.length === 0) return;
    const started = chosen;
    handleOpenChange(false);
    onStart(started);
  }

  /** Move the highlight by `step`, entering the list from whichever end. */
  function moveAim(step: 1 | -1) {
    if (matches.length === 0) return;
    const next =
      activeIndex < 0
        ? step === 1
          ? 0
          : matches.length - 1
        : Math.min(Math.max(activeIndex + step, 0), matches.length - 1);
    setAimedAt(matches[next].agentPath);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active) add(active);
      // Three conditions, none of them redundant. `!needle` keeps a query
      // nobody matches from opening the conversation under a reader who is
      // mid-correction. `!aimedAt` keeps a highlight whose agent has since left
      // the list — a mesh rebuild can do that under an open picker — from
      // reading as "nobody was ever pointed at". Everywhere else a vanished aim
      // is harmless, because it falls through to the first match or goes inert;
      // this is the only rung that turns it into an action.
      else if (!needle && !aimedAt) commit();
      return;
    }
    if (event.key === 'Backspace' && query === '' && chosen.length > 0) {
      event.preventDefault();
      setChosen((prev) => prev.slice(0, -1));
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveAim(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveAim(-1);
    }
  }

  return (
    <ResponsivePopover open={open} onOpenChange={handleOpenChange} modal fullHeight>
      <ResponsivePopoverTrigger asChild>
        <SidebarGroupAction aria-label="New direct message">
          <Plus />
        </SidebarGroupAction>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent
        side="right"
        align="start"
        // A column, so the list below can give height back when the panel is
        // clamped: on a 844x390 window the desktop panel is capped at 70vh and
        // a fixed-height list pushed the commit button below the fold.
        className="flex w-64 flex-col p-2"
        // Names the desktop panel, which is a focus-trapping `role="dialog"`
        // and would otherwise be an unnamed one. On mobile the sheet's own
        // heading wins, per the accname precedence rules, and says the same.
        aria-label="New message"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        {/* The sheet's heading, and its accessible name. Null on desktop, where
            the panel is anchored to a "+" that already says what it does. */}
        <ResponsivePopoverTitle>New message</ResponsivePopoverTitle>

        {candidates.length === 0 ? (
          <p className="text-muted-foreground px-1 py-1.5 text-xs">
            You have not added any agents yet. Add one to start a direct message with it.
          </p>
        ) : (
          // A column on both: the field and the button hold their size and the
          // list takes whatever is left, which on a phone is most of the screen
          // and in the desktop panel is capped so the panel stays a panel.
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-input focus-within:ring-ring flex shrink-0 flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 focus-within:ring-2 md:gap-1 md:px-1.5 md:py-1">
              {chosen.map((candidate) => (
                <span
                  key={candidate.agentPath}
                  className="bg-accent text-accent-foreground flex items-center gap-1 rounded-sm py-1 pr-1 pl-2 text-xs md:py-0.5 md:pr-0.5 md:pl-1.5"
                >
                  {candidate.displayName}
                  <button
                    type="button"
                    aria-label={`Remove ${candidate.displayName}`}
                    onClick={() => {
                      setChosen((prev) => prev.filter((c) => c.agentPath !== candidate.agentPath));
                      inputRef.current?.focus();
                    }}
                    className={cn(
                      'hover:bg-background focus-visible:ring-ring relative rounded-sm p-2 outline-hidden focus-visible:ring-2 md:p-0.5',
                      // Most of the touch target is real size (30px), and the
                      // invisible part is deliberately smaller than the dead
                      // space around it: 6px sideways into the 12px between
                      // this button and whatever is next (`pr-1` + the row's
                      // `gap-2`), 4px down into the 12px above the next wrapped
                      // row. An earlier version reached 12px in every direction
                      // and ate into the FIELD — sampling its box at 390x844
                      // found 1.9% of it stolen at two chips and 10.6% at six,
                      // and a tap there focused the field and silently deleted
                      // an agent. `SidebarGroupAction` gets away with a bare
                      // outset because nothing interactive sits next to it.
                      'after:absolute after:-inset-x-1.5 after:-inset-y-1 md:after:hidden'
                    )}
                  >
                    <X className="size-3.5 md:size-3" />
                  </button>
                </span>
              ))}
              <input
                ref={inputRef}
                role="combobox"
                // There is no popup to expand when nothing matches, and saying
                // otherwise advertises a list of zero options to a screen reader.
                aria-expanded={matches.length > 0}
                aria-controls={matches.length > 0 ? listId : undefined}
                aria-autocomplete="list"
                aria-activedescendant={active ? `${listId}-${activeIndex}` : undefined}
                aria-label="Search agents"
                value={query}
                placeholder={chosen.length > 0 ? 'Add another' : 'Search agents'}
                onChange={(event) => {
                  setQuery(event.target.value);
                  // The aim is whoever the reader last pointed at, and typing
                  // is not pointing — dropping it lets the derived default (the
                  // first match, or nothing at all) take over again.
                  setAimedAt(null);
                }}
                onKeyDown={handleKeyDown}
                className="placeholder:text-muted-foreground min-w-24 flex-1 bg-transparent py-1 text-sm outline-hidden md:py-0.5"
              />
            </div>

            {/* The listbox exists only while it has options in it. An empty one
                would be a popup a reader is told to expect and finds nothing in,
                and its "nothing matched" line would be inside a listbox, where
                the accessibility tree drops any child that is not an option. */}
            {matches.length > 0 ? (
              <ul
                id={listId}
                role="listbox"
                aria-label="Agents"
                // `min-h-24` is a floor, not a size: it only bites when the
                // sheet has been squeezed — a landscape phone with the keyboard
                // up leaves barely 180px, and a pure `flex-1` list gives all of
                // it back to the field and the button and renders zero of the
                // matches you are typing to find. Two rows always survive, and
                // the sheet's scroll of last resort covers the rest.
                className="mt-2 min-h-24 flex-1 overflow-y-auto md:mt-1 md:max-h-56 md:min-h-0"
              >
                {matches.map((candidate, index) => (
                  // An aria-activedescendant combobox keeps DOM focus on the input, so an
                  // option is deliberately not focusable and carries no key handler of its
                  // own. The rule reads the `li` element rather than its role and cannot
                  // see that, so it is off for this element only.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                  <li
                    key={candidate.agentPath}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    // The input keeps focus, so the highlight is what a keyboard
                    // reader follows and the pointer only ever borrows it.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setAimedAt(candidate.agentPath)}
                    onClick={() => add(candidate)}
                    className={cn(
                      'flex min-h-11 cursor-pointer items-center truncate rounded-sm px-2 py-2 text-sm md:min-h-0 md:py-1.5',
                      index === activeIndex && 'bg-accent text-accent-foreground'
                    )}
                  >
                    {candidate.displayName}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground mt-2 flex-1 px-2 py-1.5 text-xs md:mt-1 md:flex-none">
                {needle
                  ? 'No agent by that name.'
                  : 'Everyone you have added is already in this conversation.'}
              </p>
            )}

            <Button
              type="button"
              size="sm"
              disabled={chosen.length === 0}
              onClick={commit}
              className="mt-3 w-full shrink-0 md:mt-2"
            >
              {chosen.length > 1 ? 'Start group conversation' : 'Start conversation'}
            </Button>
          </div>
        )}
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
