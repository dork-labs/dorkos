import type { ReactNode } from 'react';
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
} from './alert-dialog';
import { PermissionModeScopeNote } from './permission-mode-scope-note';

export interface UnattendedAutonomyDialogProps {
  /**
   * The autonomy mode being turned on, as its runtime declared it. `null` closes
   * the dialog — the same open/closed convention the session's own autonomy
   * dialog uses, so the two read alike at their call sites.
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
 * The door into Full autonomy on a surface **nobody is watching** — a relay
 * binding, a scheduled task (spec `trust-dial`, decision 5).
 *
 * ## Why this is not the session's dialog
 *
 * `features/status`' `AutonomyConfirmDialog` asks about a session somebody is
 * sitting in front of: the worst case is that they see something happen and
 * switch back. On a binding or a schedule there is no one in front of it. What a
 * person needs told is not "it stops asking" but *what stops happening* — the
 * approval message that would have arrived in their chat, the card a run would
 * have waited on. That sentence is different per surface, so the caller writes
 * it and this component holds the shape.
 *
 * Layer-wise it could not be shared even if the copy were identical: a binding
 * dialog lives in `entities/`, which cannot import a feature. Both halves point
 * the same way — the shape belongs down here.
 *
 * The consequence sentence about the **mode** is still the runtime's own
 * `promise`, never copy written here, for the reason the session dialog
 * documents: Codex says "network included" and a stand-in sentence would be
 * wrong for somebody.
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
          <AlertDialogDescription>{descriptor?.promise}</AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-muted-foreground text-sm">{consequence}</p>
        {descriptor && <PermissionModeScopeNote mode={descriptor.id} descriptor={descriptor} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
          >
            Turn on Full autonomy
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
