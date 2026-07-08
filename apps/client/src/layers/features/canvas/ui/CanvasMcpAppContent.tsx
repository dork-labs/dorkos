import type { UiCanvasContent } from '@dorkos/shared/types';
import { McpAppFrame } from '@/layers/features/mcp-apps';
import { useSessionId } from '@/layers/entities/session';

interface CanvasMcpAppContentProps {
  /** MCP App canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'mcp_app' }>;
}

/**
 * Render an MCP App (SEP-1865) full-size in the canvas — the same sandboxed
 * {@link McpAppFrame} used inline, given the whole pane. This is the surface a
 * `ui/request-display-mode: fullscreen` request (or a `control_ui`-opened
 * `mcp_app` canvas) lands on. The active session id scopes the resource fetch.
 */
export function CanvasMcpAppContent({ content }: CanvasMcpAppContentProps) {
  const [sessionId] = useSessionId();
  if (!sessionId) return null;
  return (
    <div className="h-full w-full">
      <McpAppFrame
        sessionId={sessionId}
        serverName={content.serverName}
        uri={content.uri}
        title={content.title}
      />
    </div>
  );
}
