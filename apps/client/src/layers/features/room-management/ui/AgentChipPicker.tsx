import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { cn, initialOf } from '@/layers/shared/lib';
import { Button, IdentityAvatar } from '@/layers/shared/ui';
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
  /**
   * The commit button's label, given what is selected.
   *
   * Takes the agents rather than a count, because one of the three labels names
   * the agent it is about ("Open session with Ana") — and a label that can name
   * somebody must be handed who.
   */
  submitLabel: (chosen: readonly AgentPickerCandidate[]) => string;
  /** Shown instead of the field when there are no candidates at all. */
  emptyRosterMessage: string;
  /**
   * A way out of {@link AgentChipPickerProps.emptyRosterMessage}, when the
   * caller has one to offer.
   *
   * The message covers two situations and only one of them is a dead end: a
   * fleet with nobody in it can be fixed, while "everyone is already in here"
   * is a finished job. So the control is the caller's to supply or withhold —
   * this component cannot tell which sentence it was handed.
   */
  emptyRosterAction?: ReactNode;
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
 * **The pointer does not move the highlight at all.** Hovering a row tints it
 * in CSS and changes nothing else: not the highlight, not what
 * `aria-activedescendant` announces, not what Enter does. Clicking still adds,
 * because a click names its own target.
 *
 * That is the fix for a real trap — assembling a selection by clicking leaves
 * the cursor resting on whichever agent slid up into the vacated row, so the
 * Enter a reader presses to FINISH used to add that agent instead of
 * committing. The first attempt at it let the pointer set the highlight and
 * then excluded the pointer from Enter's target, which was worse: with a query
 * still in the field the two disagreed, and a screen reader announced one
 * agent while Enter added another. Keeping the pointer out of the state is
 * what makes the highlight, the announcement and the action one thing rather
 * than three that have to be kept in step.
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
 * **The field stays, however small the fleet is.** The reasonable-sounding rule
 * — no search box until there are eight or so candidates, because Slack shows
 * one for four members and that is chrome before content — is about a search
 * box, and this is not one. It is the combobox that HOLDS the selection: the
 * chips live in it, Backspace takes the last one back, the arrows aim from it,
 * `aria-activedescendant` announces from it, and all three surfaces that mount
 * this picker place the cursor in it when they open. Hiding it under a
 * threshold would give one component two interaction models, delete two
 * guaranteed behaviours below the line, and leave a reader with four agents no
 * keyboard path at all. Slack's box filters a checkbox list and can be removed
 * without taking anything with it; this one cannot.
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
  emptyRosterAction,
  allChosenMessage,
  isSubmitting = false,
  submitDisabled = false,
  inputRef,
}: AgentChipPickerProps) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<AgentPickerCandidate[]>([]);
  /**
   * The agent the reader steered onto with the arrow keys, by directory. `null`
   * means "nobody has said", which is not the same as "nothing is highlighted"
   * — see `active`.
   *
   * **The pointer never writes here.** Hovering a row tints it in CSS and
   * changes nothing else, so it cannot move the highlight, the announcement or
   * what Enter does. See `active`.
   */
  const [aim, setAim] = useState<string | null>(null);
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
  /**
   * The one highlighted row: what the list draws, what `aria-activedescendant`
   * announces, and what Enter adds.
   *
   * **Deliberately one expression rather than several that agree.** An earlier
   * fix to the hover trap made the pointer set the highlight but excluded it
   * from Enter's target, which desynchronised the two: with a query still in
   * the field, hovering a different match highlighted one agent and announced
   * it while Enter added another. That is worse than the bug it replaced — the
   * old behaviour was wrong but at least self-consistent, and a screen reader
   * that states one thing while the action does another is an accessibility
   * defect rather than a rough edge. So the pointer is kept out of the state
   * entirely (see `aim`) instead of being filtered back out downstream, and
   * there is no second expression left to disagree with this one.
   *
   * Derived every render rather than stored, which is what makes a stale aim
   * harmless: an agent that has left the list simply falls through to the
   * default instead of pointing at whoever took its place. Typing implies a
   * target and an empty field does not, which is what leaves Enter free to
   * commit the selection.
   */
  const active =
    (aim ? (matches.find((c) => c.agentPath === aim) ?? null) : null) ??
    (needle ? (matches[0] ?? null) : null);
  const activeIndex = active ? matches.indexOf(active) : -1;

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
    setAim(matches[next].agentPath);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active) add(active);
      // Two conditions, neither redundant. `!needle` keeps a query nobody
      // matches from committing under a reader who is mid-correction. `!aim`
      // keeps a highlight whose agent has since left the list — a mesh rebuild
      // can do that under an open picker — from reading as "nobody was ever
      // aimed". Everywhere else a vanished aim is harmless, because it falls
      // through to the first match or goes inert; this is the only rung that
      // turns it into an action.
      else if (!needle && !aim) commit();
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
    return (
      <div className="space-y-2 px-1 py-1.5">
        <p className="text-muted-foreground text-xs">{emptyRosterMessage}</p>
        {emptyRosterAction}
      </div>
    );
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
                'hover:bg-background focus-visible:ring-ring relative rounded-sm p-2.5 outline-hidden focus-visible:ring-2 md:p-0.5',
                // 34px of real button plus 6px of invisible reach each way is
                // 46px — over the 44px bar with a pixel to spare.
                //
                // **The size is where the growth had to go, not the reach.**
                // The dead space between this button and the next wrapped row's
                // is 12px (`py-1` + the row's `gap-2`), so 6px is exactly half:
                // two adjacent targets meet and never overlap. Reaching the 7px
                // that would have got a 30px button to 44 makes them overlap by
                // 2px, and a tap in that overlap deletes the wrong agent — so
                // the button itself is bigger instead.
                //
                // The reach stays deliberately smaller than the space around
                // it. An earlier version reached 12px in every direction and
                // ate into the FIELD: sampling its box at 390x844 found 1.9% of
                // it stolen at two chips and 10.6% at six, and a tap there
                // focused the field and silently deleted an agent.
                // `SidebarGroupAction` gets away with a bare outset because
                // nothing interactive sits next to it.
                //
                // A pseudo-element is inset from the PADDING box, so a bordered
                // control loses a pixel at each end to its border. This button
                // has no border, so 6px here really is 6px — the loudness pill
                // in `RoomMemberRow` does, and needs 7 to reach the same 44.
                'after:absolute after:-inset-x-1.5 after:-inset-y-1.5 md:after:hidden'
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
            // The aim is whoever the reader last steered onto, and typing is
            // not steering — dropping it lets the derived default (the first
            // match, or nothing at all) take over again.
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
              // Named explicitly, and described separately, for the reason the
              // rung list is: left to its contents an option would announce as
              // "Ana Reviews every pull request and…", a name and its own
              // description read as one string, which is what a reader arrows
              // through and what a voice-control user has to say out loud. The
              // name stays the visible display name; the second line becomes a
              // description, and is only wired when there is one.
              aria-label={candidate.displayName}
              aria-describedby={candidate.description === null ? undefined : `${listId}-${index}-d`}
              // The input keeps focus, so the highlight belongs to the
              // keyboard. Hover is a CSS tint and nothing else: it says "this
              // is what you would click", not "this is what Enter will do".
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => add(candidate)}
              className={cn(
                'flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-sm md:min-h-0 md:py-1.5',
                // Weaker than the real highlight on purpose, so a hovered row
                // and the announced one are still told apart when they differ.
                'hover:bg-accent/50',
                index === activeIndex && 'bg-accent text-accent-foreground'
              )}
            >
              {/* The face, so this list stops reading as a directory listing of
                  every folder you own. It is the SAME face the sidebar and the
                  message gutter draw, resolved once in `entities/agent` — a
                  picker that hashed its own would introduce a second appearance
                  for one agent.

                  `kind="agent"` keeps the square silhouette every other agent
                  surface draws; `badge={null}` is the explicit opt-out from
                  the Bot glyph `kind` would otherwise add — everything offered
                  here is an agent, so a mark on every one would be a column of
                  identical glyphs. The badge earns its place the day this list
                  offers people too.

                  An agent whose manifest could not be read gets a letter on a
                  neutral disc instead. `currentColor` is the row's own text
                  colour rather than a hash, so an unresolved agent reads as
                  "no colour recorded" instead of an invented one that would
                  read as meaningful — see `AgentPickerCandidate.visual` for
                  why the directory is not hashed into a face here.

                  That neutral disc has to stay `tint`, not `kind="agent"`'s
                  default `fill`: `fill` sets BOTH `backgroundColor` and the
                  fallback letter's `color` to values derived from `color`, so
                  filling with `currentColor` makes the letter's own resolved
                  foreground the background `currentColor` then resolves
                  against — the letter paints itself invisible on its own
                  disc. An explicit visual's colour is a real, opaque value
                  `fill` handles fine; only the `currentColor` fallback needs
                  the override back to `tint`. */}
              <IdentityAvatar
                size="xs"
                color={candidate.visual?.color ?? 'currentColor'}
                emoji={candidate.visual?.emoji}
                fallback={initialOf(candidate.displayName)}
                kind="agent"
                variant={candidate.visual ? undefined : 'tint'}
                badge={null}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{candidate.displayName}</span>
                {/* Only where there is something to read. This is the line that
                    answers "which of these do I want?" — two agents can share a
                    name, and the disambiguated `server (acme)` says which
                    directory without saying what it is FOR. It is the agent's
                    own words, from the same manifest the face comes out of.
                    Nothing is invented to fill it: an agent that has said
                    nothing gets no line, because a column of empty rows pushed
                    apart for a value nobody wrote is the filler this list
                    already replaced once. */}
                {candidate.description !== null && (
                  <span
                    id={`${listId}-${index}-d`}
                    data-slot="candidate-description"
                    className="text-muted-foreground block truncate text-xs"
                  >
                    {candidate.description}
                  </span>
                )}
              </span>
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
        {submitLabel(chosen)}
      </Button>
    </div>
  );
}
