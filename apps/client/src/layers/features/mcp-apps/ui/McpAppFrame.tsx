/**
 * Sandboxed renderer for a `ui://` MCP App resource (spec `mcp-apps-host` §2.3,
 * §2.4). Fetches the App HTML via the resource endpoint, frames it in a
 * strict-sandbox `srcdoc` iframe (scripts only, opaque origin), and wires the
 * postMessage JSON-RPC bridge. App link-opens route through the shared
 * {@link LinkSafetyModal}; fullscreen and pip display-mode requests are
 * forwarded to the host.
 *
 * @module features/mcp-apps/ui/McpAppFrame
 */
import type { McpAppDocHost } from '../model/doc-extension';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LinkSafetyModal, MoreDetails } from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { cn, openExternalLink } from '@/layers/shared/lib';
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
  /** Called when the App requests `pip` — the host pops it into the floating panel. */
  onRequestPip?: () => void;
  /** Extra classes for the frame wrapper. */
  className?: string;
  /** Actual hosting Doc permission; never supplied by the framed App. */
  docHost?: McpAppDocHost;
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
  onRequestPip,
  className,
  docHost,
}: McpAppFrameProps) {
  const transport = useTransport();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useMcpAppResource({ sessionId, serverName, uri });

  // Computed each render; the React Compiler memoizes these for us.
  const srcDoc = data?.text ? buildSandboxSrcDoc(data.text, data.csp) : undefined;
  const allow = buildAllowAttribute(data?.permissions ?? []);

  // Capture the exact resource server/session/Transport in this mounted bridge.
  const readResource = useCallback(
    async (readUri: string) => {
      const res = await transport.fetchMcpAppResource(sessionId, { serverName, uri: readUri });
      return { mimeType: res.mimeType, text: res.text, blob: res.blob };
    },
    [transport, sessionId, serverName]
  );

  const displayHandlers = useRef({ onRequestFullscreen, onRequestPip });
  useLayoutEffect(() => {
    displayHandlers.current = { onRequestFullscreen, onRequestPip };
  }, [onRequestFullscreen, onRequestPip]);
  const requestDisplayMode = useCallback((mode: McpAppDisplayMode) => {
    if (mode === 'fullscreen') displayHandlers.current.onRequestFullscreen?.();
    else if (mode === 'pip') displayHandlers.current.onRequestPip?.();
  }, []);

  // A new original resource/permission gets a genuinely new iframe, including same-HTML
  // replacement. Ordinary reducer updates preserve the cached host and mounted document.
  const [mount, setMount] = useState<{
    epoch: number;
    srcDoc: string;
    docHost: McpAppDocHost | undefined;
    readResource: typeof readResource;
  } | null>(null);
  const [attachedDoc, setAttachedDoc] = useState<{ epoch: number; srcDoc: string } | null>(null);
  useEffect(() => {
    if (!srcDoc) return;
    setMount((previous) =>
      previous &&
      previous.srcDoc === srcDoc &&
      previous.docHost === docHost &&
      previous.readResource === readResource
        ? previous
        : {
            epoch: (previous?.epoch ?? 0) + 1,
            srcDoc,
            docHost,
            readResource,
          }
    );
  }, [srcDoc, docHost, readResource]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (
      !iframe ||
      !mount ||
      mount.srcDoc !== srcDoc ||
      mount.docHost !== docHost ||
      mount.readResource !== readResource
    )
      return;
    const dispose = createMcpAppBridge({
      iframe,
      expectedOrigin: SANDBOX_ORIGIN,
      docHost,
      hostContext: { hostName: 'DorkOS', theme: currentTheme() },
      handlers: { readResource, openLink: (url) => setPendingLink(url), requestDisplayMode },
    });
    setAttachedDoc({ epoch: mount.epoch, srcDoc: mount.srcDoc });
    return dispose;
  }, [mount, srcDoc, docHost, readResource, requestDisplayMode]);

  if (isLoading) {
    return <div className={cn('text-muted-foreground p-4 text-sm', className)}>Loading app…</div>;
  }

  if (isError || !srcDoc) {
    return (
      <div className={cn('text-muted-foreground p-4 text-sm', className)}>
        <p>
          {isError ? `Couldn’t load the app from ${serverName}.` : 'This app has nothing to show.'}
        </p>
        {/* The server's own words, kept for anyone debugging, behind a toggle. */}
        {isError && error instanceof Error && error.message && (
          <MoreDetails label="Details" openLabel="Hide details" className="mt-1">
            <p className="font-mono text-xs break-words">{error.message}</p>
          </MoreDetails>
        )}
      </div>
    );
  }

  return (
    <div className={cn('relative h-full w-full', className)}>
      <iframe
        key={mount?.epoch ?? 0}
        ref={iframeRef}
        title={title ?? `App from ${serverName}`}
        sandbox={MCP_APP_SANDBOX}
        // `allow` is omitted entirely unless the App declared permissions.
        {...(allow ? { allow } : {})}
        // Loads only after the bridge listener is attached (see attachedDoc).
        srcDoc={attachedDoc?.epoch === mount?.epoch ? attachedDoc?.srcDoc : undefined}
        className="bg-background h-full w-full border-0"
      />
      <LinkSafetyModal
        url={pendingLink ?? ''}
        isOpen={pendingLink !== null}
        onClose={() => setPendingLink(null)}
        onConfirm={() => {
          // Always leaves the app — see the LinkSafetyModal contract. An App
          // can name any URL, including one of our own routes.
          if (pendingLink) openExternalLink(pendingLink);
          setPendingLink(null);
        }}
      />
    </div>
  );
}
