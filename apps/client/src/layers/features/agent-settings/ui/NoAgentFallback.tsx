import { FolderOpen } from 'lucide-react';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  PathBreadcrumb,
} from '@/layers/shared/ui';

interface NoAgentFallbackProps {
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Fallback dialog shown when no agent is registered for the given project path.
 * Displays the project path so the user can identify which directory has no agent.
 */
export function NoAgentFallback({ projectPath, open, onOpenChange }: NoAgentFallbackProps) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[85vh] max-w-lg gap-0 p-0">
        <ResponsiveDialogHeader className="space-y-0 border-b px-4 py-3">
          <ResponsiveDialogTitle className="text-sm font-medium">Agent</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            Agent configuration
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="flex h-32 flex-col items-center justify-center gap-2">
          <p className="text-muted-foreground text-sm">No agent registered</p>
          <div className="text-muted-foreground/60 flex items-center gap-1.5">
            <FolderOpen className="size-3.5 flex-shrink-0" />
            <PathBreadcrumb path={projectPath} maxSegments={3} size="sm" />
          </div>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
