import type { BackupCopyInfo } from '@dorkos/shared/transport-backups';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/layers/shared/ui';
import { formatBytes } from '../../model/use-backups';

interface RemoveBackupDialogProps {
  /** The copy to remove, or null when the dialog is closed. */
  copy: BackupCopyInfo | null;
  onCancel: () => void;
  onConfirm: (copy: BackupCopyInfo) => void;
}

/** The confirm before an older backup is deleted for good. */
export function RemoveBackupDialog({ copy, onCancel, onConfirm }: RemoveBackupDialogProps) {
  return (
    <AlertDialog open={copy !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this backup?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>It frees {copy ? formatBytes(copy.sizeBytes) : ''}. It can’t be brought back.</p>
              <p className="font-mono text-xs break-all">{copy?.name}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => copy && onConfirm(copy)}>
            Remove backup
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
