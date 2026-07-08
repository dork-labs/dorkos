/**
 * Inline chat surface for an MCP App (SEP-1865). Rendered on a `tool_call` part
 * whose result carries a `ui://` App reference (spec `mcp-apps-host` §2.3).
 *
 * Gated by first-use, per-server render consent: interactive third-party HTML
 * runs sandboxed scripts, so the first App from a given server shows a consent
 * card before anything renders; the choice is remembered per server. Once
 * consented, the App renders inline with a "fullscreen" affordance that moves it
 * to the canvas.
 *
 * @module features/mcp-apps/ui/McpAppBlock
 */
import { AppWindow, Maximize2 } from 'lucide-react';
import { useAppStore } from '@/layers/shared/model';
import { McpAppFrame } from './McpAppFrame';
import { useRenderConsent } from '../model/render-consent';

export interface McpAppBlockProps {
  /** Session that owns the MCP server. */
  sessionId: string;
  /** MCP server that ships the App. */
  serverName: string;
  /** The `ui://` resource URI to render. */
  uri: string;
  /** Optional App title. */
  title?: string;
}

/** Fixed inline height — enough to be useful without dominating the transcript. */
const INLINE_HEIGHT = 'h-80';

/**
 * Render the inline MCP App block: a consent card first, then the sandboxed App.
 *
 * @param props - Session/server/URI and optional title.
 */
export function McpAppBlock({ sessionId, serverName, uri, title }: McpAppBlockProps) {
  const { consented, grant } = useRenderConsent(serverName);
  const setCanvasOpen = useAppStore((s) => s.setCanvasOpen);
  const openCanvasDocument = useAppStore((s) => s.openCanvasDocument);

  const openFullscreen = () => {
    openCanvasDocument({ type: 'mcp_app', serverName, uri, title });
    setCanvasOpen(true);
  };

  if (!consented) {
    return (
      <div className="bg-muted/40 flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <AppWindow className="text-muted-foreground size-4 shrink-0" />
          <span>Interactive app provided by {serverName}</span>
        </div>
        <p className="text-muted-foreground text-xs">
          This runs sandboxed code from the MCP server. It cannot access your session, files, or
          credentials. Render it?
        </p>
        <div>
          <button
            type="button"
            onClick={grant}
            className="bg-foreground text-background hover:bg-foreground/90 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
          >
            Render app
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="bg-muted/40 flex items-center justify-between border-b px-3 py-1.5">
        <div className="flex items-center gap-2 text-xs font-medium">
          <AppWindow className="text-muted-foreground size-3.5 shrink-0" />
          <span className="truncate">{title ?? `App · ${serverName}`}</span>
        </div>
        <button
          type="button"
          onClick={openFullscreen}
          title="Open in canvas"
          className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md p-1 transition-colors"
        >
          <Maximize2 className="size-3.5" />
        </button>
      </div>
      <McpAppFrame
        sessionId={sessionId}
        serverName={serverName}
        uri={uri}
        title={title}
        onRequestFullscreen={openFullscreen}
        className={INLINE_HEIGHT}
      />
    </div>
  );
}
