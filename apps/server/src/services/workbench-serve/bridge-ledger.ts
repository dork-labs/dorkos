/**
 * What DorkOS decided the last time it served each page into a frame: its two
 * frame scripts went in, or they did not and here is the stable reason
 * (DOR-3131).
 *
 * The decision is made on the server while the page is being served, and the
 * canvas cannot see it: a frame's response headers are invisible to its parent,
 * and a dev server preview is a different origin. So both serving paths write
 * their decision here, keyed by the PAGE rather than by the URL that carried
 * it, and two readers ask by naming the page the way they already know it:
 *
 * - the canvas, after the frame's `load`, through `POST /api/workbench/bridge`
 *   with the session `cwd` and file path, or the dev server's port and path;
 * - an agent, through `read_canvas_document` on a browser document, which knows
 *   the document's URL and the session's folder.
 *
 * A served file is keyed by its real path after the boundary check, exactly the
 * path the serve route opened. A preview is keyed by the dev server's own port
 * and the request's path, normalized the way a URL's `pathname` setter does on
 * both sides, so `/a b` and `/a%20b` are one page and the query is ignored.
 *
 * In memory and bounded: losing it on restart only turns an answer into
 * `unknown`, which the canvas shows as nothing at all.
 *
 * @module services/workbench-serve/bridge-ledger
 */
import path from 'node:path';
import type {
  FrameBridgeRefusal,
  WorkbenchBridgeStatusRequest,
  WorkbenchBridgeStatusResponse,
} from '@dorkos/shared/schemas';
import { validateBoundary } from '../../lib/boundary.js';
import { WORKBENCH } from '../../config/constants.js';

/** How many pages the ledger remembers, newest kept. */
const MAX_ENTRIES = 512;

/**
 * The longest key the ledger keeps. A preview path comes off the network, so
 * without this a page could pin megabytes of keys; a longer one is simply not
 * remembered, which the canvas shows as nothing at all.
 */
const MAX_KEY_CHARS = 2048;

/**
 * The loopback hosts a browser document's URL can name, mirrored from the
 * client's `classifyBrowserTarget` so a page an agent reads back is classified
 * the way the canvas framed it.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

/**
 * What an agent is told for each refusal: the cause, and what to change in the
 * page to fix it. Agent-facing, so it may name the HTML involved.
 */
export const FRAME_BRIDGE_AGENT_NOTES: Record<FrameBridgeRefusal, string> = {
  csp:
    'The page has a Content-Security-Policy (a response header or a <meta http-equiv> tag) ' +
    'that DorkOS will not add inline scripts under. Allow inline scripts in it, or remove it.',
  encoding:
    'The page is not UTF-8 (by its Content-Type charset, a <meta charset>, or its bytes). ' +
    'Save and serve it as UTF-8.',
  oversize: `The page is over ${WORKBENCH.PREVIEW_HTML_INJECT_MAX_BYTES / (1024 * 1024)} MB of HTML, past the size DorkOS adds its scripts to.`,
  'no-head':
    'The page has no explicit <head> start tag before its content. Add <head>…</head> ' +
    'before the body.',
  markup:
    'Something before or inside the <head> (or between </head> and the body) is markup ' +
    'DorkOS cannot place a script after safely: for example <noscript>, <template>, <svg>, ' +
    'an unclosed or self-closing tag, a duplicate <head>, or a <meta http-equiv> other than ' +
    'Content-Type or Content-Security-Policy. Move it into the body or remove it.',
  'fixed-source': 'DorkOS’s own scripts failed their self-check. This is a DorkOS bug.',
};

/** The page decisions both serving paths record, newest kept. */
export class FrameBridgeLedger {
  readonly #entries = new Map<string, FrameBridgeRefusal | null>();

  /**
   * Remember one serving decision, replacing the page's previous one.
   *
   * @param key - The page, from {@link servedFileKey} or {@link previewPageKey}; one
   *   longer than {@link MAX_KEY_CHARS} is not kept.
   * @param reason - The refusal, or `null` when the scripts went in.
   */
  record(key: string, reason: FrameBridgeRefusal | null): void {
    if (key.length > MAX_KEY_CHARS) return;
    this.#entries.delete(key);
    this.#entries.set(key, reason);
    if (this.#entries.size > MAX_ENTRIES) {
      this.#entries.delete(this.#entries.keys().next().value!);
    }
  }

  /**
   * The last decision recorded for a page.
   *
   * @param key - The page, or `null` when it could not be named.
   * @returns `added`, `refused` with its reason, or `unknown`.
   */
  status(key: string | null): WorkbenchBridgeStatusResponse {
    if (key === null || !this.#entries.has(key)) return { bridge: 'unknown' };
    const reason = this.#entries.get(key)!;
    return reason === null ? { bridge: 'added' } : { bridge: 'refused', reason };
  }

  /** Forget everything (tests). */
  clear(): void {
    this.#entries.clear();
  }
}

/** The process-wide ledger both serving paths write and both readers ask. */
export const frameBridgeLedger = new FrameBridgeLedger();

/**
 * The ledger key for a served file.
 *
 * @param resolved - The file's real path, after the boundary check.
 */
export function servedFileKey(resolved: string): string {
  return `file:${resolved}`;
}

/**
 * The ledger key for a dev server page.
 *
 * Normalized by SETTING a URL's pathname, which is how the client builds the
 * frame's address (`splicePreviewPath`), so both sides agree on encoding. Never
 * by resolving the path against a base: a path that begins with `//` would read
 * as a host.
 *
 * @param targetPort - The dev server's own port.
 * @param rawPath - A request path, with or without a query.
 */
export function previewPageKey(targetPort: number, rawPath: string): string {
  const url = new URL('http://localhost');
  const queryAt = rawPath.indexOf('?');
  url.pathname = (queryAt === -1 ? rawPath : rawPath.slice(0, queryAt)) || '/';
  return `preview:${targetPort}:${url.pathname}`;
}

/**
 * Name a page the way the serving path recorded it.
 *
 * A served file goes through the same two boundary checks the sign and serve
 * routes run, so a path outside the session's folder names nothing.
 *
 * @param target - The file under a folder, or the dev server port and path.
 * @returns The ledger key, or `null` when the page cannot be named.
 */
export async function bridgeKeyFor(target: WorkbenchBridgeStatusRequest): Promise<string | null> {
  if (target.kind === 'proxy') return previewPageKey(target.port, target.path);
  try {
    const cwd = await validateBoundary(target.cwd);
    const abs = path.isAbsolute(target.path)
      ? path.resolve(target.path)
      : path.join(cwd, target.path);
    return servedFileKey(await validateBoundary(abs, cwd));
  } catch {
    return null;
  }
}

/**
 * The page a browser document's URL points at, classified the way the canvas
 * frames it: a loopback http(s) URL is a dev server, a `file:` URL or a bare
 * path is a file under `cwd`, and anything else is not a page DorkOS serves.
 *
 * @param url - The browser document's URL.
 * @param cwd - The folder a file path resolves against, or `null`.
 * @returns The page, or `null`.
 */
export function bridgeTargetForUrl(
  url: string,
  cwd: string | null
): WorkbenchBridgeStatusRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return cwd && url ? { kind: 'serve', cwd, path: url } : null;
  }
  if (parsed.protocol === 'file:') {
    try {
      return cwd ? { kind: 'serve', cwd, path: decodeURIComponent(parsed.pathname) } : null;
    } catch {
      return null;
    }
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith('.localhost');
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !loopback) return null;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  return { kind: 'proxy', port, path: `${parsed.pathname}${parsed.search}` };
}
