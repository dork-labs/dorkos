/**
 * postMessage JSON-RPC bridge between a sandboxed MCP App iframe and the DorkOS
 * host (MCP Apps / SEP-1865, spec `mcp-apps-host` §2.3).
 *
 * The App runs in an iframe with `sandbox="allow-scripts"` and **no**
 * `allow-same-origin`, so its origin is the opaque string `"null"` and it can
 * only reach the host via `postMessage`. This module is the host end of that
 * channel: it validates every inbound message (source window + origin), answers
 * the small allowlisted set of methods, and refuses everything else. It is
 * deliberately framework-agnostic (no React) so it can be unit-tested directly.
 *
 * v1 is render-only: `resources/read` is proxied, `ui/open-link` and
 * `ui/request-display-mode` are surfaced to the host, and `tools/call` is
 * explicitly refused (D4). Unknown methods get JSON-RPC method-not-found.
 *
 * @module features/mcp-apps/model/bridge
 */

/** JSON-RPC 2.0 method-not-found error code. */
const METHOD_NOT_FOUND = -32601;
/** Application error code for host-refused operations (tools/call in v1). */
const APP_NOT_PERMITTED = -32000;

/** Display modes the host advertises during the handshake (D5). `pip` is deferred. */
export const ADVERTISED_DISPLAY_MODES = ['inline', 'fullscreen'] as const;

/** A display mode an App may request. */
export type McpAppDisplayMode = 'inline' | 'fullscreen' | 'pip';

/** Minimal JSON-RPC request shape we accept from an App. */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

/** Host-side handlers the bridge calls out to. All are host-owned policy. */
export interface McpAppBridgeHandlers {
  /** Read a `ui://` resource (proxied to the DorkOS endpoint). */
  readResource: (uri: string) => Promise<{ mimeType: string; text?: string; blob?: string }>;
  /** Surface an App link-open request (host routes it through LinkSafetyModal). */
  openLink: (url: string) => void;
  /** Surface an App display-mode request (host moves fullscreen → canvas). */
  requestDisplayMode: (mode: McpAppDisplayMode) => void;
}

/** Static host context handed to the App at initialize. */
export interface McpAppHostContext {
  /** Host application name. */
  hostName: string;
  /** The theme the App should render for. */
  theme: 'light' | 'dark';
}

export interface McpAppBridgeOptions {
  /** The iframe the App runs in — its `contentWindow` is the only trusted source. */
  iframe: HTMLIFrameElement;
  /**
   * The origin inbound messages must carry. For a `srcdoc`/strict-sandbox frame
   * this is the opaque origin string `"null"`; a real dedicated origin would
   * pass its origin here instead.
   */
  expectedOrigin: string;
  /** Host context advertised at initialize. */
  hostContext: McpAppHostContext;
  /** Host-owned handlers. */
  handlers: McpAppBridgeHandlers;
}

/**
 * Wire a host-side MCP App bridge to a sandboxed iframe. Returns a disposer that
 * removes the message listener. Attach it once the iframe exists; call the
 * disposer on unmount.
 *
 * @param options - The iframe, its expected origin, host context, and handlers.
 * @returns A cleanup function that detaches the `message` listener.
 */
export function createMcpAppBridge(options: McpAppBridgeOptions): () => void {
  const { iframe, expectedOrigin, hostContext, handlers } = options;

  const post = (message: unknown): void => {
    // Target origin is '*' because a strict-sandbox frame has an opaque ("null")
    // origin that cannot be named; the source-window check on inbound is what
    // secures the channel, and outbound only reaches this specific frame.
    iframe.contentWindow?.postMessage(message, '*');
  };

  const respond = (id: JsonRpcRequest['id'], result: unknown): void => {
    if (id === undefined || id === null) return; // notification — no reply
    post({ jsonrpc: '2.0', id, result });
  };

  const respondError = (id: JsonRpcRequest['id'], code: number, message: string): void => {
    if (id === undefined || id === null) return;
    post({ jsonrpc: '2.0', id, error: { code, message } });
  };

  const handleRequest = async (req: JsonRpcRequest): Promise<void> => {
    switch (req.method) {
      case 'ui/initialize': {
        respond(req.id, {
          availableDisplayModes: [...ADVERTISED_DISPLAY_MODES],
          hostContext,
        });
        return;
      }
      case 'resources/read': {
        const uri = readUriParam(req.params);
        if (!uri) return respondError(req.id, METHOD_NOT_FOUND, 'resources/read requires a uri');
        try {
          const resource = await handlers.readResource(uri);
          respond(req.id, { contents: [{ uri, ...resource }] });
        } catch (err) {
          respondError(
            req.id,
            APP_NOT_PERMITTED,
            err instanceof Error ? err.message : 'read failed'
          );
        }
        return;
      }
      case 'ui/open-link': {
        const url = readUrlParam(req.params);
        if (url) handlers.openLink(url);
        respond(req.id, {});
        return;
      }
      case 'ui/request-display-mode': {
        const mode = readModeParam(req.params);
        if (mode) handlers.requestDisplayMode(mode);
        respond(req.id, { granted: mode === 'fullscreen' || mode === 'inline' });
        return;
      }
      case 'tools/call': {
        // v1 is render-only (D4): app-initiated tool calls are never executed.
        respondError(
          req.id,
          APP_NOT_PERMITTED,
          'App tool calls are not permitted in this host (v1)'
        );
        return;
      }
      default: {
        respondError(req.id, METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
        return;
      }
    }
  };

  const onMessage = (event: MessageEvent): void => {
    // Source-window check first: only this iframe's window may talk to us. This
    // is the primary guard for a strict-sandbox ("null" origin) frame.
    if (event.source !== iframe.contentWindow) return;
    // Origin check: reject anything not from the frame's expected (opaque) origin.
    if (event.origin !== expectedOrigin) return;
    const req = parseRequest(event.data);
    if (!req) return;
    void handleRequest(req);
  };

  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/** Narrow untrusted `event.data` to a JSON-RPC request, or null. */
function parseRequest(data: unknown): JsonRpcRequest | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.jsonrpc !== '2.0' || typeof d.method !== 'string') return null;
  return {
    jsonrpc: '2.0',
    method: d.method,
    id: d.id as JsonRpcRequest['id'],
    params: d.params,
  };
}

/** Extract a `uri` string from JSON-RPC params. */
function readUriParam(params: unknown): string | undefined {
  const uri = (params as { uri?: unknown } | undefined)?.uri;
  return typeof uri === 'string' ? uri : undefined;
}

/** Extract a `url` string from JSON-RPC params. */
function readUrlParam(params: unknown): string | undefined {
  const url = (params as { url?: unknown } | undefined)?.url;
  return typeof url === 'string' ? url : undefined;
}

/** Extract a display `mode` from JSON-RPC params. */
function readModeParam(params: unknown): McpAppDisplayMode | undefined {
  const mode = (params as { mode?: unknown } | undefined)?.mode;
  return mode === 'inline' || mode === 'fullscreen' || mode === 'pip' ? mode : undefined;
}
