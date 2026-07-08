/**
 * Sandboxed renderer for a `ui://` MCP App resource (spec `mcp-apps-host` §2.3,
 * §2.4). Fetches the App HTML via the resource endpoint, frames it in a
 * strict-sandbox `srcdoc` iframe (scripts only, opaque origin), and wires the
 * postMessage JSON-RPC bridge. App link-opens route through the shared
 * {@link LinkSafetyModal}; a fullscreen request is forwarded to the host.
 *
 * @module features/mcp-apps/ui/McpAppFrame
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { LinkSafetyModal } from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { useMcpAppResource } from '../model/use-mcp-app-resource';
import {
  createMcpAppBridge,
  type McpAppDisplayMode,
  type McpAppHostContext,
} from '../model/bridge';
import {
  MCP_APP_SANDBOX,
  SANDBOX_ORIGIN,
  buildAllowAttribute,
  buildSandboxSrcDoc,
} from '../lib/sandbox';

export interface McpAppFrameProps {
  /** Session that owns the MCP server (scopes the server-side fetch). */
  sessionId: string;
  /** MCP server that ships the App. */
  serverName: string;
  /** The `ui://` resource URI to render. */
  uri: string;
  /** Optional title (used for the iframe accessible name). */
  title?: string;
  /** Called when the App requests fullscreen — the host moves it to the canvas. */
  onRequestFullscreen?: () => void;
  /** Extra classes for the frame wrapper. */
  className?: string;
}

/** The effective (applied) theme, read from the document root. */
function currentTheme(): McpAppHostContext['theme'] {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * Render an MCP App in a sandboxed iframe with the host bridge attached.
 *
 * @param props - Session/server/URI to render plus optional fullscreen handler.
 */
export function McpAppFrame({
  sessionId,
  serverName,
  uri,
  title,
  onRequestFullscreen,
  className,
}: McpAppFrameProps) {
  const transport = useTransport();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useMcpAppResource({ sessionId, serverName, uri });

  // Computed each render; the React Compiler memoizes these for us.
  const srcDoc = data?.text ? buildSandboxSrcDoc(data.text, data.csp) : undefined;
  const allow = buildAllowAttribute(data?.permissions ?? []);

  // Proxy an App's resources/read to the same server via the endpoint. Kept in a
  // ref so the bridge (attached once per srcdoc) always calls the latest closure.
  const readResource = useCallback(
    async (readUri: string) => {
      const res = await transport.fetchMcpAppResource(sessionId, { serverName, uri: readUri });
      return { mimeType: res.mimeType, text: res.text, blob: res.blob };
    },
    [transport, sessionId, serverName]
  );

  const requestDisplayMode = useCallback(
    (mode: McpAppDisplayMode) => {
      if (mode === 'fullscreen') onRequestFullscreen?.();
    },
    [onRequestFullscreen]
  );

  // Attach the bridge once the srcdoc is set. Re-attach if the document changes.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !srcDoc) return;
    const dispose = createMcpAppBridge({
      iframe,
      expectedOrigin: SANDBOX_ORIGIN,
      hostContext: { hostName: 'DorkOS', theme: currentTheme() },
      handlers: {
        readResource,
        openLink: (url) => setPendingLink(url),
        requestDisplayMode,
      },
    });
    return dispose;
  }, [srcDoc, readResource, requestDisplayMode]);

  if (isLoading) {
    return <div className={cn('text-muted-foreground p-4 text-sm', className)}>Loading app…</div>;
  }

  if (isError || !srcDoc) {
    return (
      <div className={cn('text-muted-foreground p-4 text-sm', className)}>
        {isError
          ? `Could not load app from ${serverName}: ${error instanceof Error ? error.message : 'unknown error'}`
          : `This app returned no renderable content.`}
      </div>
    );
  }

  return (
    <div className={cn('relative h-full w-full', className)}>
      <iframe
        ref={iframeRef}
        title={title ?? `MCP App from ${serverName}`}
        sandbox={MCP_APP_SANDBOX}
        // `allow` is omitted entirely unless the App declared permissions.
        {...(allow ? { allow } : {})}
        srcDoc={srcDoc}
        className="h-full w-full border-0 bg-white"
      />
      <LinkSafetyModal
        url={pendingLink ?? ''}
        isOpen={pendingLink !== null}
        onClose={() => setPendingLink(null)}
        onConfirm={() => {
          if (pendingLink) window.open(pendingLink, '_blank', 'noopener,noreferrer');
          setPendingLink(null);
        }}
      />
    </div>
  );
}
