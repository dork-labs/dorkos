import { Sparkles } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
} from '@/layers/shared/ui';

interface AutoModeConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the user confirms — applies `permissionMode: 'auto'`. */
  onConfirm: () => void;
}

/**
 * Once-per-session confirmation for entering the `'auto'` permission mode.
 *
 * Auto mode lets the agent approve its own routine actions and only pause for
 * risky ones, instead of prompting the user on every tool call. This dialog
 * explains that trade-off in plain language, flags it as a preview, and requires
 * an explicit acknowledgement before the mode is applied. Subsequent switches to
 * `'auto'` in the same session skip the dialog.
 */
export function AutoModeConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: AutoModeConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-red-500" />
            Turn on Auto mode
            <Badge variant="secondary" className="text-[10px] tracking-wide uppercase">
              Preview
            </Badge>
          </AlertDialogTitle>
          <AlertDialogDescription>
            The agent runs on its own and only checks with you before risky actions &mdash; like
            deleting files or running unfamiliar commands. You can switch back anytime.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Turn on Auto mode</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
