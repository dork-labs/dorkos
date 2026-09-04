/**
 * The words both consent dialogs use, written once.
 *
 * Two surfaces ask a person to confirm a mode that will not stop to ask — the
 * session's `AutonomyConfirmDialog` and this folder's
 * {@link UnattendedAutonomyDialog} — and they must say the same thing, or the
 * product has two spellings of one promise. The shape of each dialog still
 * differs (one offers "don't show this again", the other says what stops
 * happening on a surface nobody is watching); only the copy that is ABOUT THE
 * MODE lives here.
 *
 * Everything is derived from the descriptor the runtime declared. No mode ids,
 * no runtime names (spec `trust-dial`, decision 2A).
 *
 * @module shared/ui/consent-ritual-copy
 */
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { isAutonomyStop, needsConsentRitual } from '@/layers/shared/lib';
import { stopLabel } from './trust-dial';

/**
 * What the dialog's title and its confirm button both say.
 *
 * The dial's word for the stop, not the runtime's word for the mode: a person
 * pressed a segment labelled "Act" or "Full autonomy", and a dialog naming
 * something they have not seen on screen ("Workspace write") reads as a
 * different question about a different thing. The runtime's own sentence is
 * directly beneath it, which is where the per-runtime truth belongs.
 *
 * @param descriptor - The mode being confirmed, as its runtime declared it.
 */
export function consentActionLabel(descriptor: PermissionModeDescriptor): string {
  return `Turn on ${stopLabel(descriptor.stop)}`;
}

/**
 * The one sentence a person needs when the stop they picked is not the one
 * everybody knows stops asking — or `null` when the sentence would be
 * redundant or untrue.
 *
 * Full autonomy announces itself: the title names the stop and the promise
 * under it now says outright that nothing will stop to ask (DOR-1754 took the
 * softening clause off every autonomy promise), so a third sentence saying it
 * again is noise. A middle stop does not announce anything —
 * somebody choosing "Act" is choosing "ask me about the risky parts", and on a
 * runtime that cannot pause mid-turn that is not what they get. This is the
 * sentence that makes the difference impossible to miss.
 *
 * ## Why the door's own rule guards it
 *
 * The narrow reading — "never asks and is not the autonomy stop" — is true of
 * Codex's SHIPPED read-only default (`stop: 'ask'`, `asks: 'never'`,
 * `reach: 'read'`), which never asks because it has nothing to ask about.
 * Telling somebody that mode does whatever it decides to do is the opposite of
 * true, and it is the safest setting on offer. No call site can reach that today
 * — all four resolve a mode the door already accepted — but this is exported
 * from the barrel, so the guard belongs in the function rather than in the
 * habits of its callers. {@link needsConsentRitual} is the same rule the server
 * and every dial apply, which is what keeps this sentence appearing exactly
 * where the door opens and nowhere else.
 *
 * @param descriptor - The mode being confirmed, as its runtime declared it.
 */
export function consentAsksNote(descriptor: PermissionModeDescriptor): string | null {
  if (!needsConsentRitual(descriptor) || isAutonomyStop(descriptor)) return null;
  return 'This stop never pauses to ask. Whatever it decides to do, it does.';
}
