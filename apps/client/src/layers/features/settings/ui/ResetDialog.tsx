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
import { toast } from 'sonner';

interface ResetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResetComplete: () => void;
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
      await transport.resetAllData('reset');
      localStorage.clear();
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
                <li>All Pulse schedules and run history</li>
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
