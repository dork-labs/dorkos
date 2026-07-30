/**
 * The "are you sure" for taking an agent out of a room.
 *
 * @module features/room-management/ui/RemoveMemberConfirm
 */
import type { Ref } from 'react';
import { Button } from '@/layers/shared/ui';

export interface RemoveMemberConfirmProps {
  /** The agent being taken out. */
  memberName: string;
  /** The room it is being taken out of, as it reads in prose. */
  roomTitle: string;
  /** Go ahead. */
  onConfirm: () => void;
  /** Never mind. */
  onCancel: () => void;
  /**
   * The destructive button, so whatever raised this can put the keyboard on it.
   * Focus is the CALLER's to place: a menu that closes a commit later would
   * otherwise pull it straight back to its own trigger.
   */
  confirmRef?: Ref<HTMLButtonElement>;
}

/**
 * Confirmed in place, never in a second dialog.
 *
 * A dialog over a dialog closed BOTH when it was answered — the inner one's
 * dismissal reaches the outer as an interaction from outside it — so the roster
 * the reader was working on vanished along with the confirmation. jsdom has no
 * portals to race; only a browser ever showed it.
 *
 * The sentence says the two things a person cannot see: what stays (everything
 * already said) and what does not (the agent's session binding for this room).
 */
export function RemoveMemberConfirm({
  memberName,
  roomTitle,
  onConfirm,
  onCancel,
  confirmRef,
}: RemoveMemberConfirmProps) {
  return (
    <div
      role="group"
      aria-label={`Remove ${memberName} from ${roomTitle}?`}
      // Indented under the name, the same as the loudness scale, so it reads as
      // belonging to this member rather than to the list it interrupts.
      className="bg-muted/60 mt-2 ml-11 space-y-2 rounded-md p-2 md:ml-10"
    >
      <p className="text-muted-foreground text-xs">
        Remove {memberName}? It stops seeing new messages here and what it already said stays.
        Adding it back starts a fresh session.
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button ref={confirmRef} type="button" size="sm" variant="destructive" onClick={onConfirm}>
          Remove
        </Button>
      </div>
    </div>
  );
}
