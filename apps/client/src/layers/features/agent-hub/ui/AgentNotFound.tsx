import { AlertCircle } from 'lucide-react';

interface AgentNotFoundProps {
  /** The agent path that could not be resolved. */
  agentPath: string;
}

/**
 * Empty state shown when the hub has an agentPath but the agent
 * cannot be found (e.g., the directory was deleted or the agent
 * manifest is missing).
 */
export function AgentNotFound({ agentPath }: AgentNotFoundProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="bg-destructive/10 flex size-12 items-center justify-center rounded-full">
        <AlertCircle className="text-destructive size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">Agent not found</p>
        <p className="text-muted-foreground font-mono text-xs break-all">{agentPath}</p>
        <p className="text-muted-foreground text-xs">The agent at this path could not be loaded.</p>
      </div>
    </div>
  );
}
