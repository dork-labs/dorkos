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
  PermissionModeScopeNote,
} from '@/layers/shared/ui';

interface AutonomyConfirmDialogProps {
  /** The autonomy mode being turned on, as its runtime declared it. Null when closed. */
  descriptor: PermissionModeDescriptor | null;
  /** Close without applying. */
  onCancel: () => void;
  /** Called when the person confirms — applies the mode. */
  onConfirm: () => void;
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
 * ## What is deliberately not here yet
 *
 * Decision 5 also asks for a durable, user-level acknowledgement ("don't show
 * this again") and a **server** that refuses autonomy without one, so no client
 * can skip the gate. That is the next change; this dialog is the same component
 * it will wire, and today's memory is per-session, like Auto's.
 *
 * @param props - The mode being confirmed, and the two answers.
 */
export function AutonomyConfirmDialog({
  descriptor,
  onCancel,
  onConfirm,
}: AutonomyConfirmDialogProps) {
  return (
    <AlertDialog open={descriptor !== null} onOpenChange={(open) => !open && onCancel()}>
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
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Turn on Full autonomy</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
