import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverContent,
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
 * The keyboard is the whole interaction:
 *
 * - **Enter** adds the highlighted agent when there is one, and otherwise opens
 *   the conversation. Typing highlights the first match, so `an` `⏎` `ka` `⏎`
 *   `⏎` assembles a group and opens it without touching the mouse. Nothing is
 *   highlighted while the field is empty, which is what leaves the second `⏎`
 *   free to mean "go".
 * - **Backspace** on an empty field takes back the last agent picked.
 * - **↓ / ↑** move the highlight; **Escape** closes without opening anything.
 *
 * Hand-rolled rather than built on `Command` (`cmdk`), which the single-select
 * pickers in this codebase use: it binds Enter to the highlighted item
 * unconditionally and always highlights the first one, so there is no state in
 * which Enter can mean "open this conversation".
 */
export function NewDirectMessageMenu({ candidates, onStart }: NewDirectMessageMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<DirectMessageCandidate[]>([]);
  /** Which match Enter would add. `-1` is "none", which frees Enter to commit. */
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const picked = new Set(chosen.map((c) => c.agentPath));
  const needle = query.trim().toLowerCase();
  const matches = candidates.filter(
    (c) => !picked.has(c.agentPath) && c.displayName.toLowerCase().includes(needle)
  );
  const active = activeIndex >= 0 && activeIndex < matches.length ? matches[activeIndex] : null;

  /** Reset to a blank picker whenever the popover opens or closes. */
  function handleOpenChange(next: boolean) {
    setOpen(next);
    setQuery('');
    setChosen([]);
    setActiveIndex(-1);
  }

  function add(candidate: DirectMessageCandidate) {
    setChosen((prev) => [...prev, candidate]);
    setQuery('');
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  function commit() {
    if (chosen.length === 0) return;
    const started = chosen;
    handleOpenChange(false);
    onStart(started);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active) add(active);
      else commit();
      return;
    }
    if (event.key === 'Backspace' && query === '' && chosen.length > 0) {
      event.preventDefault();
      setChosen((prev) => prev.slice(0, -1));
      return;
    }
    if (event.key === 'ArrowDown' && matches.length > 0) {
      event.preventDefault();
      setActiveIndex((i) => (i < 0 ? 0 : Math.min(i + 1, matches.length - 1)));
      return;
    }
    if (event.key === 'ArrowUp' && matches.length > 0) {
      event.preventDefault();
      setActiveIndex((i) => (i < 0 ? matches.length - 1 : Math.max(i - 1, 0)));
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <SidebarGroupAction aria-label="New direct message">
          <Plus />
        </SidebarGroupAction>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        className="w-64 p-2"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        {candidates.length === 0 ? (
          <p className="text-muted-foreground px-1 py-1.5 text-xs">
            You have not added any agents yet. Add one to start a direct message with it.
          </p>
        ) : (
          <>
            <div className="border-input focus-within:ring-ring flex flex-wrap items-center gap-1 rounded-md border px-1.5 py-1 focus-within:ring-2">
              {chosen.map((candidate) => (
                <span
                  key={candidate.agentPath}
                  className="bg-accent text-accent-foreground flex items-center gap-1 rounded-sm py-0.5 pr-0.5 pl-1.5 text-xs"
                >
                  {candidate.displayName}
                  <button
                    type="button"
                    aria-label={`Remove ${candidate.displayName}`}
                    onClick={() => {
                      setChosen((prev) => prev.filter((c) => c.agentPath !== candidate.agentPath));
                      inputRef.current?.focus();
                    }}
                    className="hover:bg-background focus-visible:ring-ring rounded-sm p-0.5 outline-hidden focus-visible:ring-2"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <input
                ref={inputRef}
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={active ? `${listId}-${activeIndex}` : undefined}
                aria-label="Search agents"
                value={query}
                placeholder={chosen.length > 0 ? 'Add another' : 'Search agents'}
                onChange={(event) => {
                  setQuery(event.target.value);
                  // Typing implies a target; an empty field does not, which is
                  // what leaves Enter free to mean "open this conversation".
                  setActiveIndex(event.target.value.trim() ? 0 : -1);
                }}
                onKeyDown={handleKeyDown}
                className="placeholder:text-muted-foreground min-w-24 flex-1 bg-transparent py-0.5 text-sm outline-hidden"
              />
            </div>

            <ul
              id={listId}
              role="listbox"
              aria-label="Agents"
              className="mt-1 max-h-56 overflow-y-auto"
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
                  data-testid="dm-candidate"
                  // The input keeps focus, so the highlight is what a keyboard
                  // reader follows and the pointer only ever borrows it.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => add(candidate)}
                  className={cn(
                    'cursor-pointer truncate rounded-sm px-2 py-1.5 text-sm',
                    index === activeIndex && 'bg-accent text-accent-foreground'
                  )}
                >
                  {candidate.displayName}
                </li>
              ))}
              {matches.length === 0 && (
                <li role="presentation" className="text-muted-foreground px-2 py-1.5 text-xs">
                  {needle
                    ? 'No agent by that name.'
                    : 'Everyone you have added is already in this conversation.'}
                </li>
              )}
            </ul>

            <Button
              type="button"
              size="sm"
              disabled={chosen.length === 0}
              onClick={commit}
              className="mt-2 w-full"
            >
              {chosen.length > 1 ? 'Start group conversation' : 'Start conversation'}
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
