import { AlertTriangle } from 'lucide-react';
import { MoreDetails } from '@/layers/shared/ui';

/**
 * Warning banner shown at the top of the expanded External MCP card.
 *
 * Tells operators NOT to configure the External MCP for agents that already
 * run inside DorkOS — the duplicate tool names trigger an HTTP 400 from the
 * Anthropic API.
 */
export function DuplicateToolWarning() {
  return (
    <div className="flex gap-3 rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div className="space-y-1">
        <p className="text-xs font-medium">Not for agents that run inside DorkOS</p>
        <p className="text-muted-foreground text-xs">
          Those agents already have these tools. Adding them twice stops every tool call.
        </p>
        <MoreDetails className="text-xs">
          <p>Claude rejects the repeated tool names with “Tool names must be unique”.</p>
          <p>This is for apps running on their own: Claude Code, Cursor, Windsurf.</p>
        </MoreDetails>
      </div>
    </div>
  );
}
