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
} from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { toast } from 'sonner';

interface RestartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestartComplete: () => void;
}

/** Confirmation dialog for restarting the DorkOS server. */
export function RestartDialog({ open, onOpenChange, onRestartComplete }: RestartDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const transport = useTransport();

  async function handleRestart() {
    setIsSubmitting(true);
    try {
      await transport.restartServer();
      onOpenChange(false);
      onRestartComplete();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to restart server');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart Server</AlertDialogTitle>
          <AlertDialogDescription>
            This will restart the DorkOS server. All active sessions will be interrupted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={isSubmitting} onClick={handleRestart}>
            {isSubmitting ? 'Restarting...' : 'Restart Server'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
