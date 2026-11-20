/**
 * The one confirm saving a schedule at a level that acts without asking takes
 * (DOR-3841): the shared unattended-autonomy dialog, with what it means for a
 * schedule's runs.
 *
 * @module features/tasks/ui/autonomy/TaskAutonomyConfirm
 */
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { UnattendedAutonomyDialog } from '@/layers/shared/ui';

/** Props for {@link TaskAutonomyConfirm}. */
export interface TaskAutonomyConfirmProps {
  /** The mode the save would store, as its runtime declared it. `null` closes it. */
  descriptor: PermissionModeDescriptor | null;
  /** Close without saving. */
  onCancel: () => void;
  /** Save the schedule. */
  onConfirm: () => void;
}

/**
 * Ask once before a schedule is saved at a level that acts without asking.
 * Cancel saves nothing.
 *
 * @param props - The mode being saved and the two answers.
 */
export function TaskAutonomyConfirm({ descriptor, onCancel, onConfirm }: TaskAutonomyConfirmProps) {
  return (
    <UnattendedAutonomyDialog
      descriptor={descriptor}
      consequence={<p>Every run of this schedule acts on its own. Nobody is asked first.</p>}
      // The form beside it already shows the mode's own sentence and what it
      // covers, so the dialog says only what saving changes (DOR-3841 review).
      restatesMode={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
