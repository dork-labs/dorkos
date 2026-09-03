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
import { getDesktopAdmin, unwrapDesktopAdminResult } from '@/layers/shared/lib';
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
      // In the desktop app the server cannot restart itself — the shell's
      // supervisor owns its process, and the HTTP route says so with a 409. Ask
      // the shell instead; it stops and respawns its child and puts this window
      // on the new port (DOR-542).
      const desktop = getDesktopAdmin();
      if (desktop) {
        unwrapDesktopAdminResult(await desktop.restartServer());
      } else {
        await transport.restartServer();
      }
      onOpenChange(false);
      onRestartComplete();
    } catch (err) {
      toast.error("Couldn't restart DorkOS.", {
        description:
          err instanceof Error ? err.message : 'It is still running, so try the button again.',
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart DorkOS</AlertDialogTitle>
          <AlertDialogDescription>
            DorkOS starts again in a few seconds. Anything running right now stops.
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
