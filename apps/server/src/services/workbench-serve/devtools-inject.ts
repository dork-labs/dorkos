/**
 * Inject the DevTools capture shim into a served/proxied HTML document (DOR-213).
 *
 * The `<script>` is inserted **inline** (not `<script src>`, which the opaque
 * frame would fetch cross-origin and which CSP `script-src` blocks more often) as
 * the **first `<head>` child**, so its hooks install before any page script runs.
 * Insertion mirrors `mcp-apps/lib/sandbox.ts` `buildSandboxSrcDoc`, with one
 * deliberate difference: a served file is a whole document (it may already carry
 * a doctype/body), never an App fragment, so the head-less fallback prepends the
 * script rather than wrapping the content in a fresh `<html>` shell — wrapping
 * would nest a second doctype and corrupt the page.
 *
 * A page whose own CSP forbids inline scripts simply refuses ours and is not
 * instrumented — a real, disclosed limitation, never worked around by weakening
 * the page's CSP.
 *
 * @module services/workbench-serve/devtools-inject
 */
import { DEVTOOLS_AGENT_SCRIPT } from './devtools-shim.js';

export { DEVTOOLS_AGENT_SCRIPT } from './devtools-shim.js';

/** The inline `<script>` tag carrying the shim, built once at module load. */
const SCRIPT_TAG = `<script>${DEVTOOLS_AGENT_SCRIPT}</script>`;

/** Match a leading doctype declaration (with optional BOM/whitespace before it). */
const LEADING_DOCTYPE = /^(\uFEFF?\s*<!doctype[^>]*>)/i;

/**
 * Insert the capture shim as the first `<head>` child of an HTML document.
 *
 * - Has `<head …>` → inject immediately after the opening head tag.
 * - Else has `<html …>` → inject a `<head>` (containing the script) after it.
 * - Else (fragment / head-less / doctype-only) → prepend the script, after a
 *   leading doctype when present, so it is still the first thing the parser runs.
 *
 * @param html - The document's HTML as a string.
 * @returns The HTML with the shim `<script>` inserted.
 */
export function injectDevtoolsScript(html: string): string {
  const headOpen = /<head[^>]*>/i;
  if (headOpen.test(html)) {
    return html.replace(headOpen, (m) => `${m}${SCRIPT_TAG}`);
  }
  const htmlOpen = /<html[^>]*>/i;
  if (htmlOpen.test(html)) {
    return html.replace(htmlOpen, (m) => `${m}<head>${SCRIPT_TAG}</head>`);
  }
  const doctype = LEADING_DOCTYPE.exec(html);
  if (doctype) {
    return `${doctype[1]}${SCRIPT_TAG}${html.slice(doctype[1].length)}`;
  }
  return `${SCRIPT_TAG}${html}`;
}
