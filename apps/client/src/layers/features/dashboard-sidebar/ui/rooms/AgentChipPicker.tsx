import { useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';

/** One agent the operator can put in a conversation. */
export interface AgentPickerCandidate {
  /** The agent's directory — its stable identity (ADR 260726-170126). */
  agentPath: string;
  /** What to call it on screen, already disambiguated across the roster. */
  displayName: string;
}

interface AgentChipPickerProps {
  /** Every agent that may be picked, sorted by name. Nothing is filtered here. */
  candidates: AgentPickerCandidate[];
  /**
   * Commit the selection, in the order the agents were picked.
   *
   * The picker does not clear itself afterwards — whatever mounted it decides
   * whether the flow is over (the DM popover closes) or continues (the members
   * panel stays open on a room that now has more agents in it).
   */
  onSubmit: (chosen: AgentPickerCandidate[]) => void;
  /** The commit button's label, given how many agents are selected. */
  submitLabel: (count: number) => string;
  /** Shown instead of the field when there are no candidates at all. */
  emptyRosterMessage: string;
  /** Shown under the field when every candidate is already a chip. */
  allChosenMessage: string;
  /** Disable the commit button while a write is in flight. */
  isSubmitting?: boolean;
  /**
   * The search field, handed back so whatever holds this picker can put the
   * cursor in it.
   *
   * Focus is the container's to give, not this component's to take. A popover
   * or dialog decides where focus lands when it opens (`onOpenAutoFocus`), and
   * it has to win that decision — a menu closing behind it restores focus to
   * its own trigger a commit later, so a focus this component set on mount is
   * simply overwritten. Radix's focus scope defends what the container focused;
   * it does not defend what a child did on its own.
   */
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * Pick one agent, or several, with a chip row and a typeahead.
 *
 * **Chips, not a checkbox list.** Discord uses checkboxes and would not be
 * absurd at our scale, but a chip row keeps _who is already selected_ visible
 * and ordered, which matters more here than it does in a friends list: each
 * agent brings its own `responseMode` into the room, so the set being assembled
 * decides how loud the room will be
 * (`research/20260727_chat-navigation-quick-switcher-patterns.md`).
 *
 * **Nothing is filtered out of the list by this component.** Callers decide
 * what is offerable — the direct-message flow offers every agent however many
 * conversations it is already in, and the members panel leaves out whoever is
 * already in the room.
 *
 * The keyboard is the whole interaction, and Enter does one of exactly three
 * things. All three are worth stating in full, because every bug this component
 * has had was two of them collapsing into each other:
 *
 * 1. **An agent is highlighted** → add it. So `an` `⏎` `ka` `⏎` `⏎` assembles a
 *    group and commits it without touching the mouse.
 * 2. **Nothing is highlighted, the field is empty, and nobody was pointed at**
 *    → commit. All three, not just the first: committing is the only branch
 *    that acts on its own, so it answers only to a reader who has asked for
 *    nothing else.
 * 3. **Anything else** → nothing at all. That covers a query nobody matches
 *    (typing `Kia` for Kai and pressing Enter to try again must not commit the
 *    half-assembled selection and throw the rest away) and a highlight whose
 *    agent has since left the list — a mesh rebuild can do that under an open
 *    picker, and "aimed at somebody who is gone" must not read as "aimed at
 *    nobody" at the one gate where the difference costs an action.
 *
 * - **Backspace** on an empty field takes back the last agent picked.
 * - **↓ / ↑** move the highlight; Escape belongs to whatever is holding this —
 *   a popover or a dialog — and closes that.
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
 * which Enter can mean "commit this selection".
 *
 * Takes no focus of its own — see {@link AgentChipPickerProps.inputRef}.
 */
export function AgentChipPicker({
  candidates,
  onSubmit,
  submitLabel,
  emptyRosterMessage,
  allChosenMessage,
  isSubmitting = false,
  inputRef,
}: AgentChipPickerProps) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<AgentPickerCandidate[]>([]);
  /**
   * The agent the reader pointed at, by directory. `null` means "nobody has
   * said", which is not the same as "nothing is highlighted" — see `active`.
   */
  const [aimedAt, setAimedAt] = useState<string | null>(null);
  const ownRef = useRef<HTMLInputElement>(null);
  const fieldRef = inputRef ?? ownRef;
  const listId = useId();

  const picked = new Set(chosen.map((c) => c.agentPath));
  const needle = query.trim().toLowerCase();
  const matches = candidates.filter(
    (c) => !picked.has(c.agentPath) && c.displayName.toLowerCase().includes(needle)
  );
  // Derived every render rather than stored, which is what makes a stale aim
  // harmless: an agent that has left the list simply falls through to the
  // default instead of pointing at whoever took its place. Typing implies a
  // target and an empty field does not, which is what leaves Enter free to
  // commit the selection.
  const active =
    (aimedAt ? matches.find((c) => c.agentPath === aimedAt) : undefined) ??
    (needle ? matches[0] : undefined) ??
    null;
  const activeIndex = active ? matches.indexOf(active) : -1;

  function add(candidate: AgentPickerCandidate) {
    setChosen((prev) => [...prev, candidate]);
    setQuery('');
    setAimedAt(null);
    fieldRef.current?.focus();
  }

  function commit() {
    if (chosen.length === 0 || isSubmitting) return;
    onSubmit(chosen);
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
      // nobody matches from committing under a reader who is mid-correction.
      // `!aimedAt` keeps a highlight whose agent has since left the list — a
      // mesh rebuild can do that under an open picker — from reading as "nobody
      // was ever pointed at". Everywhere else a vanished aim is harmless,
      // because it falls through to the first match or goes inert; this is the
      // only rung that turns it into an action.
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

  if (candidates.length === 0) {
    return <p className="text-muted-foreground px-1 py-1.5 text-xs">{emptyRosterMessage}</p>;
  }

  return (
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
                fieldRef.current?.focus();
              }}
              className="hover:bg-background focus-visible:ring-ring rounded-sm p-0.5 outline-hidden focus-visible:ring-2"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={fieldRef}
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
            // The aim is whoever the reader last pointed at, and typing is not
            // pointing — dropping it lets the derived default (the first match,
            // or nothing at all) take over again.
            setAimedAt(null);
          }}
          onKeyDown={handleKeyDown}
          className="placeholder:text-muted-foreground min-w-24 flex-1 bg-transparent py-0.5 text-sm outline-hidden"
        />
      </div>

      {/* The listbox exists only while it has options in it. An empty one would
          be a popup a reader is told to expect and finds nothing in, and its
          "nothing matched" line would be inside a listbox, where the
          accessibility tree drops any child that is not an option. */}
      {matches.length > 0 ? (
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
              // The input keeps focus, so the highlight is what a keyboard
              // reader follows and the pointer only ever borrows it.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setAimedAt(candidate.agentPath)}
              onClick={() => add(candidate)}
              className={cn(
                'cursor-pointer truncate rounded-sm px-2 py-1.5 text-sm',
                index === activeIndex && 'bg-accent text-accent-foreground'
              )}
            >
              {candidate.displayName}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground mt-1 px-2 py-1.5 text-xs">
          {needle ? 'No agent by that name.' : allChosenMessage}
        </p>
      )}

      <Button
        type="button"
        size="sm"
        disabled={chosen.length === 0 || isSubmitting}
        onClick={commit}
        className="mt-2 w-full"
      >
        {submitLabel(chosen.length)}
      </Button>
    </>
  );
}
