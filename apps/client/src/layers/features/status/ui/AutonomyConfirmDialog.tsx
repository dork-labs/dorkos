import { useEffect, useState } from 'react';
import { ShieldOff } from 'lucide-react';
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
  Label,
  PermissionModeScopeNote,
} from '@/layers/shared/ui';

interface AutonomyConfirmDialogProps {
  /** The autonomy mode being turned on, as its runtime declared it. Null when closed. */
  descriptor: PermissionModeDescriptor | null;
  /** Close without applying. */
  onCancel: () => void;
  /**
   * Called when the person confirms — applies the mode.
   *
   * @param rememberChoice - Whether they ticked "don't show this again", which
   *   records a standing acknowledgement instead of asking every time.
   */
  onConfirm: (rememberChoice: boolean) => void;
}

/**
 * The door into Full autonomy (spec `trust-dial`, decision 5).
 *
 * The autonomy stop is the one setting on the dial a person cannot walk back:
 * the agent stops asking, so by the time they notice, whatever happened has
 * happened. Every other stop is one click and instantly reversible, which is why
 * this is the only one that asks twice.
 *
 * It matters that a **keyboard** reaches this dialog too. A radio group selects
 * as focus moves, so arrowing along the dial commits each stop it passes — the
 * segmented control stops looping at the ends for the same reason, and this gate
 * catches the deliberate press.
 *
 * The consequence sentence is the runtime's own `promise`, not copy written
 * here: what Full autonomy means differs by agent (Codex says "network
 * included"), and a stand-in sentence would be wrong for somebody. The scope
 * note beneath it is the same one the dial carries — what this does NOT cover.
 *
 * ## This dialog is not the gate
 *
 * The gate is on the server: `PATCH /api/sessions/:id` refuses a Full-autonomy
 * mode unless the request carries an acknowledgement, and answers `428
 * AUTONOMY_ACK_REQUIRED` when it does not. This dialog is how a person GIVES
 * that acknowledgement — it is the ritual, and the server is what makes the
 * ritual unskippable. Two consequences worth knowing: a second cockpit tab
 * cannot slip past it, and if one ever tries, the refusal comes back here as
 * this dialog rather than as an error nobody can act on.
 *
 * "Don't show this again" trades a repeated ritual for a recorded one. It writes
 * a dated acknowledgement into user config, and the cockpit then sends that
 * standing consent with every autonomy change instead of stopping to ask. The
 * server's requirement never relaxes; only the asking does. Settings shows the
 * date back with a way to clear it, which brings this dialog straight back.
 *
 * @param props - The mode being confirmed, and the two answers.
 */
export function AutonomyConfirmDialog({
  descriptor,
  onCancel,
  onConfirm,
}: AutonomyConfirmDialogProps) {
  const open = descriptor !== null;
  const [rememberChoice, setRememberChoice] = useState(false);

  // A tick is an answer to THIS asking. Left standing, it would ride into the
  // next one already checked — so a person who cancelled, thought better of it,
  // and came back would be silently agreeing to never be asked again.
  useEffect(() => {
    if (!open) setRememberChoice(false);
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {/* Red here, and only here on this surface: this is the one setting
                that never asks about anything, anywhere. */}
            <ShieldOff className="size-4 text-red-500" />
            Turn on Full autonomy
          </AlertDialogTitle>
          <AlertDialogDescription>
            {descriptor?.promise} You can switch back anytime.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {descriptor && <PermissionModeScopeNote mode={descriptor.id} descriptor={descriptor} />}
        {/* Below the scope note, above the buttons: a person reads what this
            means before they are offered the chance to stop being told. */}
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
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => onConfirm(rememberChoice)}>
            Turn on Full autonomy
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
