/**
 * Sandbox posture helpers for MCP App iframes (spec `mcp-apps-host` §2.4, D6).
 *
 * v1 renders App HTML via a `srcdoc` iframe with `sandbox="allow-scripts"` and
 * **never** `allow-same-origin` — the frame gets an opaque (`"null"`) origin, so
 * a dedicated origin server is unnecessary and the identical posture holds in
 * Vite dev, the production static bundle, and Electron. Defense-in-depth CSP is
 * injected into the document as a `<meta http-equiv>` tag (the App HTML is ours
 * to wrap before it reaches the frame). The `allow` attribute is derived
 * strictly from the App's declared permissions — nothing is granted by default.
 *
 * @module features/mcp-apps/lib/sandbox
 */
import type { McpAppPermission } from '@dorkos/shared/schemas';

/**
 * The one sandbox token every MCP App frame gets — scripts, nothing else.
 * `allow-same-origin` is intentionally absent so the frame cannot reach host
 * cookies, storage, or the parent DOM.
 */
export const MCP_APP_SANDBOX = 'allow-scripts';

/**
 * The opaque origin a strict-sandbox `srcdoc` frame reports. The bridge checks
 * inbound `event.origin` against this.
 */
export const SANDBOX_ORIGIN = 'null';

/**
 * Spec-default Content-Security-Policy when the App declares none. Locks the
 * frame to its own inline resources — no network, no framing, no external code.
 */
export const DEFAULT_MCP_APP_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'";

/** Map an MCP App permission to its iframe `allow`-attribute directive. */
const PERMISSION_TO_ALLOW: Record<McpAppPermission, string> = {
  camera: 'camera',
  microphone: 'microphone',
  geolocation: 'geolocation',
  'clipboard-write': 'clipboard-write',
};

/**
 * Build the iframe `allow` attribute from an App's declared permissions.
 * Restricts each directive to the frame itself (`'self'`) and returns undefined
 * when the App declared nothing, so the attribute is omitted entirely.
 *
 * @param permissions - Permissions the App declared (already validated server-side).
 * @returns The `allow` attribute value, or undefined when no permissions apply.
 */
export function buildAllowAttribute(permissions: McpAppPermission[]): string | undefined {
  if (permissions.length === 0) return undefined;
  return permissions.map((p) => `${PERMISSION_TO_ALLOW[p]} 'self'`).join('; ');
}

/**
 * Wrap App HTML into a `srcdoc` document with the effective CSP injected as the
 * first `<head>` child so the browser enforces it before any App script runs.
 *
 * @param html - The App's HTML body as fetched from the resource endpoint.
 * @param csp - The App-declared CSP, or undefined to use {@link DEFAULT_MCP_APP_CSP}.
 * @returns A complete HTML document string for the iframe `srcdoc`.
 */
export function buildSandboxSrcDoc(html: string, csp: string | undefined): string {
  const policy = csp && csp.trim().length > 0 ? csp : DEFAULT_MCP_APP_CSP;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`;

  // If the App shipped a full document, inject the CSP meta right after <head>
  // (or after <html>, or at the very top) so it is the first policy the parser
  // sees. Otherwise wrap the fragment in a minimal document.
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
  }
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

/** Escape a string for safe inclusion in a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
