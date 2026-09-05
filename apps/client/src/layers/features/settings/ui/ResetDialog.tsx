import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Input,
} from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { getDesktopAdmin, unwrapDesktopAdminResult } from '@/layers/shared/lib';
import { toast } from 'sonner';

interface ResetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResetComplete: () => void;
}

/**
 * Empty this device's stored preferences for the duration of `act`, and put them
 * back if it fails.
 *
 * The desktop reset has to clear first — the shell reloads this window as soon
 * as its server is back, and a `localStorage.clear()` queued behind that may
 * never run. Clearing first means a refused reset would otherwise take the
 * theme, the panel layouts and every toggle with it while deleting nothing at
 * all, so the clear is undone on the way out.
 *
 * @param act - The reset to attempt.
 * @returns Whatever `act` resolved with.
 * @throws Whatever `act` threw, after the preferences are restored.
 */
async function clearingPreferences<T>(act: () => Promise<T>): Promise<T> {
  const remembered = new Map<string, string>();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null) continue;
    const value = localStorage.getItem(key);
    if (value !== null) remembered.set(key, value);
  }
  localStorage.clear();
  try {
    return await act();
  } catch (err) {
    for (const [key, value] of remembered) localStorage.setItem(key, value);
    throw err;
  }
}

/** Confirmation dialog for resetting all DorkOS data. */
export function ResetDialog({ open, onOpenChange, onResetComplete }: ResetDialogProps) {
  const [confirmText, setConfirmText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const transport = useTransport();

  const isConfirmed = confirmText === 'reset';

  async function handleReset() {
    setIsSubmitting(true);
    try {
      // In the desktop app the server cannot delete its own data directory and
      // come back — the shell's supervisor owns its process. The shell does it
      // between stopping the old server and starting the new one, which is the
      // only moment nothing holds the directory (DOR-542).
      const desktop = getDesktopAdmin();
      if (desktop) {
        // Cleared BEFORE the call, and put back if it fails: the shell reloads
        // this window onto the restarted server the moment it is up, so anything
        // this page has to forget must already be forgotten by then — but a
        // reset the shell refused deleted nothing, and it must not be the reason
        // someone's theme and panel layouts went with it.
        // The unwrap happens INSIDE, so a refusal — which arrives as a resolved
        // `{ ok: false }`, not a rejection — is what triggers the restore.
        await clearingPreferences(async () => {
          unwrapDesktopAdminResult(await desktop.resetAllData());
        });
      } else {
        await transport.resetAllData('reset');
        localStorage.clear();
      }
      onOpenChange(false);
      onResetComplete();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reset data');
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setConfirmText('');
      setIsSubmitting(false);
    }
    onOpenChange(nextOpen);
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset All Data</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>This will permanently delete all DorkOS data, including:</p>
              <ul className="list-inside list-disc space-y-1 text-sm">
                <li>All scheduled tasks and their run history</li>
                <li>All Relay configuration and messages</li>
                <li>All Mesh agent registry data</li>
                <li>Your config file and preferences</li>
                <li>All server logs</li>
              </ul>
              <p>
                The server will restart automatically. Your UI preferences will also be cleared.
              </p>
              <p className="font-semibold">This action cannot be undone.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="py-2">
          <Input
            placeholder='Type "reset" to confirm'
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            data-testid="reset-confirm-input"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!isConfirmed || isSubmitting}
            onClick={handleReset}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isSubmitting ? 'Resetting...' : 'Reset All Data'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
