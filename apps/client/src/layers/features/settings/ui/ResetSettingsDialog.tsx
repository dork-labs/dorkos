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
import { useAppStore, useTheme } from '@/layers/shared/model';
import { toast } from 'sonner';

interface ResetSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Confirmation dialog for the clean slate — every setting this browser holds,
 * back to how it shipped.
 *
 * The confirm is the whole reason this is a dialog: a panel's own "Reset to
 * defaults" is narrow and instant, so the one action that reaches everything
 * has to be asked for on purpose (DOR-923).
 */
export function ResetSettingsDialog({ open, onOpenChange }: ResetSettingsDialogProps) {
  const resetAllSettings = useAppStore((s) => s.resetAllSettings);
  const { setTheme } = useTheme();

  function handleReset() {
    resetAllSettings();
    setTheme('system');
    onOpenChange(false);
    toast.success('Your settings are back to their defaults.');
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset All Settings</AlertDialogTitle>
          <AlertDialogDescription>
            This puts the theme, text, toggles, and panel layouts on this device back to how they
            shipped. Nothing you have made is deleted — your projects, agents, and chats stay.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleReset}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Reset Settings
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
