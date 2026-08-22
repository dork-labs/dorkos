/**
 * Adding somebody, as one more row of the roster.
 *
 * @module features/room-management/ui/AddMembersRow
 */
import type { ReactNode, RefObject } from 'react';
import { Plus } from 'lucide-react';
import type { AgentPickerCandidate, AgentRoster } from '@/layers/entities/agent';
import { AgentRosterPicker } from './AgentRosterPicker';

export interface AddMembersRowProps {
  /** Whether the picker has been opened in place. */
  expanded: boolean;
  /** Open it. */
  onExpand: () => void;
  /** The fleet, and whether it is known. */
  roster: AgentRoster;
  /** Agents to leave out — whoever is already in the room. */
  exclude: (candidate: AgentPickerCandidate) => boolean;
  /** Commit the selection, in the order the agents were picked. */
  onSubmit: (chosen: AgentPickerCandidate[]) => void;
  /** Said instead of the field when the fleet is genuinely empty. */
  emptyRosterMessage: string;
  /**
   * A way out of {@link AddMembersRowProps.emptyRosterMessage} — supplied only
   * when the emptiness is one the reader can do something about.
   */
  emptyRosterAction?: ReactNode;
  /** Said under the field when every candidate is already a chip. */
  allChosenMessage: string;
  /** Whether a write is in flight. */
  isSubmitting: boolean;
  /**
   * What adding somebody here would do, when it does more than add somebody —
   * or `null` when it does not. Said before the act rather than discovered
   * after it, and above the row, so it is on screen whether or not the picker
   * has been opened.
   */
  note: string | null;
  /**
   * The search field, handed back so the SHEET can place the cursor. Focus is
   * never taken here — see {@link AddMembersRow}.
   */
  inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * The foot of the roster: one more row, and pressing it turns that row into the
 * picker.
 *
 * **This is the shape Slack got right and then argued with itself about.** Its
 * sheet puts "Add people, agents, or apps" at the head of one list, and then
 * splits that list into a Members tab and an Agents tab — mixing them where it
 * matters and segregating them where it shows. One list with one way in is the
 * half worth keeping, and it retires three things at once: the second heading,
 * the second explanation, and a panel whose heaviest element was a disabled
 * button nobody could press.
 *
 * **It says "agents", not "people or agents".** DorkOS has one operator and the
 * roster endpoint takes an `agentPath` — there is nobody else to add. Offering
 * to add people would be a promise the product cannot keep, and the day it can
 * is the day this word changes.
 *
 * **It does not close again.** A picker you asked for is not in your way, and a
 * control whose only job is to undo the last press is one more thing to explain.
 * Closing the sheet is the way out.
 *
 * **When adding somebody changes what the room IS, that is said up here.** A
 * one-to-one holding a second agent is a group conversation, and finding that
 * out afterwards — from a stack of faces where one face used to be — is the
 * product teaching by surprise.
 *
 * **It takes no focus of its own.** The cursor belongs to the sheet, which is
 * the only thing that can win it: a menu closing behind the sheet restores focus
 * to its own trigger a commit later, so anything focused from in here is simply
 * overwritten. The same effect in the sheet also covers the cold-fleet case,
 * where the field does not exist yet at the moment it is asked for.
 */
export function AddMembersRow({
  expanded,
  onExpand,
  roster,
  exclude,
  onSubmit,
  emptyRosterMessage,
  emptyRosterAction,
  allChosenMessage,
  isSubmitting,
  note,
  inputRef,
}: AddMembersRowProps) {
  return (
    <section aria-label="Add agents" className="flex min-h-0 flex-col">
      {note !== null && <p className="text-muted-foreground mb-2 text-xs">{note}</p>}
      {expanded ? (
        <AgentRosterPicker
          roster={roster}
          exclude={exclude}
          onSubmit={onSubmit}
          submitLabel={(chosen) =>
            chosen.length > 1 ? `Add ${chosen.length} agents` : 'Add agent'
          }
          emptyRosterMessage={emptyRosterMessage}
          emptyRosterAction={emptyRosterAction}
          allChosenMessage={allChosenMessage}
          isSubmitting={isSubmitting}
          inputRef={inputRef}
        />
      ) : (
        <button
          type="button"
          onClick={onExpand}
          className="hover:bg-accent focus-visible:ring-ring flex min-h-11 w-full items-center gap-3 rounded-md text-left outline-hidden transition-colors focus-visible:ring-2 md:min-h-0 md:py-1"
        >
          {/* Dashed, and the same size as a member's disc: the row is a member
              row with nobody in it yet, which is what makes the list read as
              one thing you extend rather than two things you switch between. */}
          <span
            aria-hidden
            className="border-muted-foreground/40 text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed md:size-7"
          >
            <Plus className="size-4" />
          </span>
          <span className="text-brand text-sm font-medium">Add agents</span>
        </button>
      )}
    </section>
  );
}
