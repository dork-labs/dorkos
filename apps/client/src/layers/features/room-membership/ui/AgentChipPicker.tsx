import { useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import type { AgentPickerCandidate } from '@/layers/entities/agent';

interface AgentChipPickerProps {
  /**
   * Every agent that may be picked, sorted by name. Nothing is filtered here.
   *
   * This list is also what keeps the selection honest: an agent that leaves it
   * has nothing left to pick, so its chip goes with it — see
   * {@link AgentChipPicker}.
   */
  candidates: AgentPickerCandidate[];
  /**
   * Commit the selection, in the order the agents were picked.
   *
   * Committing does not clear the chips, because a commit is not yet an
   * outcome. They clear one at a time as the writes land — see
   * {@link AgentChipPicker}. Whatever mounted this still decides whether the
   * flow is over: the DM popover closes and takes the picker with it, while the
   * members panel stays open on a room that now has more agents in it.
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
   * The container has its own reason the selection cannot be committed yet.
   *
   * Distinct from {@link AgentChipPickerProps.isSubmitting}, which says a write
   * is already going. This says the rest of the form is not ready: the
   * channel-create dialog holds a name field beside this picker, and a channel
   * with agents and no name is not a thing the server will make. It gates the
   * keyboard commit as well as the button, so Enter cannot walk past a rule the
   * pointer is stopped by.
   */
  submitDisabled?: boolean;
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
 * **A chip means "still to be added", so it lives exactly as long as its agent
 * is still offerable.** An agent that drops out of `candidates` has either had
 * its write land — the members panel stops offering whoever is in the room — or
 * left the fleet, and in both cases there is nothing left to add. Which is what
 * makes the selection clear on the *outcome* rather than on the click: commit
 * four adds, three land, and the one that failed is the one chip still there,
 * still committable, so the button is offering a retry rather than a repeat.
 * The direct-message flow never shrinks its list, so nothing is ever taken back
 * from a reader mid-assembly there.
 *
 * The keyboard is the whole interaction, and Enter does one of exactly three
 * things. All three are worth stating in full, because every bug this component
 * has had was two of them collapsing into each other:
 *
 * 1. **The KEYBOARD is aimed at an agent** → add it. Either the reader arrowed
 *    onto it, or they typed a query and it is the first match. So `an` `⏎` `ka`
 *    `⏎` `⏎` assembles a group and commits it without touching the mouse.
 * 2. **The keyboard is aimed at nothing and the field is empty** → commit.
 *    Both, not just the first: committing is the only branch that acts on its
 *    own, so it answers only to a reader who has asked for nothing else.
 * 3. **Anything else** → nothing at all. That covers a query nobody matches
 *    (typing `Kia` for Kai and pressing Enter to try again must not commit the
 *    half-assembled selection and throw the rest away) and a keyboard highlight
 *    whose agent has since left the list — a mesh rebuild can do that under an
 *    open picker, and "aimed at somebody who is gone" must not read as "aimed
 *    at nobody" at the one gate where the difference costs an action.
 *
 * **A hovered option is highlighted but is not aimed at.** The pointer borrows
 * the highlight so the list still tracks the cursor, and it never borrows the
 * Enter key: hovering an option and pressing Enter commits the selection, it
 * does not add whatever the cursor happens to be resting on. This matters
 * because assembling a selection by clicking leaves the cursor sitting over
 * whichever agent slid up into the vacated row, so the pointer path and the
 * keyboard path would otherwise disagree about what Enter means at exactly the
 * moment a reader reaches for it to finish. Arrowing from a hovered row is
 * still keyboard aim — it starts where the cursor left off and Enter adds
 * again.
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
 * **Mobile-first, with `md:` for the compact panel** — one 768px breakpoint,
 * shared with the responsive shells that hold this. Three flex rules carry the
 * layout, and each is load-bearing at a size the others are not. The field and
 * the button do not shrink, so they stay legible and tappable everywhere. The
 * list takes what is left, which on a portrait phone is most of the screen. And
 * the list has a **floor** — because when a landscape phone puts its keyboard up
 * there is under 200px of sheet to divide, and a list that only ever takes "what
 * is left" takes nothing, leaving a search field above a blank space while you
 * type. The floor costs a short scroll to reach the button in that one case,
 * which is the right way round: the keyboard is up because you are still
 * choosing, and Enter commits anyway.
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
  submitDisabled = false,
  inputRef,
}: AgentChipPickerProps) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<AgentPickerCandidate[]>([]);
  /**
   * What the highlight is resting on, and how it got there. `null` means
   * "nobody has said", which is not the same as "nothing is highlighted" — see
   * `active`. `from` is what separates a reader steering with the arrow keys
   * from a cursor that merely passed over the list: only the former earns
   * Enter.
   */
  const [aim, setAim] = useState<{ path: string; from: 'keyboard' | 'pointer' } | null>(null);
  const ownRef = useRef<HTMLInputElement>(null);
  const fieldRef = inputRef ?? ownRef;
  const listId = useId();

  // Take back any chip whose agent is no longer offered — the write landed, or
  // the agent left the fleet. Done during render rather than in an effect for
  // two reasons: an effect paints one frame of the stale chip first, and it
  // would have to re-run on every `candidates` identity change to notice. The
  // guard is what makes this converge — the branch is false on the re-render it
  // causes, so there is exactly one extra pass and no loop.
  const offered = new Set(candidates.map((c) => c.agentPath));
  if (chosen.some((c) => !offered.has(c.agentPath))) {
    setChosen((prev) => prev.filter((c) => offered.has(c.agentPath)));
  }

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
  const aimed = aim ? (matches.find((c) => c.agentPath === aim.path) ?? null) : null;
  const typed = needle ? (matches[0] ?? null) : null;
  /** What the list draws as highlighted — the pointer counts here. */
  const active = aimed ?? typed;
  const activeIndex = active ? matches.indexOf(active) : -1;
  /**
   * What Enter would add. The pointer is deliberately absent: it may light a row
   * up, but it never turns the key that acts on it.
   */
  const enterTarget = (aim?.from === 'keyboard' ? aimed : null) ?? typed;

  function add(candidate: AgentPickerCandidate) {
    setChosen((prev) => [...prev, candidate]);
    setQuery('');
    setAim(null);
    fieldRef.current?.focus();
  }

  function commit() {
    if (chosen.length === 0 || isSubmitting || submitDisabled) return;
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
    setAim({ path: matches[next].agentPath, from: 'keyboard' });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (enterTarget) add(enterTarget);
      // Two conditions, neither redundant. `!needle` keeps a query nobody
      // matches from committing under a reader who is mid-correction. The
      // keyboard-aim check keeps a highlight whose agent has since left the
      // list — a mesh rebuild can do that under an open picker — from reading
      // as "nobody was ever aimed"; everywhere else a vanished aim is harmless,
      // because it falls through to the first match or goes inert, and this is
      // the only rung that turns it into an action. A POINTER aim is
      // deliberately not checked: a cursor resting on a row is not a reader
      // asking for it, which is the whole of the rule above.
      else if (!needle && aim?.from !== 'keyboard') commit();
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
    // A column on both: the field and the button hold their size and the list
    // takes whatever is left, which on a phone is most of the screen and in a
    // desktop panel is capped so the panel stays a panel.
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
                fieldRef.current?.focus();
              }}
              className={cn(
                'hover:bg-background focus-visible:ring-ring relative rounded-sm p-2 outline-hidden focus-visible:ring-2 md:p-0.5',
                // Most of the touch target is real size (30px), and the
                // invisible part is deliberately smaller than the dead space
                // around it: 6px sideways into the 12px between this button and
                // whatever is next (`pr-1` + the row's `gap-2`), 4px down into
                // the 12px above the next wrapped row. An earlier version
                // reached 12px in every direction and ate into the FIELD —
                // sampling its box at 390x844 found 1.9% of it stolen at two
                // chips and 10.6% at six, and a tap there focused the field and
                // silently deleted an agent. `SidebarGroupAction` gets away with
                // a bare outset because nothing interactive sits next to it.
                'after:absolute after:-inset-x-1.5 after:-inset-y-1 md:after:hidden'
              )}
            >
              <X className="size-3.5 md:size-3" />
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
            // The aim is whoever the reader last steered onto or hovered, and
            // typing is neither — dropping it lets the derived default (the
            // first match, or nothing at all) take over again.
            setAim(null);
          }}
          onKeyDown={handleKeyDown}
          className="placeholder:text-muted-foreground min-w-24 flex-1 bg-transparent py-1 text-sm outline-hidden md:py-0.5"
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
          // `min-h-24` is a floor, not a size: it only bites when the sheet has
          // been squeezed — a landscape phone with the keyboard up leaves barely
          // 180px, and a pure `flex-1` list gives all of it back to the field
          // and the button and renders zero of the matches you are typing to
          // find. Two rows always survive, and the sheet's scroll of last resort
          // covers the rest.
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
              // reader follows and the pointer only ever borrows it — the
              // highlight, and never the Enter key that acts on it.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setAim({ path: candidate.agentPath, from: 'pointer' })}
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
          {needle ? 'No agent by that name.' : allChosenMessage}
        </p>
      )}

      <Button
        type="button"
        size="sm"
        disabled={chosen.length === 0 || isSubmitting || submitDisabled}
        onClick={commit}
        className="mt-3 w-full shrink-0 md:mt-2"
      >
        {submitLabel(chosen.length)}
      </Button>
    </div>
  );
}
