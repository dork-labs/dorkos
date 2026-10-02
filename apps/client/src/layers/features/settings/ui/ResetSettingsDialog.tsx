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
    toast.success('Settings are back to defaults');
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset all settings?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>Theme, text, toggles and layouts on this device go back to default.</p>
              <p>Nothing you made is deleted. Your projects, agents and chats stay.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleReset}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 dark:bg-destructive/60"
          >
            Reset settings
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
