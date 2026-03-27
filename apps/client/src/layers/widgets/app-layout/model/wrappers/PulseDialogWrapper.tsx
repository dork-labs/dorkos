import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFullscreenToggle,
} from '@/layers/shared/ui';
import { PulsePanel } from '@/layers/features/pulse';

interface DialogWrapperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Thin wrapper that renders PulsePanel inside ResponsiveDialog chrome. */
export function PulseDialogWrapper({ open, onOpenChange }: DialogWrapperProps) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="h-[85vh] max-w-2xl gap-0 p-0">
        <ResponsiveDialogFullscreenToggle />
        <ResponsiveDialogHeader className="border-b px-4 py-3">
          <ResponsiveDialogTitle className="text-sm font-medium">
            Pulse Scheduler
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            Manage scheduled AI agent tasks
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <PulsePanel />
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
