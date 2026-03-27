import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFullscreenToggle,
} from '@/layers/shared/ui';
import { RelayPanel } from '@/layers/features/relay';

interface DialogWrapperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Thin wrapper that renders RelayPanel inside ResponsiveDialog chrome. */
export function RelayDialogWrapper({ open, onOpenChange }: DialogWrapperProps) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="h-[85vh] max-w-2xl gap-0 p-0">
        <ResponsiveDialogFullscreenToggle />
        <ResponsiveDialogHeader className="border-b px-4 py-3">
          <ResponsiveDialogTitle className="text-sm font-medium">Connections</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            Manage adapters and monitor message activity
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <RelayPanel />
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
