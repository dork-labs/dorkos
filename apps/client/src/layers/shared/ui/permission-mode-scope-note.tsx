import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { needsConsentRitual } from '@dorkos/shared/permission-semantics';
import { isBypassPermissionMode } from '@/layers/shared/lib/permission-mode';
import { cn } from '@/layers/shared/lib/utils';

export interface PermissionModeScopeNoteProps {
  /**
   * The permission mode currently selected. Anything that still asks renders
   * nothing.
   *
   * Optional, and a runtime MODE ID or nothing — never a dial stop. It is only
   * the fallback for a site that has no descriptor, and it is read by
   * {@link isBypassPermissionMode}, which knows mode ids. A caller that passed
   * a `PermissionStop` here ('autonomy') would be passing a string that can
   * never match, which reads like a fallback and is really a dead branch
   * (DOR-2102 review). The three runtime-neutral dials therefore pass
   * {@link descriptor} alone.
   */
  mode?: string | null;
  /**
   * The selected mode as its runtime declared it, when the render site has the
   * runtime's capability profile. Given one, the note is decided by what the
   * mode DOES; without one it falls back to the mode's name.
   */
  descriptor?: PermissionModeDescriptor;
  /** Extra classes for the surrounding paragraph. */
  className?: string;
}

/**
 * What a mode that stops asking covers, what it does NOT, and the one door to
 * the rest — said where the mode is chosen (spec `agent-approval-settings` §3.7;
 * made specific by DOR-2102).
 *
 * ## The surprise this exists to prevent
 *
 * Turning such a mode on reads as "stop asking me", and for the runtime's own
 * prompts that is exactly what it does. It does nothing to the approvals DorkOS
 * asks for on its own behalf — deleting a schedule still parks a card and waits.
 * Somebody who learns that from a card appearing after they thought they had
 * switched asking off has been misled by the product, even though every
 * individual screen was accurate.
 *
 * ## Three facts, because two of them were doing the wrong job alone
 *
 * The sentence used to say only the half that does not happen ("Actions on
 * DorkOS itself, like removing packages, still ask. Change that in Settings,
 * under Security."). Three things were wrong with it and DOR-2102 fixed all
 * three:
 *
 * 1. **It never said what the mode DOES cover**, so "tools inside the session"
 *    was the reader's problem to decode. It now names the three things a person
 *    actually pictures: editing files, running commands, working outside this
 *    project.
 * 2. **"Removing packages" is the rarest example of the class.** Deleting a
 *    schedule and removing an agent are what the destructive tier actually
 *    parks, so those are what it names.
 * 3. **"Change that in Settings, under Security" named neither the thing nor
 *    the place.** A pointer to a tab that is not there is worse than no
 *    pointer; the clause now names the card and the Permissions page.
 *
 * ## The last clause names the two ways to stop being asked
 *
 * Standing permissions were retired for per-agent, per-action "Always allow"
 * (spec `agent-permissions` D7), so the pointer names both places that set one:
 * the card itself, when it asks, and Settings under Permissions. It names them
 * and stops there: this component lives in `shared` and reads no config, so it
 * cannot know whether an action is already allowed.
 *
 * The sentence appears at the moment of the choice, in every place a permission
 * mode or a trust stop is actually picked. One component and one condition, so
 * they cannot drift into saying different things — {@link needsConsentRitual}
 * where the runtime's profile is at hand, {@link isBypassPermissionMode} on the
 * name where it is not. The picker list is frozen as a test beside this file,
 * which is what notices when a new picker appears without the note.
 *
 * DOR-2100 added the seventh: the SCHEDULE approval card, which is a pick site
 * and not merely a warning site — approving a schedule an agent proposed can
 * also grant it the operator's own trust stop, and that is the moment the
 * sentence has to arrive. Called the schedule approval card in full wherever it
 * appears here, because "the approval card" above already means a different
 * surface: the tool-approval card
 * (`features/approvals/ui/ApprovalCard.tsx`), which is the one that reads the
 * config and therefore carries the imperative.
 *
 * ## Why the condition is the door's rule, not the bypass rule
 *
 * It was `isBypassSemantics` (never asks AND reaches everything) until DOR-816.
 * The sentence is true of ANY session mode — a session's permission mode never
 * governs DorkOS-level approvals, whatever its reach — so the narrower condition
 * was not protecting accuracy, it was rationing a correction. What made that
 * untenable is that the consent dialog now carries an unqualified promise for
 * the middle stop too ("This stop never pauses to ask. Whatever it decides to
 * do, it does."), and the strongest sentence on screen is exactly the one that
 * must arrive with its own correction. Matching the door means every dialog the
 * door opens gets it.
 *
 * The name-based fallback stays narrow on purpose: with no descriptor there is
 * nothing to read `asks` off, and a mode id is only evidence about the ids
 * somebody once listed.
 *
 * All four pass a descriptor today: the binding dialog and the task form
 * resolve a runtime profile of their own to build the Trust Dial from, and the
 * schedule approval card resolves one to name the level it is offering. The
 * name-based fallback stays for the frames before that profile lands, and for a
 * mode the runtime no longer declares.
 *
 * Deliberately quiet: muted body text, no icon, no color. It is a clarification,
 * not a warning — the warning about the mode itself already exists next to it,
 * and two alarms about one setting teach a person to read neither.
 */
export function PermissionModeScopeNote({
  mode,
  descriptor,
  className,
}: PermissionModeScopeNoteProps) {
  const covers = descriptor ? needsConsentRitual(descriptor) : isBypassPermissionMode(mode);
  if (!covers) return null;
  return (
    <p
      data-slot="permission-mode-scope-note"
      className={cn('text-muted-foreground text-xs', className)}
    >
      This covers what an agent does in a session: editing files, running commands, and working
      outside this project. DorkOS’s own risky actions still stop for you, like deleting a schedule
      or removing an agent. To stop being asked about one, choose Always allow on its card, or
      change it in Settings under Permissions.
    </p>
  );
}
