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
import { fileSizeLabel, middleTruncate, useAppDownloadPrompt } from '../frame/download';

/**
 * DorkOS's own question before an app saves a file (DOR-3293, designer
 * 2026-11-10). Drawn by the host, never inside the app's frame: the app's
 * name comes from DorkOS's records, focus starts on Cancel, Esc cancels, and
 * there is no "always allow".
 */
export function AppDownloadPrompt() {
  const pending = useAppDownloadPrompt((state) => state.pending);
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) pending?.answer(false);
      }}
    >
      <AlertDialogContent data-testid="app-download-prompt">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {pending ? `${pending.appName} wants to save a file` : ''}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono" title={pending?.name}>
              {pending ? middleTruncate(pending.name) : ''}
            </span>
            {pending ? ` · ${fileSizeLabel(pending.size)}` : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus onClick={() => pending?.answer(false)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => pending?.answer(true)}>Save</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
