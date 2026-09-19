import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { needsConsentRitual } from '@dorkos/shared/permission-semantics';
import { isBypassPermissionMode } from '@/layers/shared/lib/permission-mode';
import { cn } from '@/layers/shared/lib/utils';

export interface PermissionModeScopeNoteProps {
  /** The permission mode currently selected. Anything that still asks renders nothing. */
  mode: string | null | undefined;
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
 * What a mode that stops asking does NOT cover, said where the mode is chosen
 * (spec `agent-approval-settings` §3.7).
 *
 * ## The surprise this exists to prevent
 *
 * Turning such a mode on reads as "stop asking me", and for tools inside the
 * session that is exactly what it does. It does nothing to the approvals DorkOS
 * asks for on its own behalf — removing an installed package still stops and
 * waits. Somebody who learns that from a card appearing after they thought they
 * had switched asking off has been misled by the product, even though every
 * individual screen was accurate.
 *
 * So the sentence appears at the moment of the choice, in every place a
 * permission mode is actually picked: the session status line, a relay binding,
 * a scheduled task's form, and — since DOR-2100 — the approval card, where
 * arming a proposed schedule can also grant it the operator's own trust stop.
 * One component and one condition, so they cannot drift into saying different
 * things — {@link needsConsentRitual} where the runtime's profile is at hand,
 * {@link isBypassPermissionMode} on the name where it is not.
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
 * They all pass a descriptor today: the binding dialog, the task form and the
 * approval card each resolve a runtime profile of their own — the first two to
 * build a Trust Dial from, the card to name the level it is offering. The
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
      This covers tools inside the session. Actions on DorkOS itself, like removing packages, still
      ask. Change that in Settings, under Security.
    </p>
  );
}
