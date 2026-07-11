/**
 * Inline chat surface for an MCP App (SEP-1865). Rendered on a `tool_call` part
 * whose result carries a `ui://` App reference (spec `mcp-apps-host` §2.3).
 *
 * Gated by first-use, per-server render consent: interactive third-party HTML
 * runs sandboxed scripts, so the first App from a given server shows a consent
 * card before anything renders; the choice is remembered per server. Once
 * consented, the App renders inline with a "fullscreen" affordance that moves it
 * to the canvas and a "pop out" affordance that floats it in the always-on-top
 * PIP panel (DOR-297). Popping out keeps this inline block live, so closing the
 * panel is the exit — there is nothing to send back.
 *
 * @module features/mcp-apps/ui/McpAppBlock
 */
import { AppWindow, Maximize2, PictureInPicture2 } from 'lucide-react';
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
  const openPip = useAppStore((s) => s.openPip);

  const openFullscreen = () => {
    openCanvasDocument({ type: 'mcp_app', serverName, uri, title });
    setCanvasOpen(true);
  };

  const popOut = () => {
    // The panel header always needs a label; fall back to the same string the
    // inline header shows when the App declares no title.
    openPip({ kind: 'mcp_app', sessionId, serverName, uri, title: title ?? `App · ${serverName}` });
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
        <div className="flex items-center gap-1">
          {/* Below 768px the PIP host docks a bottom sheet instead of a floating
              window (DOR-299), so the affordance works on touch too. Canvas
              (maximize) still works everywhere. */}
          <button
            type="button"
            onClick={popOut}
            aria-label="Pop out into a floating window"
            title="Pop out"
            className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md p-1 transition-colors"
          >
            <PictureInPicture2 className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={openFullscreen}
            title="Open in canvas"
            className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md p-1 transition-colors"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>
      </div>
      <McpAppFrame
        sessionId={sessionId}
        serverName={serverName}
        uri={uri}
        title={title}
        onRequestFullscreen={openFullscreen}
        onRequestPip={popOut}
        className={INLINE_HEIGHT}
      />
    </div>
  );
}
