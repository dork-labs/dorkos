import { useState } from 'react';
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
  Checkbox,
  consentActionLabel,
  consentAsksNote,
  Label,
  PermissionModeScopeNote,
  TrustModeIcon,
  trustToneText,
} from '@/layers/shared/ui';

interface AutonomyConfirmDialogProps {
  /**
   * The mode being turned on, as its runtime declared it. Null when closed.
   *
   * Any mode that goes through the consent door — the autonomy stop, or one that
   * never asks and can do more than read (`needsConsentRitual`). Every word on
   * screen is derived from it.
   */
  descriptor: PermissionModeDescriptor | null;
  /** Close without applying. */
  onCancel: () => void;
  /**
   * Called when the person confirms — applies the mode.
   *
   * @param rememberChoice - Whether they ticked "don't show this again", which
   *   records a standing acknowledgement instead of asking every time. Always
   *   `false` when {@link canRemember} is `false`.
   */
  onConfirm: (rememberChoice: boolean) => void;
  /**
   * Whether this install can keep a standing acknowledgement at all. When
   * `false` the checkbox is not offered — see the note in the component doc.
   */
  canRemember: boolean;
  /**
   * One sentence for the caller whose confirmation IS the standing record, shown
   * where the checkbox would be.
   *
   * Settings is that caller (spec `trust-dial`, decision 6): choosing Full
   * autonomy as the default cannot happen without an acknowledgement — the
   * server refuses the write — so there is nothing optional left for a checkbox
   * to ask. Saying so in place of the checkbox is the honest swap; leaving both
   * out would record consent the person was never told they were giving.
   */
  consentNote?: string;
}

/**
 * The door into a mode that will not stop to ask (spec `trust-dial`, decision 5,
 * widened 2026-08-01 by DOR-816).
 *
 * A setting that stops the asking is the one a person cannot walk back: by the
 * time they notice, whatever happened has happened. Every setting that still
 * asks is one click and instantly reversible, which is why only these ask twice.
 *
 * **Which modes is not this component's decision.** `needsConsentRitual` in
 * `@dorkos/shared/permission-semantics` answers it, the server's `PATCH
 * /api/sessions/:id` applies the same rule, and the answer is wider than the
 * dial's Full-autonomy stop: a runtime may file a mode that never asks at the
 * MIDDLE stop, which Codex does. So nothing here says "Full autonomy" in
 * hardcoded copy — the title, the button and the tint are all read off the
 * descriptor, or a person choosing Act would be told they had chosen something
 * else.
 *
 * It matters that a **keyboard** reaches this dialog too. A radio group selects
 * as focus moves, so arrowing along the dial commits each stop it passes — the
 * segmented control stops looping at the ends for the same reason, and this gate
 * catches the deliberate press.
 *
 * The consequence sentence is the runtime's own `promise`, not copy written
 * here: what a stop means differs by agent (Codex says "network included", and
 * at its middle stop "Codex can't pause to ask"), and a stand-in sentence would
 * be wrong for somebody. The scope note beneath it is the same one the dial
 * carries — what this does NOT cover — and it renders on EVERY mode this dialog
 * opens for, because it is decided by the same `needsConsentRitual` the door is
 * (DOR-816). That pairing is deliberate: the strongest sentence on screen is the
 * one that must arrive with its own correction, and the middle stop's is the
 * strongest of all ("whatever it decides to do, it does").
 *
 * ## This dialog is not the gate
 *
 * The gate is on the server: `PATCH /api/sessions/:id` refuses a mode that never
 * asks unless the request carries an acknowledgement, and answers `428
 * AUTONOMY_ACK_REQUIRED` when it does not. This dialog is how a person GIVES
 * that acknowledgement — it is the ritual, and the server is what makes the
 * ritual unskippable. Two consequences worth knowing: a second cockpit tab
 * cannot slip past it, and if one ever tries, the refusal comes back here as
 * this dialog rather than as an error nobody can act on.
 *
 * "Don't show this again" trades a repeated ritual for a recorded one. It writes
 * a dated acknowledgement into user config, and the cockpit then sends that
 * standing consent with every gated mode change instead of stopping to ask. ONE
 * record covers the whole door, whichever mode opened it: what the person
 * acknowledged is that a mode will not stop to ask, and that is the same fact at
 * either stop. The server's requirement never relaxes; only the asking does.
 * Settings shows the date back with a way to clear it, which brings this dialog
 * straight back.
 *
 * ## Where the checkbox is not offered
 *
 * `canRemember` is `false` in Obsidian, where the cockpit runs on the in-process
 * `DirectTransport` and there is no config file behind it: `updateConfig` is a
 * documented no-op and `getConfig` returns no `ui` block. A checkbox there would
 * tick, save nothing, report no error, and ask again forever — a promise the
 * product cannot keep, which is worse than not offering it. So the row is
 * absent, and the dialog simply asks each time, as it did before this existed.
 *
 * @param props - The mode being confirmed, the two answers, and whether a
 *   standing acknowledgement can be kept.
 */
export function AutonomyConfirmDialog({
  descriptor,
  onCancel,
  onConfirm,
  canRemember,
  consentNote,
}: AutonomyConfirmDialogProps) {
  const open = descriptor !== null;
  const [rememberChoice, setRememberChoice] = useState(false);

  // A tick is an answer to THIS asking. Left standing, it would ride into the
  // next one already checked — so a person who cancelled, thought better of it,
  // and came back would be silently agreeing to never be asked again.
  //
  // Adjusted during render on the open transition rather than in an effect
  // (React's "adjusting state when a prop changes"). An effect would reset it a
  // paint LATE, which is a frame of the previous answer showing on a fresh ask,
  // and would spend a second render doing it.
  const [openCycle, setOpenCycle] = useState(open);
  if (open !== openCycle) {
    setOpenCycle(open);
    setRememberChoice(false);
  }

  // The same tones the dial's caption uses, from the same rule: green at the top
  // stop, amber where this door's other traffic bends a promise. A door is not an
  // accusation — the person is turning on the thing the product is for, and the
  // sentences below already tell them exactly what it means.
  const tone = trustToneText(descriptor ?? undefined);
  const asksNote = descriptor ? consentAsksNote(descriptor) : null;

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {/* The stop's OWN shape, never a fixed one: this door opens for the
                middle stop too (Codex's workspace-write), and a title reading
                "Turn on Act" beside the full-autonomy bolt would claim a
                position the person is not taking. Same table the dial draws
                from, so the icon beside the title and the icon on the segment
                they just pressed are the same shape. */}
            <TrustModeIcon descriptor={descriptor ?? undefined} className={`size-4 ${tone}`} />
            {descriptor && consentActionLabel(descriptor)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {descriptor?.promise} You can switch back anytime.
            {/* The fact the title cannot carry on a stop whose name promises
                asking — absent at the autonomy stop, where the title already
                says it. INSIDE the description, not beside it: the description
                is what `aria-describedby` points at, and the one sentence
                written because the name hides the fact is the last one that may
                go unannounced. A `span` because a `p` cannot nest in one.

                The explicit space is load-bearing and invisible on screen: the
                accessible description is computed from text content, which
                ignores the block layout, so without it a screen reader reads
                "…switch back anytime.This stop never pauses…". */}
            {asksNote && ' '}
            {asksNote && (
              <span className="text-foreground mt-2 block" data-testid="consent-asks-note">
                {asksNote}
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {descriptor && <PermissionModeScopeNote mode={descriptor.id} descriptor={descriptor} />}
        {/* Below the scope note, above the buttons: a person reads what this
            means before they are offered the chance to stop being told. Absent
            where nothing could store the answer — see the component doc. */}
        {consentNote && (
          <p className="text-muted-foreground text-sm" data-testid="autonomy-consent-note">
            {consentNote}
          </p>
        )}
        {canRemember && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="autonomy-remember-choice"
              checked={rememberChoice}
              onCheckedChange={(checked) => setRememberChoice(checked === true)}
            />
            <Label htmlFor="autonomy-remember-choice" className="text-muted-foreground text-sm">
              Don&apos;t show this again
            </Label>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => onConfirm(rememberChoice)}>
            {descriptor && consentActionLabel(descriptor)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
