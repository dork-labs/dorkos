import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFullscreenToggle,
} from '@/layers/shared/ui';
import { TasksPanel } from '@/layers/features/tasks';

interface DialogWrapperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Thin wrapper that renders TasksPanel inside ResponsiveDialog chrome. */
export function TasksDialogWrapper({ open, onOpenChange }: DialogWrapperProps) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="h-[85vh] max-w-2xl gap-0 p-0">
        <ResponsiveDialogFullscreenToggle />
        <ResponsiveDialogHeader className="border-b px-4 py-3">
          <ResponsiveDialogTitle className="text-sm font-medium">
            Scheduled tasks
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            See and change your scheduled tasks
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <TasksPanel />
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
