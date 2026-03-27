import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFullscreenToggle,
} from '@/layers/shared/ui';
import { MeshPanel } from '@/layers/features/mesh';

interface DialogWrapperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Thin wrapper that renders MeshPanel inside ResponsiveDialog chrome. */
export function MeshDialogWrapper({ open, onOpenChange }: DialogWrapperProps) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="h-[85vh] max-w-2xl gap-0 p-0">
        <ResponsiveDialogFullscreenToggle />
        <ResponsiveDialogHeader className="border-b px-4 py-3">
          <ResponsiveDialogTitle className="text-sm font-medium">Mesh</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            Agent discovery and registry
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <MeshPanel />
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
