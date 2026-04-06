import { AlertTriangle } from 'lucide-react';

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
        <p className="text-xs font-medium">
          Do not configure this for agents running inside DorkOS.
        </p>
        <p className="text-muted-foreground text-xs">
          DorkOS already provides tools to its managed agents internally. Adding DorkOS as an
          external MCP server to those same agents causes duplicate tool names — the Anthropic API
          will return HTTP 400 &ldquo;Tool names must be unique&rdquo; and all tool calls will fail.
          External MCP access is for agents running <strong>outside</strong> of DorkOS (standalone
          Claude Code, Cursor, Windsurf).
        </p>
      </div>
    </div>
  );
}
