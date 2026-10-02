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
import { restartDorkOS } from '@/layers/shared/lib';
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
      // In the desktop app the shell's supervisor restarts the server, and
      // puts this window on the new port (DOR-542); restartDorkOS picks.
      await restartDorkOS(transport);
      onOpenChange(false);
      onRestartComplete();
    } catch (err) {
      toast.error('Couldn’t restart DorkOS.', {
        description: err instanceof Error ? err.message : 'It may not have restarted. Try again.',
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart DorkOS?</AlertDialogTitle>
          <AlertDialogDescription>
            Anything running right now stops. DorkOS is back in seconds.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={isSubmitting} onClick={handleRestart}>
            {isSubmitting ? 'Restarting…' : 'Restart DorkOS'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
