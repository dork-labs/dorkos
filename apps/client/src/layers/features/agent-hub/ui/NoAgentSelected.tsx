import { User } from 'lucide-react';

/**
 * Empty state shown when no agent path is set in the hub store.
 */
export function NoAgentSelected() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="bg-muted flex size-12 items-center justify-center rounded-full">
        <User className="text-muted-foreground size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">No agent selected</p>
        <p className="text-muted-foreground text-xs">Select an agent to view its profile.</p>
      </div>
    </div>
  );
}
