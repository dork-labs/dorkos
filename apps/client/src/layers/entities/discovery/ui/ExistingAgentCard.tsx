import { CheckCircle2 } from 'lucide-react';
import type { ExistingAgent } from '@dorkos/shared/mesh-schemas';

interface ExistingAgentCardProps {
  agent: ExistingAgent;
}

/** Read-only card for an auto-imported agent that already has a manifest. */
export function ExistingAgentCard({ agent }: ExistingAgentCardProps) {
  return (
    <div className="bg-muted/50 flex items-center gap-3 rounded-lg border px-4 py-3">
      <CheckCircle2 className="text-muted-foreground size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{agent.name}</p>
        <p className="text-muted-foreground truncate text-xs">{agent.path}</p>
      </div>
      <span className="text-muted-foreground shrink-0 text-xs">Registered</span>
    </div>
  );
}
