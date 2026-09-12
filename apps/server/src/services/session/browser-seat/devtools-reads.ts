/**
 * The agent's eyes on the preview it already opened (DOR-213): the console, the
 * network log, and a picture of what is on screen right now.
 *
 * `browser_read_console` and `browser_read_network` read the per-session capture
 * buffer the in-page shim feeds through `POST /api/sessions/:id/devtools/ingest`.
 * `browser_screenshot` adds the rendered pixels through an on-demand round trip:
 * it puts a `devtools_capture_request` on the session's stream, the window
 * forwards it into the preview frame, the shim rasterizes its own document, and
 * the PNG returns through the normal ingest path tagged with the `requestId`.
 * Together with `browser_navigate` and the six driving verbs, these close the
 * loop that makes an agent trustworthy at frontend work: edit → preview → read
 * its own console errors, failed requests, and rendered layout → fix, without a
 * person relaying "it's throwing a TypeError."
 *
 * These tools only READ the store; they never touch the page or the injection
 * path.
 *
 * ## Every runtime, one implementation
 *
 * They used to be hand-registered on claude-code's in-process MCP server and
 * bound to its live session object, which is why a Codex or OpenCode member of a
 * room could not see a console error and a Claude Code member could. They are
 * `ui` capabilities now, and the only thing they need is the calling session's
 * id — which every surface derives from its own verified context rather than
 * taking from an argument.
 *
 * RESULT SIZE is bounded three ways so a chatty preview can never blow up the
 * agent's context window: a per-call entry count (`limit`, default 50), a
 * per-entry field cap (long `text`/`stack`/`args` are elided with an explicit
 * marker), and a total serialized budget per result (newest entries win).
 *
 * @module services/session/browser-seat/devtools-reads
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DevtoolsConsoleEntry, DevtoolsNetworkEntry } from '@dorkos/shared/schemas';
import { WORKBENCH } from '../../../config/constants.js';
import { CapabilityImageResult, CapabilityToolError } from '../../core/capabilities/index.js';
import type { CaptureBufferView, DevtoolsCaptureStore } from '../devtools-capture-store.js';
import type { RawSessionEvent } from '../session-state-projector.js';
import { NO_PREVIEW_NOTE } from './act-protocol.js';
import { emitToSession } from './session-reach.js';

/** Default number of entries a read returns when the caller gives no `limit`. */
const DEFAULT_READ_LIMIT = 50;

/**
 * Total serialized budget (JSON chars) for one read result's entry list. The
 * count `limit` alone cannot bound the payload — 50 max-size console entries
 * would serialize to megabytes — so after per-entry elision, entries are kept
 * newest-first until the budget is spent and the rest are dropped (reported via
 * `truncated` + `note`). ~64 KB keeps even a worst-case result a small fraction
 * of a context window.
 */
const RESULT_BUDGET_CHARS = 65_536;

/**
 * Per-field elision cap (chars) for one console entry's rendered `text`,
 * `stack`, and serialized `args`. A single 20 KB logged blob is almost never
 * what the agent needs; the head plus an explicit `… [truncated N chars]`
 * marker is, and it keeps entries small enough that the result budget buys
 * many of them.
 */
const FIELD_ELIDE_CHARS = 2_048;

/** The subset of {@link DevtoolsCaptureStore} these verbs depend on. */
export type DevtoolsReadStore = Pick<
  DevtoolsCaptureStore,
  'read' | 'awaitScreenshot' | 'resolveDriver'
>;

/**
 * What a caller is told when no session can be resolved.
 *
 * A surface with no interactive client must not pretend to succeed — there is
 * no session whose preview buffer could be read or asked for a screenshot.
 */
const SESSIONLESS_DEVTOOLS_ERROR = {
  error:
    'browser_read_console, browser_read_network, and browser_screenshot require an attached interactive session',
  detail:
    'These tools read the console/network/screenshot the current session captured from its live ' +
    'preview. The current surface has no session attached, so there is no preview to reach.',
};

/** Build the `limit` input for one tool, capped at that tool's server ring size. */
function limitInput(max: number) {
  return z
    .number()
    .int()
    .positive()
    .max(max)
    .optional()
    .describe(`Max entries to return, newest first (default ${DEFAULT_READ_LIMIT}, max ${max}).`);
}

/** Input shape for `browser_read_console`. */
export const READ_CONSOLE_INPUT = {
  level: z
    .enum(['all', 'error', 'warn', 'info', 'log', 'debug'])
    .optional()
    .describe('Filter by console level (default "all"). Uncaught errors are captured at "error".'),
  limit: limitInput(WORKBENCH.DEVTOOLS_CONSOLE_BUFFER),
};

/** Input shape for `browser_read_network`. */
export const READ_NETWORK_INPUT = {
  status: z
    .enum(['all', 'failed', '2xx', '3xx', '4xx', '5xx'])
    .optional()
    .describe(
      'Filter by outcome (default "all"). "failed" = network errors (status 0) plus 4xx/5xx ' +
        'responses — redirects (3xx) are not failures; "2xx"/"3xx"/"4xx"/"5xx" filter by status class.'
    ),
  limit: limitInput(WORKBENCH.DEVTOOLS_NETWORK_BUFFER),
};

/** `browser_read_console` arguments, as the handler receives them. */
export type ReadConsoleInput = z.infer<z.ZodObject<typeof READ_CONSOLE_INPUT>>;

/** `browser_read_network` arguments, as the handler receives them. */
export type ReadNetworkInput = z.infer<z.ZodObject<typeof READ_NETWORK_INPUT>>;

/** Elide a string past {@link FIELD_ELIDE_CHARS} with an explicit marker. */
function elideString(value: string): string {
  if (value.length <= FIELD_ELIDE_CHARS) return value;
  const omitted = value.length - FIELD_ELIDE_CHARS;
  return `${value.slice(0, FIELD_ELIDE_CHARS)}… [truncated ${omitted} chars]`;
}

/**
 * Bound one console entry's big fields (`text`, `stack`, serialized `args`) so
 * a single giant logged blob cannot dominate the result budget. Elision is
 * always marked — the agent knows content was cut and by how much.
 */
function elideConsoleEntry(entry: DevtoolsConsoleEntry): DevtoolsConsoleEntry {
  const out: DevtoolsConsoleEntry = { ...entry, text: elideString(entry.text) };
  if (out.stack !== undefined) out.stack = elideString(out.stack);
  if (out.args !== undefined) {
    let argChars: number;
    try {
      argChars = JSON.stringify(out.args)?.length ?? 0;
    } catch {
      argChars = Infinity; // unserializable — always elide
    }
    if (argChars > FIELD_ELIDE_CHARS) {
      out.args = [`… [args elided: ${argChars} chars; see "text" for the rendered form]`];
    }
  }
  return out;
}

/**
 * Keep the newest entries whose combined serialized size fits the result
 * budget. Returns the kept page (oldest-first, as captured) plus how many
 * candidates were dropped for size. Always keeps at least the newest entry so
 * a single over-budget entry still yields a result.
 *
 * @param entries - Filter- and limit-applied candidates, oldest-first.
 */
function fitBudget<T>(entries: T[]): { page: T[]; droppedForSize: number } {
  let spent = 0;
  const kept: T[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const size = JSON.stringify(entries[i])?.length ?? 0;
    if (kept.length > 0 && spent + size > RESULT_BUDGET_CHARS) break;
    spent += size;
    kept.unshift(entries[i]);
  }
  return { page: kept, droppedForSize: entries.length - kept.length };
}

/** Take the newest `limit` entries; returns `{ page, omitted }`. */
function tail<T>(entries: T[], limit: number): { page: T[]; omitted: number } {
  if (entries.length <= limit) return { page: entries, omitted: 0 };
  return { page: entries.slice(entries.length - limit), omitted: entries.length - limit };
}

/**
 * Keep only network entries matching a status filter. `failed` is deliberately
 * status-based (a network error, i.e. status 0, or a 4xx/5xx response) rather
 * than `!ok`, so classification is identical for fetch and XHR captures and
 * redirects never count as failures.
 */
function matchesNetworkStatus(
  entry: DevtoolsNetworkEntry,
  status: ReadNetworkInput['status']
): boolean {
  switch (status) {
    case undefined:
    case 'all':
      return true;
    case 'failed':
      return entry.status === 0 || entry.status >= 400;
    case '2xx':
      return entry.status >= 200 && entry.status < 300;
    case '3xx':
      return entry.status >= 300 && entry.status < 400;
    case '4xx':
      return entry.status >= 400 && entry.status < 500;
    case '5xx':
      return entry.status >= 500 && entry.status < 600;
  }
}

/** Header fields every read result carries so the agent can judge freshness. */
function bufferHeader(buffer: CaptureBufferView | undefined) {
  return {
    documentUrl: buffer?.logicalUrl,
    capturedAt: buffer?.updatedAt,
  };
}

/**
 * Build the `note` for an empty result. Distinguishes three cases the agent
 * must react to differently: no preview open at all (open one), preview
 * connected but silent (a clean signal), and entries present but none matching
 * the filter (loosen the filter — do NOT conclude the page is silent).
 */
function emptyNote(
  buffer: CaptureBufferView | undefined,
  signal: 'console' | 'network',
  ringTotal: number,
  filterLabel?: string
): string {
  if (!buffer) return NO_PREVIEW_NOTE;
  if (ringTotal > 0 && filterLabel) {
    return signal === 'console'
      ? `No console entries at level "${filterLabel}" (${ringTotal} ${ringTotal === 1 ? 'entry' : 'entries'} at other levels — read with level "all" to see them).`
      : `No requests matching status "${filterLabel}" (${ringTotal} captured ${ringTotal === 1 ? 'request' : 'requests'} in total — read with status "all" to see them).`;
  }
  const where = buffer.logicalUrl ? ` (${buffer.logicalUrl})` : '';
  return signal === 'console'
    ? `The preview${where} is connected but has logged nothing yet — a clean console, or the page hasn't run the code that logs.`
    : `The preview${where} is connected but has made no captured requests yet.`;
}

/** Compose the truncation note from the three independent drop causes. */
function truncationNote(
  shown: number,
  matched: number,
  omittedByLimit: number,
  droppedForSize: number,
  ringEvicted: boolean,
  noun: string
): string | undefined {
  if (omittedByLimit === 0 && droppedForSize === 0 && !ringEvicted) return undefined;
  const parts: string[] = [];
  if (omittedByLimit > 0 || droppedForSize > 0) {
    parts.push(
      `showing the ${shown} most recent of ${matched} matching ${noun}` +
        (droppedForSize > 0
          ? ` (${droppedForSize} dropped to keep this result under its size budget)`
          : ' (raise `limit` to see more)')
    );
  }
  if (ringEvicted) {
    parts.push(`the server buffer overflowed earlier, so the oldest ${noun} were already dropped`);
  }
  const joined = parts.join('; ');
  return joined.charAt(0).toUpperCase() + joined.slice(1) + '.';
}

/** The calling session, or a refusal that says why there is nothing to read. */
function requireSession(sessionId: string | undefined): string {
  if (sessionId === undefined) throw new CapabilityToolError(SESSIONLESS_DEVTOOLS_ERROR);
  return sessionId;
}

/**
 * Read the calling session's captured console output.
 *
 * Filters by `level`, keeps the newest `limit` entries, elides oversized fields,
 * and fits the result to the serialized budget. `truncated` is true whenever
 * anything the filter matched is not in the result — by `limit`, by the size
 * budget, or because the server ring already evicted entries.
 *
 * @param input - The validated arguments.
 * @param sessionId - The calling session, from the verified context.
 * @param store - The capture store to read from (injectable for tests).
 * @returns The entries, plus what was left out and why.
 * @throws {CapabilityToolError} When the surface carries no session.
 */
export async function readConsole(
  input: ReadConsoleInput,
  sessionId: string | undefined,
  store: DevtoolsReadStore
): Promise<Record<string, unknown>> {
  const session = requireSession(sessionId);
  const { level, limit } = input;

  const buffer = store.read(session);
  const all = buffer?.console ?? [];
  const filtered = level && level !== 'all' ? all.filter((e) => e.level === level) : all;

  if (filtered.length === 0) {
    return {
      ...bufferHeader(buffer),
      entries: [] as DevtoolsConsoleEntry[],
      truncated: false,
      note: emptyNote(buffer, 'console', all.length, level !== 'all' ? level : undefined),
    };
  }

  const { page: limited, omitted } = tail(filtered, limit ?? DEFAULT_READ_LIMIT);
  const { page, droppedForSize } = fitBudget(limited.map(elideConsoleEntry));
  const ringEvicted = buffer?.consoleEvicted ?? false;
  const truncated = omitted > 0 || droppedForSize > 0 || ringEvicted;
  return {
    ...bufferHeader(buffer),
    entries: page,
    truncated,
    ...(truncated && {
      note: truncationNote(
        page.length,
        filtered.length,
        omitted,
        droppedForSize,
        ringEvicted,
        'console entries'
      ),
    }),
  };
}

/**
 * Read the calling session's captured network requests.
 *
 * Filters by `status` class, keeps the newest `limit` requests, and fits the
 * result to the serialized budget. `truncated` semantics mirror
 * {@link readConsole}.
 *
 * @param input - The validated arguments.
 * @param sessionId - The calling session, from the verified context.
 * @param store - The capture store to read from (injectable for tests).
 * @returns The requests, plus what was left out and why.
 * @throws {CapabilityToolError} When the surface carries no session.
 */
export async function readNetwork(
  input: ReadNetworkInput,
  sessionId: string | undefined,
  store: DevtoolsReadStore
): Promise<Record<string, unknown>> {
  const session = requireSession(sessionId);
  const { status, limit } = input;

  const buffer = store.read(session);
  const all = buffer?.network ?? [];
  const filtered = all.filter((e) => matchesNetworkStatus(e, status));

  if (filtered.length === 0) {
    return {
      ...bufferHeader(buffer),
      requests: [] as DevtoolsNetworkEntry[],
      truncated: false,
      note: emptyNote(buffer, 'network', all.length, status !== 'all' ? status : undefined),
    };
  }

  const { page: limited, omitted } = tail(filtered, limit ?? DEFAULT_READ_LIMIT);
  const { page, droppedForSize } = fitBudget(limited);
  const ringEvicted = buffer?.networkEvicted ?? false;
  const truncated = omitted > 0 || droppedForSize > 0 || ringEvicted;
  return {
    ...bufferHeader(buffer),
    requests: page,
    truncated,
    ...(truncated && {
      note: truncationNote(
        page.length,
        filtered.length,
        omitted,
        droppedForSize,
        ringEvicted,
        'requests'
      ),
    }),
  };
}

/**
 * Magic-byte signatures for the screenshot mime whitelist. SVG is deliberately
 * absent — it is scriptable markup, not pixels, and has no magic bytes anyway.
 */
function magicBytesMatch(mimeType: string, bytes: Buffer): boolean {
  switch (mimeType) {
    case 'image/png':
      return (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 && // P
        bytes[2] === 0x4e && // N
        bytes[3] === 0x47 && // G
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif':
      return bytes.length >= 6 && bytes.toString('latin1', 0, 4) === 'GIF8';
    case 'image/webp':
      return (
        bytes.length >= 12 &&
        bytes.toString('latin1', 0, 4) === 'RIFF' &&
        bytes.toString('latin1', 8, 12) === 'WEBP'
      );
    default:
      return false;
  }
}

/**
 * Parse and validate an untrusted screenshot data URL into MCP image-block
 * parts, or `null` when anything about it is off. Three gates, because the
 * value originates inside the (untrusted) preview page: a raster-only mime
 * whitelist (png/jpeg/webp/gif — never `image/svg+xml`, which is scriptable
 * markup), a plausible-base64 payload, and decoded magic bytes matching the
 * claimed type. A hostile page may only ever lie to the agent with a wrong
 * picture — it must never produce an image block the model API rejects,
 * which would break the agent's turn.
 *
 * @param dataUrl - The `data:` URL relayed from the in-page shim.
 * @returns The mime type and base64 bytes, or `null` when it is not a picture.
 */
export function parseScreenshotDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return null;
  const mimeType = `image/${match[1]}`;
  const data = match[2];
  const bytes = Buffer.from(data, 'base64');
  if (!magicBytesMatch(mimeType, bytes)) return null;
  return { mimeType, data };
}

/**
 * Take a picture of whatever the calling session's preview is showing.
 *
 * Puts a `devtools_capture_request` on the session's stream — addressed to the
 * driver seat when there is one — and awaits the matching ingest. The window
 * forwards the request into the preview frame, the in-page shim rasterizes its
 * own document (the parent cannot canvas-read an opaque-origin frame), and the
 * PNG data URL returns through the normal ingest path tagged with the
 * `requestId`. Times out with a structured note — never a hang.
 *
 * @param sessionId - The calling session, from the verified context.
 * @param store - The capture store to await the round trip on.
 * @param timeoutMs - Round-trip timeout (injectable for tests).
 * @returns The picture beside its metadata, or a note saying why there is none.
 * @throws {CapabilityToolError} When the surface carries no session.
 */
export async function takeScreenshot(
  sessionId: string | undefined,
  store: DevtoolsReadStore,
  timeoutMs: number = WORKBENCH.DEVTOOLS_SCREENSHOT_TIMEOUT_MS
): Promise<unknown> {
  const session = requireSession(sessionId);

  // No capture buffer means no instrumented preview has ever connected —
  // waiting the full timeout would be pointless; tell the agent what to do.
  const buffer = store.read(session);
  if (!buffer) return { captured: false, note: NO_PREVIEW_NOTE };

  const requestId = randomUUID();
  // Address the driver seat when there is one (spec `canvas-agent-seat` §2.2).
  // Before it existed this request carried no target at all, so with several
  // previews open EVERY window forwarded it into its own frame and the first
  // answer won nondeterministically — a screenshot of whichever page happened to
  // rasterize fastest. A window that has claimed nothing still gets the
  // untargeted request, which is what keeps a client that predates the seat
  // working.
  const claim = store.resolveDriver(session);
  const reached = emitToSession(session, {
    type: 'devtools_capture_request',
    requestId,
    ...(claim ? { targetClientId: claim.clientId, documentId: claim.documentId } : {}),
  } as RawSessionEvent);
  if (!reached) {
    return { ...bufferHeader(buffer), captured: false, note: NO_PREVIEW_NOTE };
  }

  const outcome = await store.awaitScreenshot(requestId, timeoutMs);
  if (outcome === undefined) {
    return {
      ...bufferHeader(buffer),
      captured: false,
      note:
        `The preview didn't return a screenshot within ${Math.round(timeoutMs / 1000)}s. ` +
        'The preview tab may be closed or not visible, the client may be disconnected, or ' +
        "the page's Content-Security-Policy may block the rasterizer. Confirm the preview " +
        'is open (browser_navigate) and visible, then try again.',
    };
  }
  if (!outcome.ok) {
    return {
      ...bufferHeader(buffer),
      captured: false,
      note: `The preview could not be rasterized: ${outcome.error}`,
    };
  }

  // Validate the data URL before it becomes an MCP image block. The shim always
  // produces image/png, but the value crossed the untrusted preview: a hostile
  // page may only ever LIE to the agent (a wrong picture), never break its turn
  // with an API-rejected image block — so the mime is whitelisted (never
  // svg+xml: scriptable), the payload must be plausible base64, and the decoded
  // bytes must carry the claimed type's magic bytes.
  const image = parseScreenshotDataUrl(outcome.screenshot.dataUrl);
  if (!image) {
    return {
      ...bufferHeader(buffer),
      captured: false,
      note: 'The preview returned malformed screenshot data. Try again.',
    };
  }
  return new CapabilityImageResult(image, {
    documentUrl: buffer.logicalUrl,
    capturedAt: outcome.screenshot.capturedAt,
  });
}

/** What `browser_read_console` tells the model it does. */
export const READ_CONSOLE_DESCRIPTION =
  "Read the console output your session's live preview captured — `console.*` lines plus " +
  'uncaught errors and unhandled promise rejections, with stack traces. Use it after ' +
  'browser_navigate opens a local preview to check your own work: read the errors, fix them, ' +
  're-read to confirm a clean console. Filter by `level` and cap with `limit`; oversized ' +
  'entries are elided with an explicit marker. Returns a note when no preview is open or the ' +
  'page cannot be instrumented.';

/** What `browser_read_network` tells the model it does. */
export const READ_NETWORK_DESCRIPTION =
  "Read the network requests your session's live preview captured — each `fetch`/XHR call's " +
  'method, URL, status, timing, and response size. Use it after browser_navigate to catch a ' +
  '404 on a missing asset or a failing API call. Filter by `status` — "failed" means network ' +
  'errors (status 0) plus 4xx/5xx responses; redirects are not failures — and cap with ' +
  '`limit`. Returns a note when no preview is open or the page cannot be instrumented.';

/** What `browser_screenshot` tells the model it does. */
export const SCREENSHOT_DESCRIPTION =
  "Capture a screenshot of your session's live preview as it is rendered right now. Use it " +
  'after browser_navigate to eyeball layout, styling, or a blank-screen failure your console ' +
  'read cannot explain. The image is scaled to at most 1568px on its long edge. Works on ' +
  'local previews the workbench serves or proxies; returns a note when no preview is open, ' +
  'the page cannot be instrumented, or the capture times out.';
