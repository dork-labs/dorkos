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
 * Auto mode hands tool-call approval to a safety classifier rather than the
 * user. This dialog explains the trade-off, flags it as a research preview, and
 * requires an explicit acknowledgement before the mode is applied. Subsequent
 * switches to `'auto'` in the same session skip the dialog.
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
              Research preview
            </Badge>
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                In Auto mode a safety classifier approves or denies each tool call automatically, so
                you won&rsquo;t be prompted on long autonomous runs.
              </p>
              <p>
                The classifier blocks calls it judges unsafe &mdash; destructive shell commands,
                writes outside the working directory, and other high-risk actions. Blocked calls
                appear inline in the conversation. You stay in control: switch back to another mode
                any time.
              </p>
              <p className="text-muted-foreground text-sm">
                This is a research preview and may change.
              </p>
            </div>
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
