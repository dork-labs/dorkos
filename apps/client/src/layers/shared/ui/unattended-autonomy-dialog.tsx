import type { ReactNode } from 'react';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';
import { consentActionLabel, consentAsksNote } from './consent-ritual-copy';
import { PermissionModeScopeNote } from './permission-mode-scope-note';
import { TrustModeIcon } from './trust-dial';
import { trustToneText } from './trust-tone';

export interface UnattendedAutonomyDialogProps {
  /**
   * The mode being turned on, as its runtime declared it. `null` closes the
   * dialog.
   *
   * Any mode that acts without asking (`actsWithoutAsking`): the autonomy stop,
   * or one that never asks and can do more than read.
   */
  descriptor: PermissionModeDescriptor | null;
  /** What this surface will do once nobody is asked. One or two plain sentences. */
  consequence: ReactNode;
  /** Close without applying. */
  onCancel: () => void;
  /** Apply the mode. */
  onConfirm: () => void;
}

/**
 * The door into a mode that will not stop to ask, on a surface **nobody is
 * watching** — a relay binding, a scheduled task (spec `trust-dial`, decision 5,
 * widened 2026-08-01 by DOR-816).
 *
 * Which modes is `actsWithoutAsking`'s answer, and it is wider than the dial's Full-autonomy stop: a runtime may
 * file a mode that never asks at the middle stop. An unattended surface is where
 * that matters most — there is nobody to notice — so both callers gate it here
 * rather than only at the top of the dial.
 *
 * ## Why a surface nobody is watching still asks
 *
 * A session somebody is sitting in front of no longer asks before Full autonomy
 * (ADR 261006-225605): the worst case is that they see something happen and
 * switch back. On a binding or a schedule there is no one in front of it. What a
 * person needs told is not "it stops asking" but *what stops happening* — the
 * approval message that would have arrived in their chat, the card a run would
 * have waited on. That sentence is different per surface, so the caller writes
 * it and this component holds the shape. The copy that is about the MODE lives
 * in `consent-ritual-copy`.
 *
 * It lives in `shared` because a binding dialog lives in `entities/`, which
 * cannot import a feature.
 *
 * The consequence sentence about the **mode** is still the runtime's own
 * `promise`, never copy written here: Codex says "network included" and a
 * stand-in sentence would be wrong for somebody.
 *
 * @param props - The mode being confirmed, this surface's consequence, and the
 *   two answers.
 */
export function UnattendedAutonomyDialog({
  descriptor,
  consequence,
  onCancel,
  onConfirm,
}: UnattendedAutonomyDialogProps) {
  // The dial's own tones: green at the top stop, amber for a mode that bends its
  // stop's promise. The confirm button is the plain primary one every other
  // dialog uses — a red button here would make turning on the product's headline
  // capability look like deleting something (spec `full-power-defaults`, D8).
  const tone = trustToneText(descriptor ?? undefined);
  const asksNote = descriptor ? consentAsksNote(descriptor) : null;

  return (
    <AlertDialog open={descriptor !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {/* The stop's own shape — see the session door's note. A runtime
                may file a never-asking mode at the MIDDLE stop, and this door
                opens for it. */}
            <TrustModeIcon descriptor={descriptor ?? undefined} className={`size-4 ${tone}`} />
            {descriptor && consentActionLabel(descriptor)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {descriptor?.promise}
            {/* The fact the title cannot carry on a stop whose name promises
                asking — absent at the autonomy stop, where the title already
                says it. INSIDE the description, not beside it: the description
                is what `aria-describedby` points at, and the one sentence
                written because the name hides the fact is the last one that may
                go unannounced. A `span` because a `p` cannot nest in one.

                The explicit space is load-bearing and invisible on screen: the
                accessible description is computed from text content, which
                ignores the block layout, so without it a screen reader runs the
                promise straight into this sentence with no gap. */}
            {asksNote && ' '}
            {asksNote && (
              <span className="text-foreground mt-2 block" data-testid="consent-asks-note">
                {asksNote}
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* A `div`, not a `p`: a consequence may carry its own paragraphs and a
            "More details" toggle (`ScheduledRunConsequence`). */}
        <div className="text-muted-foreground space-y-2 text-sm">{consequence}</div>
        {descriptor && <PermissionModeScopeNote mode={descriptor.id} descriptor={descriptor} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {descriptor && consentActionLabel(descriptor)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
